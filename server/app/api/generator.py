"""Drawing-to-program: plan the setup, preview and save a generated program (step 6).

The program comes from fixed code (app.gcode.generator), never AI. Setup values are offered from
the last setup saved for the machine or from the company's proven programs, always with their
source; nothing is invented. A saved program is a DRAFT that a programmer must approve.
"""

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.known_drawings import KnownDrawing, find_known, load_known
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
    Fallback,
    ToolInfo,
    drawing_profile,
    generate,
    read_geometry,
)
from app.gcode.proven_data import (
    PartContext,
    ProvenData,
    _words,
    clearance,
    company_face_stock,
    part_context,
    proven_data,
    spindle_direction,
)
from app.services.approval import controller_problem
from app.services.audit_log import AuditLogger, AuditResult
from app.services.feature_tables import data_hash, feature_table_problem
from app.services.program_library import load_library, match_part
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


def _known_list(request: Request) -> list[KnownDrawing]:
    return load_known(Path(_library_dir(request)).parent / "drawings" / "known_drawings.json")


def _part_ctx(request: Request, part_number: str) -> PartContext | None:
    """The proven program made for this very part (also under its other part numbers)."""
    lib = load_library(_library_dir(request))
    names = [part_number]
    if k := find_known(_known_list(request), part_number=part_number):
        names += [k.part_number, *k.aliases]
    for name in names:
        if match := match_part(lib, name):
            # Values come from the most complete program for the part (3227C07701: the full
            # O0003 file, not its N4-N8 extract that is offered to run).
            best = max(match, key=lambda p: len(p.text))
            return part_context(best.name, best.text)
    return None


def _groove_edge(ctx: PartContext, data: dict[str, Any]) -> dict[str, Any] | None:
    """Which insert edge the groove Z is set on, from the proven program and the drawing's
    groove position: the first plunge Z must line up with the groove's front wall."""
    grooves = [f for f in data.get("features", []) if f.get("type") == "groove"]
    pos = grooves[0]["fields"].get("position", {}).get("value") if grooves else None
    block = next((b for b in ctx.blocks if b.kind == "groove"), None)
    width = ctx.suggest(("groove",), "width")
    if not isinstance(pos, int | float) or block is None or width is None:
        return None
    lines = block.lines
    z = None
    for i, (_, t) in enumerate(lines):
        w = _words(t)
        nxt = lines[i + 1][1] if i + 1 < len(lines) else ""
        if "Z" in w and "X" not in w and nxt.startswith("G1") and "X" in _words(nxt):
            z = abs(w["Z"])
            break
    if z is None:
        return None
    wd = float(width["value"])
    for edge, wall in (("left", z - wd), ("right", z)):
        if abs(wall - pos) <= 0.3:
            return {
                "value": edge,
                "source": "proven program for this part",
                "note": (
                    f"{ctx.program} plunges at Z-{z:g} with a {wd:g} mm insert; the drawing's "
                    f"groove starts at {pos:g}, which fits the {edge} edge"
                ),
            }
    return None


def _company_edge(request: Request, op: str) -> dict[str, Any] | None:
    """The same tool-edge convention, worked out from another part's proven program."""
    for k in _known_list(request):
        if k.not_lathe:
            continue
        ctx = _part_ctx(request, k.part_number)
        if ctx is None:
            continue
        data = k.table_data()
        found = (
            _ref_edge(ctx, k.header.get("overall_length"))
            if op == "part"
            else _groove_edge(ctx, data)
        )
        if found:
            return found | {
                "source": "proven program",
                "note": "same edge as your other parts: " + found["note"],
            }
    return None


def _tools(machine: Machine, ctx: PartContext | None = None) -> list[ToolInfo]:
    """The machine's tool list; while it is empty, the tools the part's proven program uses."""
    if machine.tools or ctx is None:
        return [
            ToolInfo(t.tool_code, t.tool_type, t.description, t.nose_radius) for t in machine.tools
        ]
    return [
        ToolInfo(t["tool_code"], t["tool_type"], t["description"], t["nose_radius"])
        for t in ctx.tools
    ]


def _fallback(ctx: PartContext | None) -> Fallback | None:
    if ctx is None:
        return None
    return Fallback(
        program=ctx.program,
        drill=ctx.drill,
        drill_source=ctx.drill_source,
        approach_x=ctx.approach_x,
        approach_source=ctx.approach_source,
        part_off_end_x=ctx.part_off_end_x,
        hole_x=ctx.face_end_x,
        max_turn_z=ctx.max_turn_z if not ctx.part_off else None,
        max_turn_source=ctx.max_turn_source,
    )


