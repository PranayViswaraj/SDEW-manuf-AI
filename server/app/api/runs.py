"""Run screen API (Milestone 11). Every machine action goes through run_control."""

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import any_user, get_audit, require_roles
from app.config import Settings
from app.db.models import (
    ACTIVE_RUN_STATUSES,
    Machine,
    Material,
    Program,
    Role,
    Run,
    RunStatus,
    User,
)
from app.db.session import get_db
from app.services.approval import approval_problem
from app.services.audit_log import AuditLogger, AuditResult
from app.services.bridge_hub import BridgeHub
from app.services.feature_tables import inspection_plan, required_material
from app.services.run_control import ActionResult, execute_machine_action
from app.services.run_service import (
    CHECKLIST,
    CHECKLIST_KEYS,
    program_ref,
    refresh_from_live,
    send_blockers,
    start_blockers,
)

router = APIRouter(prefix="/runs", tags=["runs"])
operators = require_roles(Role.OPERATOR)


class RunCreate(BaseModel):
    machine_id: int
    program_id: int


class ChecklistTick(BaseModel):
    item: str
    ticked: bool


class MaterialChoice(BaseModel):
    material_id: int | None = None
    material_note: str = Field(default="", max_length=256)


class Measurement(BaseModel):
    feature: str = Field(min_length=1, max_length=128)
    nominal: str = Field(default="", max_length=32)
    measured: str = Field(min_length=1, max_length=32)


class FirstPiece(BaseModel):
    result: Literal["pass", "fail"]
    measurements: list[Measurement] = Field(default_factory=list, max_length=100)
    notes: str = Field(default="", max_length=4000)


def _hub(request: Request) -> BridgeHub:
    hub: BridgeHub = request.app.state.hub
    return hub


def _settings(request: Request) -> Settings:
    s: Settings = request.app.state.settings
    return s


def _get(db: Session, run_id: int) -> Run:
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Run not found.")
    return run


def _material_out(db: Session, run: Run) -> dict[str, Any] | None:
    if run.material_id is None:
        return None
    m = db.get(Material, run.material_id)
    if m is None:
        return None
    return {"id": m.id, "grade": m.grade, "bar_diameter": m.bar_diameter, "notes": m.notes}


def _out(db: Session, hub: BridgeHub, run: Run, user: User) -> dict[str, Any]:
    p = run.program
    ticks = run.checklist or {}
    return {
        "id": run.id,
        "status": run.status,
        "status_note": run.status_note,
        "machine": {
            "id": run.machine.id,
            "name": run.machine.name,
            "remote_control_enabled": run.machine.remote_control_enabled,
        },
        "program": {
            "id": p.id,
            "name": f"O{p.program_number:04d}",
            "title": p.title,
            "version": p.version,
            "status": p.status,
            "proven": p.proven,
        },
        "program_hash": run.program_hash,
        "part_number": run.part_number,
        "required_material": required_material(db, run.part_number),
        "material": _material_out(db, run),
        "material_note": run.material_note,
        "checklist": [
            {
                "key": key,
                "label": label,
                "ticked": bool((ticks.get(key) or {}).get("ticked")),
                "by": (ticks.get(key) or {}).get("by"),
                "at": (ticks.get(key) or {}).get("at"),
            }
            for key, label in CHECKLIST
        ],
        "created_at": run.created_at,
        "sent_at": run.sent_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "start_mode": run.start_mode,
        "first_piece": {
            "result": run.first_piece_result,
            "measurements": run.first_piece_measurements,
            "notes": run.first_piece_notes,
            "at": run.first_piece_at,
        },
        "inspection_plan": inspection_plan(db, run.part_number),
        "live": {
            **hub.live_view(run.machine.key, run.machine.bridge_id),
            "machine_id": run.machine.id,
            "bridge_id": run.machine.bridge_id,
            "remote_control_enabled": run.machine.remote_control_enabled,
            "stale_after_s": hub.stale_after_s,
        },
        "send_blockers": send_blockers(db, hub, run, user),
        "start_blockers": start_blockers(db, hub, run, user),
    }


