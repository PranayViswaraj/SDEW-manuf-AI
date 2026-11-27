"""Part drawings: upload and view next to the feature table (stored byte for byte)."""

import hashlib
import time
import uuid
from collections.abc import Iterator
from datetime import datetime
from typing import Any, Literal
from urllib.parse import quote

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.drawing_reader import (
    AI_MODELS,
    DrawingReaderError,
    ai_reader_enabled,
    get_drawing_reader,
)
from app.auth.deps import any_user, get_audit, require_roles
from app.config import get_settings
from app.db.models import Drawing, FeatureTable, FeatureTableStatus, Role, User
from app.db.session import get_db
from app.services.audit_log import AuditLogger, AuditResult
from app.services.feature_tables import normalise

router = APIRouter(prefix="/drawings", tags=["drawings"])
uploaders = require_roles(Role.ENGINEER, Role.PROGRAMMER)
MAX_BYTES = 25 * 1024 * 1024
CHUNK = 64 * 1024


class DrawingOut(BaseModel):
    id: int
    part_number: str
    filename: str
    content_type: str
    size: int
    sha256: str
    uploaded_by_name: str
    uploaded_at: datetime
    autofill: dict[str, Any] | None = None


def sniff(content: bytes) -> str | None:
    """Content type from the file's own bytes (never trust the browser's label)."""
    if content.startswith(b"%PDF-"):
        return "application/pdf"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return None


def _out(d: Drawing) -> DrawingOut:
    return DrawingOut(
        id=d.id,
        part_number=d.part_number,
        filename=d.filename,
        content_type=d.content_type,
        size=d.size,
        sha256=d.sha256,
        uploaded_by_name=d.uploaded_by_name,
        uploaded_at=d.uploaded_at,
    )


@router.get("", response_model=list[DrawingOut])
def list_drawings(
    part_number: str | None = Query(default=None, max_length=64),
    db: Session = Depends(get_db),
    _: User = Depends(any_user),
) -> list[DrawingOut]:
    stmt = select(Drawing).order_by(Drawing.uploaded_at.desc(), Drawing.id.desc())
    if part_number:
        stmt = stmt.where(Drawing.part_number == part_number.strip())
    return [_out(d) for d in db.scalars(stmt.limit(200))]


def _norm(text: str) -> str:
    return "".join(ch for ch in text.upper() if ch.isalnum())


def _other_part_in_name(db: Session, filename: str, part: str) -> str | None:
    """Another part of this app named in the file name: the file was most likely picked by
    mistake. Only parts already created here count (nothing is looked up in stored data)."""
    name = _norm(filename)
    if not name or _norm(part) in name:
        return None
    others = set(db.scalars(select(FeatureTable.part_number)))
    for other in sorted(others, key=len, reverse=True):
        if len(_norm(other)) >= 6 and _norm(other) in name and _norm(other) != _norm(part):
            return other
    return None


# Common round bar sizes (mm) stocked for turning.
STOCK_BARS = (
    6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 30, 32, 35, 36, 38, 40, 42, 45, 48, 50, 55, 60,
    65, 70, 75, 80, 85, 90, 95, 100, 110, 120, 130, 140, 150, 160, 180, 200,
)  # fmt: skip
BAR_ALLOWANCE = 2.0  # on diameter, to turn the largest diameter clean


def standard_bar(data: dict[str, Any]) -> tuple[float, str] | None:
    """The stock bar for a part: the next common size at least 2 mm over its largest diameter."""
    biggest = 0.0
    for f in data.get("features", []):
        for key in ("diameter", "diameter_start", "diameter_end"):
            if f.get("type") in ("od", "taper", "groove"):
                v = (f.get("fields", {}).get(key) or {}).get("value")
                if isinstance(v, int | float):
                    biggest = max(biggest, float(v))
    if biggest <= 0:
        return None
    need = biggest + BAR_ALLOWANCE
    size = next((b for b in STOCK_BARS if b >= need - 1e-9), None)
    if size is None:
        return None
    return float(size), (
        f"not on the drawing: the next common bar size at least {BAR_ALLOWANCE:g} mm over the "
        f"largest diameter Ø{biggest:g}. Check it against the bar on the rack."
    )


