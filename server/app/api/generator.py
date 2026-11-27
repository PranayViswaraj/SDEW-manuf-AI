"""Drawing-to-program: plan the setup, preview and save a generated program (step 6).

The program comes from fixed code (app.gcode.generator), never AI. The part itself comes only from
its feature table (read from the drawing by the AI reader): no stored program or recorded drawing
for the part is looked up. Cutting values are offered from the last setup saved for the machine,
company-wide reference values mined from the proven programs, or standard shop values, always with
their source. A saved program is a DRAFT that a programmer must approve.
"""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import any_user, get_audit, require_roles
from app.db.models import (
    FeatureTable,
    Machine,
    Program,
    ProgramSource,
    ProgramStatus,
    Role,
    User,
)
from app.db.session import get_db
from app.gcode.backplot import backplot, stock_outline
from app.gcode.generator import (
    OPS,
    ToolInfo,
    drawing_profile,
    generate,
    read_geometry,
)
from app.gcode.proven_data import (
    ProvenData,
    clearance,
    company_face_stock,
    proven_data,
    spindle_direction,
)
from app.services.approval import controller_problem
from app.services.audit_log import AuditLogger, AuditResult
from app.services.feature_tables import data_hash, feature_table_problem
from app.services.program_library import load_library
from app.services.program_store import ProgramError, create_version, validate_for_machine

router = APIRouter(prefix="/generator", tags=["generator"])
programmers = require_roles(Role.PROGRAMMER, Role.ENGINEER)


class GenerateBody(BaseModel):
    feature_table_id: int
    machine_id: int
    program_number: int = Field(ge=1, le=9999)
    title: str = Field(default="", max_length=40)
    setup: dict[str, dict[str, Any]] = Field(default_factory=dict)


def _load(db: Session, table_id: int, machine_id: int) -> tuple[FeatureTable, Machine]:
    ft = db.get(FeatureTable, table_id)
    machine = db.get(Machine, machine_id)
    if ft is None or machine is None:
        raise HTTPException(404, "Feature table or machine not found.")
    return ft, machine


def _library_dir(request: Request) -> str:
    return str(request.app.state.settings.samples_dir)


def _proven(request: Request) -> ProvenData:
    """Values from the company's proven programs (the library; machine not recorded)."""
    return proven_data([(p.name, None, p.text) for p in load_library(_library_dir(request))])


# Used while a machine's tool list is not entered: a common
# 8-station lathe turret, so a program can be written at once. The validator warns that tool
# calls were not checked against the machine; the setter loads or matches these stations.
STANDARD_TURRET: tuple[ToolInfo, ...] = (
    ToolInfo("T0101", "od_rough", "OD rough CNMG 0.8 (standard turret)", 0.8),
    ToolInfo("T0202", "od_finish", "OD finish VNMG 0.4 (standard turret)", 0.4),
    ToolInfo("T0303", "drill", "Drill (standard turret)", None),
    ToolInfo("T0404", "bore", "Boring bar 0.4 (standard turret)", 0.4),
    ToolInfo("T0505", "groove", "Groove 3 mm (standard turret)", None),
    ToolInfo("T0606", "thread", "Thread 60 deg (standard turret)", None),
    ToolInfo("T0707", "parting", "Part-off 3 mm (standard turret)", None),
)


def _tools(machine: Machine) -> list[ToolInfo]:
    """The machine's tool list; while it is empty, a standard turret layout (so nothing is left
    to choose by hand)."""
    if machine.tools:
        return [
            ToolInfo(t.tool_code, t.tool_type, t.description, t.nose_radius) for t in machine.tools
        ]
    return list(STANDARD_TURRET)