def _audit(audit: AuditLogger, action: str, user: User, run: Run, **payload: Any) -> None:
    audit.record(
        action,
        AuditResult.OK,
        user=user,
        machine_id=run.machine_id,
        program_id=run.program_id,
        program_hash=run.program_hash,
        payload={"run_id": run.id, **payload},
    )


def _editable(run: Run) -> None:
    if run.status not in (
        RunStatus.CHECKLIST.value,
        RunStatus.SEND_FAILED.value,
        RunStatus.SENT.value,
    ):
        raise HTTPException(409, f"This run can no longer be changed (status: {run.status}).")


# ---------------------------------------------------------------- read


@router.get("")
def list_runs(
    request: Request,
    machine_id: int | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
    _: User = Depends(any_user),
) -> list[dict[str, Any]]:
    stmt = select(Run).order_by(Run.id.desc()).limit(min(max(limit, 1), 200))
    if machine_id is not None:
        stmt = stmt.where(Run.machine_id == machine_id)
    rows = list(db.scalars(stmt))
    user_ids = {r.operator_id for r in rows} | {r.first_piece_by for r in rows}
    names = {
        u.id: (u.full_name or u.username)
        for u in db.scalars(select(User).where(User.id.in_([i for i in user_ids if i])))
    }
    return [
        {
            "id": r.id,
            "status": r.status,
            "operator": names.get(r.operator_id or 0),
            "sent_at": r.sent_at,
            "started_at": r.started_at,
            "finished_at": r.finished_at,
            "start_mode": r.start_mode,
            "first_piece_by": names.get(r.first_piece_by or 0),
            "first_piece_at": r.first_piece_at,
            "machine_name": r.machine.name,
            "program_name": f"O{r.program.program_number:04d}",
            "program_version": r.program.version,
            "part_number": r.part_number,
            "created_at": r.created_at,
            "first_piece_result": r.first_piece_result,
        }
        for r in rows
    ]


