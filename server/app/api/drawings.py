"""Part drawings: upload and view next to the feature table (stored byte for byte)."""

import hashlib
import time
import uuid
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any
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

from app.ai.drawing_reader import DrawingReaderError, ai_reader_enabled, get_drawing_reader
from app.ai.known_drawings import KnownDrawing, find_known, load_known
from app.auth.deps import any_user, get_audit, require_roles
from app.db.models import Drawing, FeatureTable, FeatureTableStatus, Role, User
from app.db.session import get_db
from app.services.audit_log import AuditLogger, AuditResult
from app.services.feature_tables import normalise
from app.services.program_library import load_library

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


def _known(request: Request) -> list[KnownDrawing]:
    folder = Path(str(request.app.state.settings.samples_dir)).parent / "drawings"
    return load_known(folder / "known_drawings.json")


def _known_out(k: KnownDrawing) -> dict[str, Any]:
    return {
        "part_number": k.part_number,
        "title": k.title,
        "read_by": k.read_by,
        "not_on_drawing": list(k.not_on_drawing),
        "not_in_table": list(k.not_in_table),
        "aliases": list(k.aliases),
        "not_lathe": k.not_lathe,
        "bar_estimate": k.bar_estimate,
        "back_note": k.back_note,
    }


def _same_part(request: Request, a: str, b: str) -> bool:
    """True when a and b are the same part (identical, or aliases on a known drawing)."""
    if _norm(a) == _norm(b):
        return True
    return any(_norm(a) in k.names() and _norm(b) in k.names() for k in _known(request))


def _norm(text: str) -> str:
    return "".join(ch for ch in text.upper() if ch.isalnum())


def _other_part_in_name(request: Request, db: Session, filename: str, part: str) -> str | None:
    """A known part number (company programs, known drawings, existing parts) named in the file
    name that is not the part being uploaded to: the file was most likely picked by mistake."""
    name = _norm(filename)
    if not name or _norm(part) in name:
        return None
    known = {k.part_number for k in _known(request) if not k.not_lathe}
    known |= {
        p
        for prog in load_library(str(request.app.state.settings.samples_dir))
        for p in prog.part_numbers
    }
    known |= set(db.scalars(select(FeatureTable.part_number)))
    for other in sorted(known, key=len, reverse=True):
        if len(_norm(other)) >= 6 and _norm(other) in name and not _same_part(request, other, part):
            return other
    return None


def _has_ai_suggestions(ft: FeatureTable) -> bool:
    cells = list(ft.data.get("header", {}).values()) + [
        c for f in ft.data.get("features", []) for c in f.get("fields", {}).values()
    ]
    return any(c.get("ai") not in (None, "") for c in cells)


def _table_is_empty(ft: FeatureTable) -> bool:
    cells = list(ft.data.get("header", {}).values()) + [
        c for f in ft.data.get("features", []) for c in f.get("fields", {}).values()
    ]
    return all(c.get("value") in (None, "") for c in cells)


@router.get("/known")
def known_drawing(
    request: Request,
    part_number: str = Query(min_length=1, max_length=64),
    _: User = Depends(any_user),
) -> dict[str, Any] | None:
    """What is recorded for a known drawing (incl. items the table cannot hold), or null."""
    k = find_known(_known(request), part_number=part_number)
    return _known_out(k) if k else None