def _ai_untouched(ft: FeatureTable) -> bool:
    """Filled by the AI reader and not touched since: no value ticked or changed by an engineer,
    table not confirmed. Such a table may be read again (and replaced) by the AI."""
    if ft.source != "drawing_reader" or ft.status != FeatureTableStatus.DRAFT.value:
        return False
    header = ft.data.get("header", {})
    cells = [c for k, c in header.items() if k != "bar_diameter"] + [
        c for f in ft.data.get("features", []) for c in f.get("fields", {}).values()
    ]
    bar = header.get("bar_diameter") or {}  # chosen by the app when the drawing has none
    return not bar.get("confirmed") and all(
        not c.get("confirmed") and c.get("value") in (None, "", c.get("ai")) for c in cells
    )


def _ai_may_fill(ft: FeatureTable) -> bool:
    """Empty, or only what the AI itself filled in: the AI never overwrites an engineer's work."""
    return _table_is_empty(ft) or _ai_untouched(ft)


def _table_is_empty(ft: FeatureTable) -> bool:
    cells = list(ft.data.get("header", {}).values()) + [
        c for f in ft.data.get("features", []) for c in f.get("fields", {}).values()
    ]
    return all(c.get("value") in (None, "") for c in cells)


@router.post("", response_model=DrawingOut, status_code=201)
async def upload_drawing(
    request: Request,
    background: BackgroundTasks,
    part_number: str = Form(min_length=1, max_length=64),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(uploaders),
    audit: AuditLogger = Depends(get_audit),
) -> DrawingOut:
    content = await file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise HTTPException(413, "Drawing is larger than 25 MB.")
    if not content:
        raise HTTPException(422, "The file is empty.")
    ctype = sniff(content)
    if ctype is None:
        raise HTTPException(415, "Upload the drawing as a PDF or an image (PNG, JPG or WEBP).")
    part = part_number.strip()
    if other := _other_part_in_name(db, file.filename or "", part):
        raise HTTPException(
            409,
            f"The file name '{file.filename}' is for part {other}, not {part}. "
            f"Open part {other} (or create it) and upload it there.",
        )
    digest = hashlib.sha256(content).hexdigest()
    d = db.scalar(select(Drawing).where(Drawing.part_number == part, Drawing.sha256 == digest))
    if d is not None:  # the same file again: keep one copy
        out = _out(d)
        if ai_reader_enabled():
            out.autofill = _start_ai_read(request, background, db, user, part, d, content)
        return out
    d = Drawing(
        part_number=part,
        filename=(file.filename or "drawing")[-255:],
        content_type=ctype,
        size=len(content),
        sha256=digest,
        content=content,
        uploaded_by=user.id,
        uploaded_by_name=user.full_name or user.username,
    )
    db.add(d)
    db.commit()
    audit.record(
        "drawing_upload",
        AuditResult.OK,
        user=user,
        payload={
            "drawing_id": d.id,
            "part_number": d.part_number,
            "filename": d.filename,
            "sha256": d.sha256,
            "size": d.size,
        },
    )
    out = _out(d)
    # Every drawing is read by the AI reader, also one seen before: nothing is filled from
    # stored values, so every table comes from the API.
    if ai_reader_enabled():
        out.autofill = _start_ai_read(request, background, db, user, part, d, content)
    return out


def _ai_jobs(app: FastAPI) -> dict[str, dict[str, Any]]:
    """AI read jobs of this server process (kept for an hour)."""
    jobs: dict[str, dict[str, Any]] | None = getattr(app.state, "ai_jobs", None)
    if jobs is None:
        jobs = {}
        app.state.ai_jobs = jobs
    cutoff = time.time() - 3600
    for k in [k for k, j in jobs.items() if j["started"] < cutoff]:
        del jobs[k]
    return jobs


