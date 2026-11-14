"""Programs: upload, versions, validation, approval (Milestone 9)."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import any_user, get_audit, require_roles
from app.db.models import Machine, Program, ProgramSource, ProgramStatus, Role, User
from app.db.session import get_db
from app.gcode.backplot import backplot, stock_outline
from app.services.approval import approval_problem
from app.services.audit_log import AuditLogger, AuditResult
from app.services.program_store import (
    ProgramError,
    create_version,
    family,
    mark_approved,
    validate_for_machine,
)

router = APIRouter(prefix="/programs", tags=["programs"])
programmers = require_roles(Role.PROGRAMMER)
# Accepting (approving) a program: the engineer or the programmer (shop decision, 13 Nov 2026).
approvers = require_roles(Role.PROGRAMMER, Role.ENGINEER)
retirers = require_roles(Role.PROGRAMMER, Role.ADMIN)


class ProgramSummary(BaseModel):
    id: int
    machine_id: int
    machine_name: str
    part_number: str
    program_number: int
    name: str
    title: str
    version: int
    is_latest: bool
    sha256: str
    status: str
    source: str
    source_note: str
    approved_by_name: str | None
    approved_at: datetime | None
    proven: bool
    created_at: datetime
    error_count: int
    warning_count: int


class ProgramDetail(ProgramSummary):
    text: str
    lines: list[str]
    approved_hash: str | None
    status_note: str
    proven_note: str
    validation: dict[str, Any]
    versions: list[dict[str, Any]]
    sendable_problem: str | None


class ProgramUpload(BaseModel):
    machine_id: int
    text: str = Field(min_length=1, max_length=1_000_000)
    part_number: str | None = Field(default=None, max_length=64)


class ProgramTextUpdate(BaseModel):
    text: str = Field(min_length=1, max_length=1_000_000)


class RejectBody(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


def _summary(db: Session, p: Program, latest_ids: set[int] | None = None) -> dict[str, Any]:
    v = validate_for_machine(p.text, p.machine)
    is_latest = p.id in latest_ids if latest_ids is not None else family(db, p)[0].id == p.id
    return {
        "id": p.id,
        "machine_id": p.machine_id,
        "machine_name": p.machine.name,
        "part_number": p.part_number,
        "program_number": p.program_number,
        "name": f"O{p.program_number:04d}",
        "title": p.title,
        "version": p.version,
        "is_latest": is_latest,
        "sha256": p.sha256,
        "status": p.status,
        "source": p.source,
        "source_note": p.source_note,
        "approved_by_name": p.approved_by_name,
        "approved_at": p.approved_at,
        "proven": p.proven,
        "created_at": p.created_at,
        "error_count": len(v.errors),
        "warning_count": len(v.warnings),
    }


def _detail(db: Session, p: Program) -> ProgramDetail:
    fam = family(db, p)
    v = validate_for_machine(p.text, p.machine)
    return ProgramDetail(
        **_summary(db, p, {fam[0].id}),
        text=p.text,
        lines=[ln.rstrip() for ln in p.text.replace("\r", "").split("\n")],
        approved_hash=p.approved_hash,
        status_note=p.status_note,
        proven_note=p.proven_note,
        validation=v.to_dict(),
        versions=[
            {
                "id": x.id,
                "version": x.version,
                "status": x.status,
                "sha256": x.sha256,
                "created_at": x.created_at,
            }
            for x in fam
        ],
        sendable_problem=approval_problem(db, p, p.machine),
    )


def _get(db: Session, program_id: int) -> Program:
    p = db.get(Program, program_id)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Program not found.")
    return p


def _audit(audit: AuditLogger, action: str, user: User, p: Program, **payload: Any) -> None:
    audit.record(
        action,
        AuditResult.OK,
        user=user,
        machine_id=p.machine_id,
        program_id=p.id,
        program_hash=p.sha256,
        payload={"program": f"O{p.program_number:04d}", "version": p.version, **payload},
    )


@router.get("", response_model=list[ProgramSummary])
def list_programs(
    machine_id: int | None = None,
    part_number: str | None = None,
    program_status: str | None = None,
    latest_only: bool = True,
    db: Session = Depends(get_db),
    _: User = Depends(any_user),
) -> list[dict[str, Any]]:
    stmt = select(Program)
    if machine_id is not None:
        stmt = stmt.where(Program.machine_id == machine_id)
    if part_number:
        stmt = stmt.where(Program.part_number.ilike(f"%{part_number.strip()}%"))
    if program_status:
        stmt = stmt.where(Program.status == program_status)
    rows = list(db.scalars(stmt.order_by(Program.part_number, Program.version.desc())))
    latest: dict[tuple[int, str, int], int] = {}
    for p in db.scalars(select(Program).order_by(Program.version)):
        latest[(p.machine_id, p.part_number, p.program_number)] = p.id
    latest_ids = set(latest.values())
    if latest_only:
        rows = [p for p in rows if p.id in latest_ids]
    return [_summary(db, p, latest_ids) for p in rows]


@router.get("/{program_id}", response_model=ProgramDetail)
def get_program(
    program_id: int, db: Session = Depends(get_db), _: User = Depends(any_user)
) -> ProgramDetail:
    return _detail(db, _get(db, program_id))


@router.get("/{program_id}/file")
def download_for_usb(
    program_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(any_user),
    audit: AuditLogger = Depends(get_audit),
) -> Response:
    """The approved program as a file for a USB stick (FANUC 0i-TF panel USB port).

    Same rule as sending over the network (safety rule 3): only the approved, latest, unchanged
    version that still passes validation for its machine. The file is the program text exactly as
    approved, with CR LF line ends; its hash is in the audit log.
    """
    p = _get(db, program_id)
    if problem := approval_problem(db, p, p.machine):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Cannot download for the machine: {problem}")
    name = f"O{p.program_number:04d}.NC"
    try:
        body = p.text.replace("\r\n", "\n").replace("\n", "\r\n").encode("ascii")
    except UnicodeEncodeError as e:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "The program has characters the CNC cannot read."
        ) from e
    _audit(audit, "program_download", user, p, file=name, via="usb")
    return Response(
        body,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "X-Program-SHA256": p.sha256,
        },
    )


@router.get("/{program_id}/toolpath")
def toolpath(
    program_id: int,
    bar_diameter: float | None = Query(default=None, gt=0, le=1000),
    db: Session = Depends(get_db),
    _: User = Depends(any_user),
) -> dict[str, Any]:
    """Backplot segments in the X-Z plane (z, radius), one entry per drawn move."""
    p = _get(db, program_id)
    plot = backplot(p.text)
    return plot.to_dict(stock=stock_outline(bar_diameter, plot))


@router.post("", response_model=ProgramDetail, status_code=status.HTTP_201_CREATED)
def upload_program(
    body: ProgramUpload,
    db: Session = Depends(get_db),
    user: User = Depends(programmers),
    audit: AuditLogger = Depends(get_audit),
) -> ProgramDetail:
    machine = db.get(Machine, body.machine_id)
    if machine is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine not found.")
    try:
        p = create_version(
            db,
            machine=machine,
            text=body.text,
            source=ProgramSource.UPLOAD,
            user=user,
            part_number=body.part_number,
            source_note=f"uploaded by {user.username}",
        )
    except ProgramError as e:
        db.rollback()
        raise HTTPException(422, str(e)) from e
    db.commit()
    _audit(audit, "program_upload", user, p)
    return _detail(db, p)


@router.put("/{program_id}/text", response_model=ProgramDetail)
def change_text(
    program_id: int,
    body: ProgramTextUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(programmers),
    audit: AuditLogger = Depends(get_audit),
) -> ProgramDetail:
    """Never edits in place: creates a NEW draft version and clears approval of the family."""
    old = _get(db, program_id)
    if body.text == old.text:
        raise HTTPException(422, "No change: the text is identical to this version.")
    try:
        p = create_version(
            db,
            machine=old.machine,
            text=body.text,
            source=ProgramSource.UPLOAD,
            user=user,
            part_number=old.part_number,
            source_note=f"edited from v{old.version} by {user.username}",
        )
    except ProgramError as e:
        db.rollback()
        raise HTTPException(422, str(e)) from e
    if p.program_number != old.program_number:
        db.rollback()
        raise HTTPException(
            422, "The O-number changed. Upload it as a new program instead of editing this one."
        )
    db.commit()
    _audit(audit, "program_new_version", user, p, previous_version=old.version)
    return _detail(db, p)


@router.post("/{program_id}/approve", response_model=ProgramDetail)
def approve(
    program_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(approvers),
    audit: AuditLogger = Depends(get_audit),
) -> ProgramDetail:
    p = _get(db, program_id)
    if family(db, p)[0].id != p.id:
        raise HTTPException(409, "Only the latest version can be approved.")
    if p.status not in (ProgramStatus.DRAFT.value, ProgramStatus.REJECTED.value):
        raise HTTPException(409, f"Cannot approve a program with status '{p.status}'.")
    result = validate_for_machine(p.text, p.machine)
    if result.errors:
        raise HTTPException(
            422,
            f"Fix {len(result.errors)} validation error(s) first: {result.errors[0].message}",
        )
    mark_approved(p, user, user.full_name or user.username)
    db.commit()
    _audit(audit, "program_approve", user, p, warnings=len(result.warnings))
    return _detail(db, p)


@router.post("/{program_id}/reject", response_model=ProgramDetail)
def reject(
    program_id: int,
    body: RejectBody,
    db: Session = Depends(get_db),
    user: User = Depends(programmers),
    audit: AuditLogger = Depends(get_audit),
) -> ProgramDetail:
    p = _get(db, program_id)
    if p.status == ProgramStatus.RETIRED.value:
        raise HTTPException(409, "This program is retired.")
    p.status = ProgramStatus.REJECTED.value
    p.status_note = body.reason
    p.approved_hash = None
    db.commit()
    _audit(audit, "program_reject", user, p, reason=body.reason)
    return _detail(db, p)


@router.post("/{program_id}/retire", response_model=ProgramDetail)
def retire(
    program_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(retirers),
    audit: AuditLogger = Depends(get_audit),
) -> ProgramDetail:
    p = _get(db, program_id)
    p.status = ProgramStatus.RETIRED.value
    p.status_note = f"Retired by {user.username}."
    db.commit()
    _audit(audit, "program_retire", user, p)
    return _detail(db, p)