@router.post("/identify")
async def identify_drawing(
    request: Request,
    file: UploadFile = File(...),
    _: User = Depends(uploaders),
) -> dict[str, Any] | None:
    """Which known part a drawing file is, by its fingerprint or the part number in its name."""
    content = await file.read(MAX_BYTES + 1)
    known = _known(request)
    k = find_known(known, sha256=hashlib.sha256(content).hexdigest())
    if k is None:
        name = _norm(file.filename or "")
        k = next(
            (x for x in known if any(n and len(n) >= 6 and n in name for n in x.names())), None
        )
    return _known_out(k) if k else None


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
    if other := _other_part_in_name(request, db, file.filename or "", part):
        raise HTTPException(
            409,
            f"The file name '{file.filename}' is for part {other}, not {part}. "
            f"Open part {other} (or create it) and upload it there.",
        )
    digest = hashlib.sha256(content).hexdigest()
    d = db.scalar(select(Drawing).where(Drawing.part_number == part, Drawing.sha256 == digest))
    if d is not None:  # the same file again: keep one copy
        out = _out(d)
        out.autofill = _autofill(request, db, user, audit, part, digest)
        if out.autofill is None and ai_reader_enabled():
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
    out.autofill = _autofill(request, db, user, audit, part, digest)
    if out.autofill is None and ai_reader_enabled():
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
) -> dict[str, Any] | None:
    """Not a known drawing: two AI agents read it into the EMPTY table, as a background job.

    The upload answers at once with a job id; the screen polls /drawings/ai-jobs/{id} and shows
    agent 1 (extract + 3D analysis + feature list) and agent 2 (verify) as they work."""
    ft = db.scalar(select(FeatureTable).where(FeatureTable.part_number == part))
    if ft is None or not _table_is_empty(ft):
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
    args = (request.app, job_id, user.id, part, d.filename, content, dict(info))
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
) -> None:
    job = _ai_jobs(app)[job_id]

    def progress(stage: str, n: int) -> None:
        job["stage"], job["round"], job["updated"] = stage, n, time.time()

    def finish(status: str, message: str) -> None:
        info["message"] = message
        job.update(status=status, stage=status, info=info, updated=time.time())

    try:
        reader = get_drawing_reader()
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
        if ft is None or not _table_is_empty(ft) or user is None:
            finish("done", "The table was filled meanwhile; the AI suggestions were not applied.")
            return
        data = normalise(result.table.model_dump())
        for cell in [
            *data["header"].values(),
            *(c for f in data["features"] for c in f["fields"].values()),
        ]:
            cell["value"], cell["confirmed"] = None, False  # suggestions only (safety rule 3)
        if data["header"]["bar_diameter"]["ai"] is None:
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
        "The AI read this drawing (one agent read it, a second checked and corrected it). Each "
        "value is a suggestion: compare it with the drawing, press Use, tick it, then confirm.",
    )


@router.post("/{drawing_id}/ai-read")
def ai_read_drawing(
    drawing_id: int,
    request: Request,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(uploaders),
) -> dict[str, Any]:
    """Read an uploaded drawing with the two AI agents. Fills only an EMPTY feature table, as
    suggestions the engineer checks and ticks; answers at once with the job to poll."""
    if not ai_reader_enabled():
        raise HTTPException(409, "The AI reader is off. Switch it on (API key) and try again.")
    d = db.get(Drawing, drawing_id)
    if d is None:
        raise HTTPException(404, "Drawing not found.")
    ft = db.scalar(select(FeatureTable).where(FeatureTable.part_number == d.part_number))
    if ft is not None and _has_ai_suggestions(ft):
        raise HTTPException(
            409,
            f"The AI has already read a drawing of part {d.part_number}: its suggestions are in "
            "the table. Check and tick them, or clear the table to read again.",
        )
    info = _start_ai_read(request, background, db, user, d.part_number, d, d.content)
    if info is None:
        raise HTTPException(
            409,
            f"The feature table of part {d.part_number} already has values. The AI only fills an "
            "empty table, so it never overwrites what an engineer entered.",
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


def _autofill(
    request: Request, db: Session, user: User, audit: AuditLogger, part: str, digest: str
) -> dict[str, Any] | None:
    """Fill an EMPTY feature table from a known drawing. Values stay unticked/unconfirmed."""
    k = find_known(_known(request), sha256=digest, part_number=part)
    if k is None:
        return None
    info = _known_out(k) | {"filled": False, "message": ""}
    if k.not_lathe:
        info["message"] = k.not_lathe
        return info
    if not _same_part(request, k.part_number, part):
        info["message"] = (
            f"This file is the drawing of part {k.part_number}, not {part}. Nothing was filled."
        )
        return info
    ft = db.scalar(select(FeatureTable).where(FeatureTable.part_number == part))
    if ft is None:
        info["message"] = "Open or create the part first; its values will be filled then."
        return info
    if not _table_is_empty(ft):
        info["message"] = "The table already has values, so nothing was overwritten."
        return info
    ft.data = normalise(k.table_data())
    ft.status = FeatureTableStatus.DRAFT.value
    ft.source = "known_drawing"
    db.commit()
    audit.record(
        "feature_table_autofill",
        AuditResult.OK,
        user=user,
        payload={"part_number": part, "feature_table_id": ft.id, "drawing_sha256": digest},
    )
    info["filled"] = True
    info["message"] = (
        f"Filled from the recorded values of drawing {k.part_number}. Check each value against "
        "the drawing, tick it and confirm the table."
    )
    return info


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