def _part_off_fit(ctx: PartContext, length: Any) -> tuple[str, float, str] | None:
    """(blade edge, stock left for facing the back, note) from the proven part-off:
    part-off Z, blade width and the drawing length must agree (op 2 faces at most 1 mm)."""
    if not isinstance(length, int | float):
        return None
    part = next((b for b in ctx.blocks if b.kind == "parting"), None)
    width = ctx.suggest(("parting",), "width")
    if part is None or width is None:
        return None
    z = next(
        (abs(_words(t)["Z"]) for _, t in part.lines if t.startswith("G1") and "Z" in _words(t)),
        None,
    )
    if z is None:
        return None
    w = float(width["value"])
    for edge, extra in (("left", z - w - length), ("right", z - length)):
        if 0 <= extra <= 1.0:
            extra = round(extra, 3)
            return (
                edge,
                extra,
                f"{ctx.program} parts off at Z-{z:g} with a {w:g} mm blade; with length "
                f"{length:g} that only fits the {edge} edge ({extra:g} mm left for facing)",
            )
    return None


def _ref_edge(ctx: PartContext, length: Any) -> dict[str, Any] | None:
    fit = _part_off_fit(ctx, length)
    if fit is None:
        return None
    return {"value": fit[0], "source": "proven program for this part", "note": fit[2]}


def _back_stock(ctx: PartContext, length: Any) -> dict[str, Any] | None:
    """Stock on the back face: what the proven part-off leaves, else what its 2nd side faces."""
    src = "proven program for this part"
    if ctx.part_off:
        fit = _part_off_fit(ctx, length)
        return {"value": fit[1], "source": src, "note": fit[2]} if fit else None
    if ctx.back_face_stock is not None:
        return {"value": ctx.back_face_stock, "source": src, "note": ctx.back_face_source}
    return None


def _company_back_stock(request: Request) -> dict[str, Any] | None:
    """The largest back-face stock any proven program leaves (never too deep a cut)."""
    best: tuple[float, str] | None = None
    for k in _known_list(request):
        ctx = None if k.not_lathe else _part_ctx(request, k.part_number)
        found = _back_stock(ctx, k.header.get("overall_length")) if ctx else None
        if found and (best is None or found["value"] > best[0]):
            best = (float(found["value"]), found["note"])
    if best is None:
        return None
    return {"value": best[0], "source": "proven program", "note": best[1] + " (largest)"}


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
    ctx = _part_ctx(request, ft.part_number)
    geo, problems = read_geometry(ft.data, _fallback(ctx))
    needed = set(geo.needed_ops(None)) if geo else {"general", "rough"}
    proven = _proven(request)
    tool_pool = _tools(machine, ctx)
    tools_from_ctx = not machine.tools and ctx is not None
    length = ft.data.get("header", {}).get("overall_length", {}).get("value")
    lib_face_stock = company_face_stock(
        [(x.name, x.text) for x in load_library(_library_dir(request))]
    )
    defaults: dict[str, Any] = machine.generator_defaults or {}
    mine: dict[str, Any] = (defaults.get("parts") or {}).get(ft.part_number) or {}
    # another part's setup on this machine: only general cutting values carry over
    saved: dict[str, Any] = {} if ctx is not None and not machine.tools else defaults
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
                        "proven program for this part" if tools_from_ctx else "machine tool list"
                    ),
                    "note": f"{tools[0]['tool_code']} {tools[0]['description']}".strip()
                    + (
                        f" in {ctx.program} (machine tool list is empty)"
                        if tools_from_ctx and ctx
                        else ""
                    ),
                }
        params = []
        for prm in spec.params:
            sug: dict[str, Any] | None = None
            part_fact = (spec.key, prm.key) in PART_FACTS
            if own.get(prm.key) not in (None, ""):
                sug = {"value": own[prm.key], "source": "last saved", "note": mine_note}
            elif ctx and (
                from_part := _from_part(ctx, spec.key, prm.key, spec.proven_kinds, length, ft.data)
            ):
                sug = from_part
            elif not part_fact and last.get(prm.key) not in (None, ""):
                sug = {"value": last[prm.key], "source": "last saved", "note": saved_note}
            elif prm.key == "ref_edge" and (edge := _company_edge(request, spec.key)):
                sug = edge
            elif spec.key == "rough" and prm.key == "face_stock" and (fs := lib_face_stock):
                sug = fs
            elif spec.key == "back" and (bs := _company_back_stock(request)):
                sug = bs
            elif spec.key == "general" and (found := proven_general.get(prm.key)):
                sug = {"value": found.value, "source": "proven program", "note": found.source}
            elif spec.proven_kinds:
                sug = proven.suggest(spec.proven_kinds, prm.key)
                # boring with G71 uses the company's G71 roughing values when no boring bar has them
                if sug is None and spec.key == "bore" and prm.key in BORE_FROM_ROUGH:
                    sug = proven.suggest(("od_rough",), prm.key)
                if sug is None and spec.key == "bore" and prm.key == "feed":
                    sug = (
                        ctx.suggest(("bore",), "finish_feed") if ctx else None
                    ) or proven.suggest(("bore",), "finish_feed")
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