def _rpm_max(machine: Machine) -> int | None:
    v = (machine.limits or {}).get("spindle_rpm_max")
    return int(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def _free_number(db: Session, machine: Machine) -> int:
    used = set(db.scalars(select(Program.program_number).where(Program.machine_id == machine.id)))
    return next(n for n in range(1000, 10000) if n not in used)


@router.get("/plan")
def plan(
    request: Request,
    feature_table_id: int = Query(),
    machine_id: int = Query(),
    db: Session = Depends(get_db),
    _: User = Depends(any_user),
) -> dict[str, Any]:
    """Which operations the part needs and a pre-filled setup, each value with its source."""
    ft, machine = _load(db, feature_table_id, machine_id)
    geo, problems = read_geometry(ft.data)
    needed = set(geo.needed_ops(None)) if geo else {"general", "rough"}
    proven = _proven(request)
    tool_pool = _tools(machine)
    standard_turret = not machine.tools
    lib_face_stock = company_face_stock(
        [(x.name, x.text) for x in load_library(_library_dir(request))]
    )
    defaults: dict[str, Any] = machine.generator_defaults or {}
    mine: dict[str, Any] = (defaults.get("parts") or {}).get(ft.part_number) or {}
    # another part's setup on this machine: only general cutting values carry over
    saved: dict[str, Any] = defaults
    saved_note = (
        f"last saved for {machine.name} with {saved.get('_program', '?')} by "
        f"{saved.get('_saved_by', '?')}"
    )
    mine_note = (
        f"last saved for part {ft.part_number} on {machine.name} with "
        f"{mine.get('_program', '?')} by {mine.get('_saved_by', '?')}"
    )
    proven_general = {
        "clearance": clearance(proven.blocks),
        "spindle_direction": spindle_direction(proven.blocks),
    }
    ops_out = []
    for spec in OPS:
        last = saved.get(spec.key, {}) if isinstance(saved.get(spec.key), dict) else {}
        own = mine.get(spec.key, {}) if isinstance(mine.get(spec.key), dict) else {}
        tools = [
            {"tool_code": t.tool_code, "description": t.description, "tool_type": t.tool_type}
            for t in tool_pool
            if t.tool_type in spec.tool_types
        ]
        # prefer the tool kind the op is named after (e.g. a finishing tool for finishing)
        tools.sort(key=lambda t: spec.tool_types.index(t["tool_type"]))
        tool_sug: dict[str, Any] | None = None
        if spec.tool_types:
            if own.get("tool_code") in {t["tool_code"] for t in tools}:
                tool_sug = {"value": own["tool_code"], "source": "last saved", "note": mine_note}
            elif last.get("tool_code") in {t["tool_code"] for t in tools}:
                tool_sug = {"value": last["tool_code"], "source": "last saved", "note": saved_note}
            elif tools:
                tool_sug = {
                    "value": tools[0]["tool_code"],
                    "source": (
                        "standard turret (machine tool list not entered)"
                        if standard_turret
                        else "machine tool list"
                    ),
                    "note": f"{tools[0]['tool_code']} {tools[0]['description']}".strip(),
                }
        params = []
        for prm in spec.params:
            sug: dict[str, Any] | None = None
            part_fact = (spec.key, prm.key) in PART_FACTS
            if own.get(prm.key) not in (None, ""):
                sug = {"value": own[prm.key], "source": "last saved", "note": mine_note}
            elif spec.key == "general" and prm.key == "part_off":
                # every part is made from bar and parted off at the end
                sug = {
                    "value": "yes",
                    "source": "standard",
                    "note": "made from bar, parted off at the end",
                }
            elif not part_fact and last.get(prm.key) not in (None, ""):
                sug = {"value": last[prm.key], "source": "last saved", "note": saved_note}
            elif spec.key == "rough" and prm.key == "face_stock" and (fs := lib_face_stock):
                sug = fs
            elif spec.key == "general" and (found := proven_general.get(prm.key)):
                sug = {"value": found.value, "source": "proven program", "note": found.source}
            elif spec.proven_kinds:
                sug = proven.suggest(spec.proven_kinds, prm.key)
                # boring with G71 uses the company's G71 roughing values when no boring bar has them
                if sug is None and spec.key == "bore" and prm.key in BORE_FROM_ROUGH:
                    sug = proven.suggest(("od_rough",), prm.key)
                if sug is None and spec.key == "bore" and prm.key == "feed":
                    sug = proven.suggest(("bore",), "finish_feed")
            if sug is None and (std := STANDARD_VALUES.get((spec.key, prm.key))) is not None:
                sug = {
                    "value": std,
                    "source": "standard",
                    "note": "common shop value (not found in your programs): check at the machine",
                }
            params.append(
                {
                    "key": prm.key,
                    "label": prm.label,
                    "unit": prm.unit,
                    "kind": prm.kind,
                    "choices": list(prm.choices),
                    "hint": prm.hint,
                    "suggestion": sug,
                }
            )
        ops_out.append(
            {
                "key": spec.key,
                "label": spec.label,
                "tool_types": list(spec.tool_types),
                "needed": spec.key in needed,
                "tools": tools,
                "tool_suggestion": tool_sug,
                "params": params,
            }
        )
    return {
        "feature_table_id": ft.id,
        "part_number": ft.part_number,
        "table_status": ft.status,
        "machine_id": machine.id,
        "machine_name": machine.name,
        "geometry_problems": problems,
        "operations": ops_out,
        "program_number": _free_number(db, machine),
        "proven_programs": proven.programs,
        "controller_problem": controller_problem(machine),
    }


# Last resort, after the last saved setup and the company-wide reference values from the proven
# programs: common shop values for steel on a CNC lathe, so nothing is left to type. Each is
# shown as "standard" in the setup for the setter to check at the machine.
STANDARD_VALUES: dict[tuple[str, str], Any] = {
    ("general", "clearance"): 2.0,
    ("general", "spindle_direction"): "M4",
    ("general", "part_off"): "yes",
    ("drill", "rpm"): 600,
    ("drill", "feed"): 0.08,
    ("drill", "peck"): 3.0,
    ("drill", "retract"): 1.0,
    ("rough", "rpm"): 1200,
    ("rough", "feed"): 0.2,
    ("rough", "depth_of_cut"): 1.0,
    ("rough", "retract"): 0.5,
    ("rough", "finish_allow_x"): 0.3,
    ("rough", "finish_allow_z"): 0.05,
    ("rough", "face_stock"): 1.0,
    ("finish", "rpm"): 1800,
    ("finish", "feed"): 0.08,
    ("bore", "rpm"): 1200,
    ("bore", "feed"): 0.15,
    ("bore", "finish_feed"): 0.08,
    ("bore", "depth_of_cut"): 0.8,
    ("bore", "retract"): 0.5,
    ("bore", "finish_allow_x"): 0.3,
    ("bore", "finish_allow_z"): 0.05,
    ("groove", "rpm"): 800,
    ("groove", "feed"): 0.05,
    ("groove", "width"): 3.0,
    ("groove", "ref_edge"): "left",
    ("thread", "rpm"): 800,
    ("thread", "first_depth"): 0.3,
    ("thread", "min_depth"): 0.05,
    ("thread", "finish_allowance"): 0.05,
    ("thread", "finish_passes"): 1,
    ("back", "face_stock"): 1.0,
    ("part", "rpm"): 800,
    ("part", "feed"): 0.05,
    ("part", "width"): 3.0,
    ("part", "ref_edge"): "left",
}

BORE_FROM_ROUGH = {"depth_of_cut", "retract", "finish_allow_x", "finish_allow_z"}
# Facts about one part, never carried over from another part's saved setup.
PART_FACTS = {
    ("general", "part_off"),
    ("rough", "face_stock"),
    ("back", "face_stock"),
    ("part", "ref_edge"),
    ("groove", "ref_edge"),
}


def _run(db: Session, body: GenerateBody, request: Request) -> tuple[FeatureTable, Machine, Any]:
    ft, machine = _load(db, body.feature_table_id, body.machine_id)
    result = generate(
        ft.data,
        program_number=body.program_number,
        part_number=ft.part_number,
        title=body.title,
        setup=body.setup,
        tools=_tools(machine),
        rpm_max=_rpm_max(machine),
        table_ref=data_hash(ft.data)[:12],
    )
    return ft, machine, result


@router.post("/preview")
def preview(
    body: GenerateBody,
    request: Request,
    db: Session = Depends(get_db),
    _: User = Depends(any_user),
) -> dict[str, Any]:
    """Generate without saving: program text, validation and tool path, or what is missing."""
    ft, machine, res = _run(db, body, request)
    out: dict[str, Any] = {
        "ok": res.text is not None,
        "problems": res.problems,
        "operations": res.operations,
        "text": res.text,
        "validation": None,
        "toolpath": None,
        "drawing": None,
        "table_problem": feature_table_problem(db, ft.part_number),
        "controller_problem": controller_problem(machine),
        "notes": res.notes,
    }
    if res.text is not None:
        out["validation"] = validate_for_machine(res.text, machine).to_dict()
        plot = backplot(res.text)
        bar = ft.data["header"]["bar_diameter"]["value"]
        out["toolpath"] = plot.to_dict(
            stock=stock_outline(float(bar) if isinstance(bar, int | float) else None, plot)
        )
        # Finished shape for the 3D simulation's compare with the drawing (advisory only).
        geo, _problems = read_geometry(ft.data)
        out["drawing"] = drawing_profile(geo) if geo is not None else None
    return out


class CheckBody(BaseModel):
    machine_id: int
    text: str = Field(min_length=1, max_length=200_000)
    bar_diameter: float | None = Field(default=None, gt=0, le=1000)


@router.post("/check")
def check_text(
    body: CheckBody,
    db: Session = Depends(get_db),
    _: User = Depends(programmers),
) -> dict[str, Any]:
    """Validate and draw a program edited on screen, without saving it (saving = new version)."""
    machine = db.get(Machine, body.machine_id)
    if machine is None:
        raise HTTPException(404, "Machine not found.")
    plot = backplot(body.text)
    return {
        "validation": validate_for_machine(body.text, machine).to_dict(),
        "toolpath": plot.to_dict(stock=stock_outline(body.bar_diameter, plot)),
    }


@router.post("/programs", status_code=201)
def save_program(
    body: GenerateBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(programmers),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    """Store the generated program as a DRAFT version (a programmer approves it next)."""
    ft, machine, res = _run(db, body, request)
    if problem := feature_table_problem(db, ft.part_number):
        raise HTTPException(409, problem)
    if problem := controller_problem(machine):
        raise HTTPException(409, problem)
    if res.text is None:
        raise HTTPException(422, "Cannot generate yet: " + " ".join(res.problems[:5]))
    clash = db.scalar(
        select(Program).where(
            Program.machine_id == machine.id,
            Program.program_number == body.program_number,
            Program.part_number != ft.part_number,
            Program.status != ProgramStatus.RETIRED.value,
        )
    )
    if clash is not None:
        raise HTTPException(
            409,
            f"O{body.program_number:04d} is already used for part {clash.part_number} on "
            f"{machine.name}. Choose another program number.",
        )
    try:
        p = create_version(
            db,
            machine=machine,
            text=res.text,
            source=ProgramSource.GENERATOR,
            user=user,
            part_number=ft.part_number,
            source_note=(
                f"generated from feature table {data_hash(ft.data)[:12]} by {user.username}"
            )[:256],
        )
    except ProgramError as e:
        db.rollback()
        raise HTTPException(422, str(e)) from e
    used = {op["key"] for op in res.operations} | {"general", "back"}
    defaults: dict[str, Any] = {k: v for k, v in body.setup.items() if k in used}
    defaults.update(
        {
            "_program": f"O{p.program_number:04d}",
            "_saved_by": user.username,
            "_saved_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
    )
    # kept per part (offered first next time for this part) and as the machine's latest setup
    old = dict(machine.generator_defaults or {})
    parts = dict(old.get("parts") or {})
    parts[ft.part_number] = defaults
    machine.generator_defaults = {**old, **defaults, "parts": parts}
    db.commit()
    audit.record(
        "program_generate",
        AuditResult.OK,
        user=user,
        machine_id=machine.id,
        program_id=p.id,
        program_hash=p.sha256,
        payload={
            "program": f"O{p.program_number:04d}",
            "version": p.version,
            "part_number": ft.part_number,
            "feature_table_hash": data_hash(ft.data),
            "setup": body.setup,
        },
    )
    return {"program_id": p.id, "name": f"O{p.program_number:04d}", "version": p.version}


# ------------------------------------------------------------------ company program library


@router.get("/library")
def library(
    request: Request,
    _: User = Depends(any_user),
) -> list[dict[str, Any]]:
    """The company's proven programs, as reference (code style, cutting values). They are never
    matched to a part: every part's program is generated from its AI-read feature table."""
    lib = load_library(_library_dir(request))
    return [
        {
            "name": p.name,
            "program_number": p.program_number,
            "part_numbers": list(p.part_numbers),
            "title": p.title,
            "sha256": p.sha256,
            "text": p.text,
        }
        for p in lib
    ]


@router.get("/library/{name}/toolpath")
def library_toolpath(
    name: str,
    request: Request,
    _: User = Depends(any_user),
) -> dict[str, Any]:
    """Tool path of a proven program, to compare with a generated one (drawn, never run)."""
    prog = next((p for p in load_library(_library_dir(request)) if p.name == name), None)
    if prog is None:
        raise HTTPException(404, "Program not found.")
    return backplot(prog.text).to_dict()
