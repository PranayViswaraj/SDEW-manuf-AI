"""Feature tables (Milestone 12). Engineers enter and confirm every value by hand."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.drawing_reader import DrawingReaderError, get_drawing_reader
from app.auth.deps import any_user, get_audit, require_roles
from app.db.models import FeatureTable, FeatureTableStatus, Program, Role, User
from app.db.session import get_db
from app.services.audit_log import AuditLogger, AuditResult
from app.services.feature_tables import (
    FeatureTableError,
    confirm,
    empty_data,
    normalise,
    schema,
    unconfirmed_cells,
    update_data,
)

router = APIRouter(prefix="/feature-tables", tags=["feature tables"])
engineers = require_roles(Role.ENGINEER)
MAX_DRAWING_BYTES = 20 * 1024 * 1024


class FeatureTableCreate(BaseModel):
    part_number: str = Field(min_length=1, max_length=64)
    drawing_ref: str = Field(default="", max_length=128)


class FeatureTableUpdate(BaseModel):
    data: dict[str, Any]
    drawing_ref: str | None = Field(default=None, max_length=128)


class FeatureTableOut(BaseModel):
    id: int
    part_number: str
    drawing_ref: str
    source: str
    status: str
    data: dict[str, Any]
    unconfirmed: list[str]
    confirmed_by_name: str | None
    confirmed_at: datetime | None
    updated_at: datetime
    programs: list[dict[str, Any]]
    # Only on "from drawing": the AI reader's questions, evidence and items not in the table.
    ai_notes: dict[str, Any] | None = None


def _out(db: Session, ft: FeatureTable) -> FeatureTableOut:
    data = normalise(ft.data)
    progs = db.scalars(select(Program).where(Program.part_number == ft.part_number))
    return FeatureTableOut(
        id=ft.id,
        part_number=ft.part_number,
        drawing_ref=ft.drawing_ref,
        source=ft.source,
        status=ft.status,
        data=data,
        unconfirmed=unconfirmed_cells(data),
        confirmed_by_name=ft.confirmed_by_name,
        confirmed_at=ft.confirmed_at,
        updated_at=ft.updated_at,
        programs=[
            {
                "id": p.id,
                "name": f"O{p.program_number:04d}",
                "version": p.version,
                "status": p.status,
                "machine_id": p.machine_id,
            }
            for p in progs
        ],
    )


def _get(db: Session, table_id: int) -> FeatureTable:
    ft = db.get(FeatureTable, table_id)
    if ft is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Feature table not found.")
    return ft


def _audit(audit: AuditLogger, action: str, user: User, ft: FeatureTable, **payload: Any) -> None:
    audit.record(
        action,
        AuditResult.OK,
        user=user,
        payload={"part_number": ft.part_number, "feature_table_id": ft.id, **payload},
    )


@router.get("/schema")
def get_schema(_: User = Depends(any_user)) -> dict[str, Any]:
    return schema()


@router.get("")
def list_tables(db: Session = Depends(get_db), _: User = Depends(any_user)) -> list[dict[str, Any]]:
    out = []
    for ft in db.scalars(select(FeatureTable).order_by(FeatureTable.part_number)):
        data = normalise(ft.data)
        out.append(
            {
                "id": ft.id,
                "part_number": ft.part_number,
                "drawing_ref": ft.drawing_ref,
                "status": ft.status,
                "features": len(data["features"]),
                "unconfirmed": len(unconfirmed_cells(data)),
                "confirmed_by_name": ft.confirmed_by_name,
                "confirmed_at": ft.confirmed_at,
                "material_grade": data["header"]["material_grade"]["value"],
                "bar_diameter": data["header"]["bar_diameter"]["value"],
            }
        )
    return out


def _create(
    db: Session, user: User, part_number: str, drawing_ref: str, data: dict[str, Any], source: str
) -> FeatureTable:
    part = part_number.strip()
    if db.scalar(select(FeatureTable).where(FeatureTable.part_number == part)):
        raise HTTPException(
            409, f"A feature table for part {part} already exists. Open it instead."
        )
    ft = FeatureTable(
        part_number=part,
        drawing_ref=drawing_ref,
        source=source,
        data=data,
        status=FeatureTableStatus.DRAFT.value,
        created_by=user.id,
    )
    db.add(ft)
    db.commit()
    return ft


@router.post("", response_model=FeatureTableOut, status_code=status.HTTP_201_CREATED)
def create_table(
    body: FeatureTableCreate,
    db: Session = Depends(get_db),
    user: User = Depends(engineers),
    audit: AuditLogger = Depends(get_audit),
) -> FeatureTableOut:
    ft = _create(db, user, body.part_number, body.drawing_ref, empty_data(), "manual")
    _audit(audit, "feature_table_create", user, ft)
    return _out(db, ft)


@router.post("/from-drawing", response_model=FeatureTableOut, status_code=status.HTTP_201_CREATED)
async def create_from_drawing(
    part_number: str = Form(..., min_length=1, max_length=64),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(engineers),
    audit: AuditLogger = Depends(get_audit),
) -> FeatureTableOut:
    """Run the drawing reader (AI when switched on). Its output only ever fills the "ai" fields."""
    content = await file.read(MAX_DRAWING_BYTES + 1)
    if len(content) > MAX_DRAWING_BYTES:
        raise HTTPException(413, "Drawing file is larger than 20 MB.")
    try:
        # The AI agents take a while: keep them off the event loop.
        result = await run_in_threadpool(
            get_drawing_reader().read_report, content, file.filename or "", part_number
        )
    except DrawingReaderError as e:
        raise HTTPException(503, f"{e} You can still create the table and enter values.") from e
    suggested = result.table.model_dump()
    # Safety: whatever the reader returns, keep ONLY suggestions. Values/confirmations stay empty.
    for cell in suggested["header"].values():
        cell["value"], cell["confirmed"] = None, False
    for feature in suggested["features"]:
        for cell in feature["fields"].values():
            cell["value"], cell["confirmed"] = None, False
    ft = _create(db, user, part_number, file.filename or "", normalise(suggested), "drawing_reader")
    _audit(audit, "feature_table_from_drawing", user, ft, filename=file.filename, ai=result.audit)
    out = _out(db, ft)
    out.ai_notes = result.notes or None
    return out


@router.get("/{table_id}", response_model=FeatureTableOut)
def get_table(
    table_id: int, db: Session = Depends(get_db), _: User = Depends(any_user)
) -> FeatureTableOut:
    return _out(db, _get(db, table_id))


@router.put("/{table_id}", response_model=FeatureTableOut)
def update_table(
    table_id: int,
    body: FeatureTableUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(engineers),
    audit: AuditLogger = Depends(get_audit),
) -> FeatureTableOut:
    ft = _get(db, table_id)
    was_confirmed = ft.status == FeatureTableStatus.CONFIRMED.value
    try:
        update_data(ft, body.data)
    except FeatureTableError as e:
        db.rollback()
        raise HTTPException(422, str(e)) from e
    if body.drawing_ref is not None:
        ft.drawing_ref = body.drawing_ref
    db.commit()
    _audit(
        audit,
        "feature_table_update",
        user,
        ft,
        confirmation_cleared=was_confirmed and ft.status != FeatureTableStatus.CONFIRMED.value,
    )
    return _out(db, ft)


@router.post("/{table_id}/confirm", response_model=FeatureTableOut)
def confirm_table(
    table_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(engineers),
    audit: AuditLogger = Depends(get_audit),
) -> FeatureTableOut:
    ft = _get(db, table_id)
    try:
        confirm(ft, user)
    except FeatureTableError as e:
        db.rollback()
        raise HTTPException(422, str(e)) from e
    db.commit()
    _audit(audit, "feature_table_confirm", user, ft, hash=ft.confirmed_hash)
    return _out(db, ft)