BORE_FROM_ROUGH = {"depth_of_cut", "retract", "finish_allow_x", "finish_allow_z"}
# Facts about one part, never carried over from another part's saved setup.
PART_FACTS = {
    ("general", "part_off"),
    ("rough", "face_stock"),
    ("back", "face_stock"),
    ("part", "ref_edge"),
    ("groove", "ref_edge"),
}


def _from_part(
    ctx: PartContext,
    op: str,
    key: str,
    kinds: tuple[str, ...],
    length: Any,
    data: dict[str, Any],
) -> dict[str, Any] | None:
    """A value from the proven program of this part, if it holds one."""
    src = "proven program for this part"
    if op == "general" and key in ("clearance", "spindle_direction"):
        found = (clearance if key == "clearance" else spindle_direction)(ctx.blocks)
        return {"value": found.value, "source": src, "note": found.source} if found else None
    if op == "general" and key == "part_off":
        return {
            "value": "yes" if ctx.part_off else "no",
            "source": src,
            "note": ctx.part_source or f"{ctx.program} has no part-off",
        }
    if op == "rough" and key == "face_stock" and ctx.face_stock is not None:
        return {"value": ctx.face_stock, "source": src, "note": ctx.face_source}
    if op == "back" and key == "face_stock":
        return _back_stock(ctx, length)
    if op == "part" and key == "ref_edge":
        return _ref_edge(ctx, length)
    if op == "groove" and key == "ref_edge":
        return _groove_edge(ctx, data)
    return ctx.suggest(kinds, key) if kinds else None


def _run(db: Session, body: GenerateBody, request: Request) -> tuple[FeatureTable, Machine, Any]:
    ft, machine = _load(db, body.feature_table_id, body.machine_id)
    ctx = _part_ctx(request, ft.part_number)
    result = generate(
        ft.data,
        program_number=body.program_number,
        part_number=ft.part_number,
        title=body.title,
        setup=body.setup,
        tools=_tools(machine, ctx),
        rpm_max=_rpm_max(machine),
        table_ref=data_hash(ft.data)[:12],
        fallback=_fallback(ctx),
    )
    if result.text is not None and not machine.tools and ctx is not None:
        result.notes.append(
            f"Tool numbers are the ones {ctx.program} uses ({machine.name} has no tool list yet): "
            "check the turret matches before running."
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
        geo, _problems = read_geometry(ft.data, _fallback(_part_ctx(request, ft.part_number)))
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


class UseBody(BaseModel):
    machine_id: int
    part_number: str = Field(min_length=1, max_length=64)


@router.get("/library")
def library(
    request: Request,
    part_number: str | None = Query(default=None, max_length=64),
    _: User = Depends(any_user),
) -> list[dict[str, Any]]:
    """The company's proven programs; with part_number, only those made for that part."""
    lib = load_library(_library_dir(request))
    if part_number:
        lib = match_part(lib, part_number)
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


@router.post("/library/{name}/use", status_code=201)
def use_library_program(
    name: str,
    body: UseBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(programmers),
    audit: AuditLogger = Depends(get_audit),
) -> dict[str, Any]:
    """Copy a proven program, byte for byte, to a machine as a DRAFT (approve it next)."""
    prog = next((p for p in load_library(_library_dir(request)) if p.name == name), None)
    machine = db.get(Machine, body.machine_id)
    if prog is None or machine is None:
        raise HTTPException(404, "Program or machine not found.")
    if problem := controller_problem(machine):
        raise HTTPException(409, problem)
    part = body.part_number.strip()
    if not match_part([prog], part):
        raise HTTPException(422, f"{prog.name} is not made for part {part}.")
    existing = db.scalar(
        select(Program).where(
            Program.machine_id == machine.id,
            Program.part_number == part,
            Program.sha256 == prog.sha256,
            Program.status != ProgramStatus.RETIRED.value,
        )
    )
    if existing is not None:
        return {"program_id": existing.id, "name": prog.name, "version": existing.version}
    try:
        p = create_version(
            db,
            machine=machine,
            text=prog.text,
            source=ProgramSource.TRUSTED_IMPORT,
            user=user,
            part_number=part,
            source_note=(
                f"company library {prog.name} (SHA-256 {prog.sha256[:12]}), proven on a company "
                f"machine (which one is not recorded); copied to {machine.name} by {user.username}"
            )[:256],
        )
    except ProgramError as e:
        db.rollback()
        raise HTTPException(422, str(e)) from e
    db.commit()
    audit.record(
        "program_from_library",
        AuditResult.OK,
        user=user,
        machine_id=machine.id,
        program_id=p.id,
        program_hash=p.sha256,
        payload={"program": prog.name, "part_number": part, "library_sha256": prog.sha256},
    )
    return {"program_id": p.id, "name": prog.name, "version": p.version}