def _start_ai_read(
    request: Request,
    background: BackgroundTasks,
    db: Session,
    user: User,
    part: str,
    d: Drawing,
    content: bytes,
    model: str | None = None,
) -> dict[str, Any] | None:
    """Not a known drawing: two AI agents read it into the EMPTY table, as a background job.

    The upload answers at once with a job id; the screen polls /drawings/ai-jobs/{id} and shows
    agent 1 (extract + 3D analysis + feature list) and agent 2 (verify) as they work."""
    ft = db.scalar(select(FeatureTable).where(FeatureTable.part_number == part))
    if ft is None or not _ai_may_fill(ft):
        return None
    for job in _ai_jobs(request.app).values():  # already reading this part: show that job
        if job["part_number"] == part and job["status"] == "running":
            return dict(job["info"])
    info: dict[str, Any] = {
        "part_number": part,
        "title": d.filename,
        "read_by": "AI (extractor + verifier)",
        "ai": True,
        "not_on_drawing": [],
        "not_in_table": [],
        "questions": [],
        "aliases": [],
        "not_lathe": "",
        "bar_estimate": None,
        "back_note": "",
        "filled": False,
        "message": "Two AI agents are reading the drawing: one extracts, the second checks it.",
    }
    job_id = uuid.uuid4().hex
    info["job_id"] = job_id
    _ai_jobs(request.app)[job_id] = {
        "id": job_id,
        "part_number": part,
        "status": "running",
        "stage": "queued",
        "round": 0,
        "started": time.time(),
        "updated": time.time(),
        "info": info,
    }
    info["model"] = model or get_settings().ai_model
    args = (request.app, job_id, user.id, part, d.filename, content, dict(info), model)
    # The in-browser server (GitHub Pages) runs the job as a task on its own event loop, so the
    # app keeps answering while the agents read; a normal server uses a background task.
    schedule = getattr(request.app.state, "ai_scheduler", None)
    if schedule is not None:
        schedule(_run_ai_read(*args))
    else:
        background.add_task(_run_ai_read, *args)
    return info


async def _run_ai_read(
    app: FastAPI,
    job_id: str,
    user_id: int,
    part: str,
    filename: str,
    content: bytes,
    info: dict[str, Any],
    model: str | None = None,
) -> None:
    job = _ai_jobs(app)[job_id]

    def progress(stage: str, n: int) -> None:
        job["stage"], job["round"], job["updated"] = stage, n, time.time()

    def finish(status: str, message: str) -> None:
        info["message"] = message
        job.update(status=status, stage=status, info=info, updated=time.time())

    try:
        reader = get_drawing_reader(model) if model else get_drawing_reader()
        if getattr(reader, "runs_in_event_loop", False):
            result = await reader.aread_report(content, filename, part, progress)  # type: ignore[attr-defined]
        else:
            result = await run_in_threadpool(reader.read_report, content, filename, part, progress)
    except DrawingReaderError as e:
        finish("failed", f"{e} Enter the values from the drawing by hand.")
        return
    notes = result.notes
    info["not_in_table"] = notes.get("not_in_table", [])
    info["questions"] = notes.get("questions", [])
    for key in (
        "shape_3d",
        "feature_list",
        "check_counts",
        "verify_rounds",
        "verdict",
        "callouts",
        "balloons",
        "unaccounted",
        "usage",
    ):
        info[key] = notes.get(key)
    if notes.get("not_lathe"):
        info["not_lathe"] = notes["not_lathe"]
        finish("done", f"The AI reader says this is not a single lathe part: {notes['not_lathe']}")
        return
    factory = app.state.session_factory
    with factory() as db:
        ft = db.scalar(select(FeatureTable).where(FeatureTable.part_number == part))
        user = db.get(User, user_id)
        if ft is None or not _ai_may_fill(ft) or user is None:
            finish("done", "The table was filled meanwhile; the AI suggestions were not applied.")
            return
        data = normalise(result.table.model_dump())
        for cell in [
            *data["header"].values(),
            *(c for f in data["features"] for c in f["fields"].values()),
        ]:
            # filled in, never ticked: the engineer checks each value against the drawing and
            # ticks it; the table cannot be confirmed (or a program made) before every tick
            cell["value"], cell["confirmed"] = cell["ai"], False
        if data["header"]["bar_diameter"]["ai"] is None:
            # the bar size is almost never on a drawing: choose the stock bar (unticked)
            bar = standard_bar(data)
            if bar is not None:
                data["header"]["bar_diameter"]["value"] = bar[0]
                info["bar_estimate"] = {"value": bar[0], "note": bar[1]}
            else:
                info["not_on_drawing"] = ["bar_diameter"]
        ft.data = data
        ft.status = FeatureTableStatus.DRAFT.value
        ft.source = "drawing_reader"
        db.commit()
        AuditLogger(factory).record(
            "feature_table_ai_read",
            AuditResult.OK,
            user=user,
            payload={"part_number": part, "feature_table_id": ft.id, "ai": result.audit},
        )
    info["filled"] = True
    finish(
        "done",
        "The AI read this drawing (one agent read it, a second checked and corrected it) and "
        "filled in the table. Check each value against the drawing and tick it, then confirm.",
    )