@router.get("/{run_id}")
def get_run(
    run_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(any_user),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    run = _get(db, run_id)
    hub = _hub(request)
    if refresh_from_live(hub, run, audit):
        db.commit()
    return _out(db, hub, run, user)


# ---------------------------------------------------------------- set-up


@router.post("", status_code=status.HTTP_201_CREATED)
def create_run(
    body: RunCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(operators),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    machine = db.get(Machine, body.machine_id)
    program = db.get(Program, body.program_id)
    if machine is None or program is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine or program not found.")
    if problem := approval_problem(db, program, machine):
        raise HTTPException(409, f"Choose an approved program: {problem}")
    active = db.scalar(
        select(Run).where(Run.machine_id == machine.id, Run.status.in_(ACTIVE_RUN_STATUSES))
    )
    if active is not None:
        raise HTTPException(
            409, f"Run #{active.id} is still open on {machine.name}. Finish or abort it."
        )
    run = Run(
        machine_id=machine.id,
        program_id=program.id,
        program_hash=program.sha256,
        part_number=program.part_number,
        operator_id=user.id,
        checklist={},
    )
    db.add(run)
    db.commit()
    _audit(audit, "run_create", user, run, program=f"O{program.program_number:04d}")
    return _out(db, _hub(request), run, user)


@router.put("/{run_id}/checklist")
def tick(
    run_id: int,
    body: ChecklistTick,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(operators),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    run = _get(db, run_id)
    _editable(run)
    if body.item not in CHECKLIST_KEYS:
        raise HTTPException(422, f"Unknown checklist item '{body.item}'.")
    ticks = dict(run.checklist or {})
    ticks[body.item] = {
        "ticked": body.ticked,
        "by": user.username,
        "at": datetime.now(UTC).isoformat(),
    }
    run.checklist = ticks
    db.commit()
    _audit(audit, "checklist_tick", user, run, item=body.item, ticked=body.ticked)
    return _out(db, _hub(request), run, user)


@router.put("/{run_id}/material")
def set_material(
    run_id: int,
    body: MaterialChoice,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(operators),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    run = _get(db, run_id)
    _editable(run)
    if body.material_id is not None and db.get(Material, body.material_id) is None:
        raise HTTPException(404, "Material not found in the register.")
    run.material_id = body.material_id
    run.material_note = body.material_note
    db.commit()
    _audit(audit, "run_material", user, run, material_id=body.material_id, note=body.material_note)
    return _out(db, _hub(request), run, user)


@router.post("/{run_id}/abort")
def abort(
    run_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(operators),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    run = _get(db, run_id)
    if run.status not in ACTIVE_RUN_STATUSES:
        raise HTTPException(409, f"Run is already {run.status}.")
    run.status = RunStatus.ABORTED.value
    run.status_note = f"Aborted in ManufAI by {user.username}. No machine action was taken."
    db.commit()
    _audit(audit, "run_abort", user, run)
    return _out(db, _hub(request), run, user)


# ---------------------------------------------------------------- machine actions


async def _act(
    request: Request,
    db: Session,
    user: User,
    audit: AuditLogger,
    run: Run,
    action: str,
    blockers: list[str] | None,
) -> ActionResult:
    hub = _hub(request)
    gates = [lambda: blockers[0] if blockers else None] if blockers is not None else []
    return await execute_machine_action(
        hub=hub,
        audit=audit,
        settings=_settings(request),
        user=user,
        machine=run.machine,
        action=action,
        program=program_ref(run) if action in ("send_program", "start") else None,
        gates=gates,
        payload={"run_id": run.id},
    )


def _result(
    db: Session, request: Request, run: Run, user: User, res: ActionResult
) -> dict[str, Any]:
    return {
        "action": {"action": res.action, "result": res.result, "error": res.error},
        "run": _out(db, _hub(request), run, user),
    }


@router.post("/{run_id}/send")
async def send(
    run_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(operators),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    run = _get(db, run_id)
    hub = _hub(request)
    status_before = hub.fresh_status(run.machine.key, run.machine.bridge_id) or {}
    res = await _act(
        request, db, user, audit, run, "send_program", send_blockers(db, hub, run, user)
    )
    if res.ok:
        run.status = RunStatus.SENT.value
        run.sent_at = datetime.now(UTC)
        run.part_count_at_send = status_before.get("part_count")
        run.status_note = ""
    elif res.result == "failed":
        run.status = RunStatus.SEND_FAILED.value
        run.status_note = res.error or "Send failed."
    db.commit()
    return _result(db, request, run, user, res)


@router.post("/{run_id}/start")
async def start(
    run_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(operators),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    run = _get(db, run_id)
    res = await _act(
        request, db, user, audit, run, "start", start_blockers(db, _hub(request), run, user)
    )
    if res.ok:
        run.status = RunStatus.RUNNING.value
        run.started_at = datetime.now(UTC)
        run.start_mode = "remote"
        db.commit()
    return _result(db, request, run, user, res)


@router.post("/{run_id}/feed-hold")
async def feed_hold(
    run_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(operators),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    run = _get(db, run_id)
    res = await _act(request, db, user, audit, run, "feed_hold", None)
    return _result(db, request, run, user, res)


@router.post("/{run_id}/stop")
async def stop(
    run_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(operators),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    run = _get(db, run_id)
    res = await _act(request, db, user, audit, run, "stop", None)
    return _result(db, request, run, user, res)


# ---------------------------------------------------------------- first piece


@router.post("/{run_id}/first-piece")
def first_piece(
    run_id: int,
    body: FirstPiece,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(operators),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    run = _get(db, run_id)
    refresh_from_live(_hub(request), run, audit)
    if run.status != RunStatus.COMPLETED.value:
        raise HTTPException(409, "Record the first piece after the machine has finished the run.")
    now = datetime.now(UTC)
    run.first_piece_result = body.result
    run.first_piece_measurements = [m.model_dump() for m in body.measurements]
    run.first_piece_notes = body.notes
    run.first_piece_by = user.id
    run.first_piece_at = now
    run.status = RunStatus.CLOSED.value
    program = run.program
    if body.result == "pass" and program.sha256 == run.program_hash:
        program.proven = True
        program.proven_at = now
        program.proven_note = (
            f"First piece passed on run #{run.id} ({run.machine.name}), recorded by "
            f"{user.full_name or user.username}."
        )
    db.commit()
    _audit(
        audit,
        "first_piece_result",
        user,
        run,
        result=body.result,
        measurements=len(body.measurements),
    )
    if body.result == "pass":
        _audit(audit, "program_proven", user, run, part_number=run.part_number)
    return _out(db, _hub(request), run, user)
