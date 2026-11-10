"""Run rules: what blocks Send and Start (safety rules 3 and 4); run tracking from live status."""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import Run, RunStatus, User
from app.services.approval import approval_problem
from app.services.audit_log import AuditLogger, AuditResult
from app.services.bridge_hub import BridgeHub
from app.services.feature_tables import feature_table_problem
from app.services.run_control import REMOTE_OFF_MESSAGE, ProgramRef, permission_problem

# Fixed safety checklist. Must all be ticked for THIS run (a new run starts with none ticked).
CHECKLIST: list[tuple[str, str]] = [
    ("raw_material", "Correct raw material loaded"),
    ("tools_offsets", "Tools and offsets match the program"),
    ("chuck_clamped", "Chuck clamped"),
    ("door_closed", "Door closed"),
    ("no_alarm", "No alarm on machine"),
    ("operator_present", "Operator at machine"),
]
CHECKLIST_KEYS = {k for k, _ in CHECKLIST}


def checklist_missing(run: Run) -> list[str]:
    ticks = run.checklist or {}
    return [label for key, label in CHECKLIST if not (ticks.get(key) or {}).get("ticked")]


def program_ref(run: Run) -> ProgramRef:
    p = run.program
    return ProgramRef(id=p.id, number=p.program_number, sha256=p.sha256, text=p.text)


def _common_blockers(
    db: Session, hub: BridgeHub, run: Run
) -> tuple[list[str], dict[str, Any] | None]:
    out: list[str] = []
    missing = checklist_missing(run)
    if missing:
        out.append("Tick every safety checklist item: " + ", ".join(missing) + ".")
    if run.program.sha256 != run.program_hash:
        out.append("The program changed after this run was created. Start a new run.")
    if problem := approval_problem(db, run.program, run.machine):
        out.append(problem)
    if problem := feature_table_problem(db, run.part_number):
        out.append(problem)
    status = hub.fresh_status(run.machine.key, run.machine.bridge_id)
    if status is None:
        view = hub.live_view(run.machine.key, run.machine.bridge_id)
        out.append(
            f"Machine status is not live ({view['state'].replace('_', ' ')}). "
            "Nothing can be sent or started."
        )
        return out, None
    if status.get("emergency"):
        out.append("Emergency stop is pressed on the machine.")
    if status.get("alarm"):
        codes = ", ".join(f"{a['code']} {a['message']}" for a in status.get("alarms", []))
        out.append(f"The machine has an alarm ({codes or 'see machine'}).")
    if status.get("run_state") != "idle":
        out.append(f"The machine is not idle ({status.get('run_state')}).")
    return out, status


def send_blockers(db: Session, hub: BridgeHub, run: Run, user: User) -> list[str]:
    if run.status not in (RunStatus.CHECKLIST.value, RunStatus.SEND_FAILED.value):
        return [f"The program was already sent for this run (status: {run.status})."]
    out: list[str] = []
    if problem := permission_problem(user, "send_program"):
        out.append(problem)
    blockers, _ = _common_blockers(db, hub, run)
    return out + blockers


def start_blockers(db: Session, hub: BridgeHub, run: Run, user: User) -> list[str]:
    """Safety rule 4. Every condition is listed so the operator sees why Start is locked."""
    if run.status != RunStatus.SENT.value:
        if run.status in (RunStatus.CHECKLIST.value, RunStatus.SEND_FAILED.value):
            return ["Send the program first."]
        return [f"This run cannot be started (status: {run.status})."]
    out: list[str] = []
    if problem := permission_problem(user, "start"):
        out.append(problem)
    blockers, status = _common_blockers(db, hub, run)
    out += blockers
    if status is not None:
        view = hub.live_view(run.machine.key, run.machine.bridge_id)
        number = run.program.program_number
        if status.get("program_number") != number or view.get("loaded_program") != number:
            out.append(f"The approved program O{number:04d} is not the one loaded on the machine.")
    if not run.machine.remote_control_enabled:
        out.append(REMOTE_OFF_MESSAGE)
    return out


def refresh_from_live(hub: BridgeHub, run: Run, audit: AuditLogger) -> bool:
    """Advance SENT -> RUNNING -> COMPLETED from live machine status. Returns True if changed."""
    if run.status not in (RunStatus.SENT.value, RunStatus.RUNNING.value):
        return False
    # Only trust status received after the program was sent / the start was sent.
    since = run.started_at if run.status == RunStatus.RUNNING.value else run.sent_at
    status = hub.fresh_status(run.machine.key, run.machine.bridge_id, after=since)
    if status is None or status.get("program_number") != run.program.program_number:
        return False
    now = datetime.now(UTC)
    parts = status.get("part_count")
    finished = (
        parts is not None and run.part_count_at_send is not None and parts > run.part_count_at_send
    )

    def log(action: str, **payload: Any) -> None:
        audit.record(
            action,
            AuditResult.OK,
            machine_id=run.machine_id,
            program_id=run.program_id,
            program_hash=run.program_hash,
            payload={"run_id": run.id, **payload},
        )

    moving = status.get("run_state") in ("running", "feed_hold", "stopped")
    if run.status == RunStatus.SENT.value and (moving or finished):
        run.status = RunStatus.RUNNING.value
        run.started_at = now
        run.start_mode = run.start_mode or "at_machine"
        log("run_started", start_mode=run.start_mode)
    if run.status == RunStatus.RUNNING.value:
        if finished:
            run.status = RunStatus.COMPLETED.value
            run.finished_at = now
            log("run_completed", part_count=parts)
        elif status.get("run_state") == "idle":
            run.status = RunStatus.COMPLETED.value
            run.finished_at = now
            run.status_note = "Machine returned to idle without finishing the program (reset?)."
            log("run_completed", part_count=parts, note=run.status_note)
    return True