@router.post("/{drawing_id}/ai-read")
def ai_read_drawing(
    drawing_id: int,
    request: Request,
    background: BackgroundTasks,
    model: Literal["sonnet", "opus"] | None = Query(
        None, description="Which model reads it: sonnet (everyday) or opus (more thorough)."
    ),
    db: Session = Depends(get_db),
    user: User = Depends(uploaders),
) -> dict[str, Any]:
    """Read an uploaded drawing with the two AI agents into an empty feature table, or again into
    a table the AI filled that nobody has touched. Nothing is ticked: the engineer checks every
    value. Answers at once with the job to poll."""
    if not ai_reader_enabled():
        raise HTTPException(409, "The AI reader is off. Switch it on (API key) and try again.")
    d = db.get(Drawing, drawing_id)
    if d is None:
        raise HTTPException(404, "Drawing not found.")
    info = _start_ai_read(
        request,
        background,
        db,
        user,
        d.part_number,
        d,
        d.content,
        AI_MODELS[model] if model else None,
    )
    if info is None:
        raise HTTPException(
            409,
            f"An engineer has already entered or ticked values in the feature table of part "
            f"{d.part_number}. The AI never overwrites an engineer's work: it reads only into an "
            "empty table, or again into a table it filled itself that nobody has touched.",
        )
    return info


@router.get("/ai-reader")
def ai_reader_status(_: User = Depends(any_user)) -> dict[str, Any]:
    """Is the two-agent AI reader switched on (server setting + API key)?"""
    from app.config import get_settings

    s = get_settings()
    return {"enabled": ai_reader_enabled(), "model": s.ai_model if ai_reader_enabled() else None}


@router.get("/ai-jobs/{job_id}")
def ai_job(job_id: str, request: Request, _: User = Depends(any_user)) -> dict[str, Any]:
    """Progress of a two-agent AI read: stage extract / verify (round) / done / failed."""
    job = _ai_jobs(request.app).get(job_id)
    if job is None:
        raise HTTPException(404, "No such AI read (it may have finished more than an hour ago).")
    return {**job, "elapsed": round(time.time() - job["started"], 1)}


@router.get("/{drawing_id}/file")
def drawing_file(
    drawing_id: int, db: Session = Depends(get_db), _: User = Depends(any_user)
) -> Response:
    d = db.get(Drawing, drawing_id)
    if d is None:
        raise HTTPException(404, "Drawing not found.")
    content = d.content

    def chunks() -> Iterator[bytes]:
        # Sent in pieces: some reverse proxies stall on one large write of a drawing.
        for i in range(0, len(content), CHUNK):
            yield content[i : i + CHUNK]

    return StreamingResponse(
        chunks(),
        media_type=d.content_type,
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(d.filename)}",
            "Content-Length": str(len(content)),
            "Cache-Control": "private, max-age=3600",
        },
    )
