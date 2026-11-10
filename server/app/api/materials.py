"""Raw material register (Milestone 4)."""

import json
from collections import Counter
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.deps import any_user, get_audit, require_roles
from app.db.models import Material, Role, User, grade_key
from app.db.session import get_db
from app.services.audit_log import AuditLogger, AuditResult
from app.services.material_import import (
    TARGET_FIELDS,
    ImportFileError,
    MaterialData,
    Table,
    map_rows,
    parse_table,
    suggest_mapping,
    validate_mapping,
)

router = APIRouter(prefix="/materials", tags=["materials"])
editors = require_roles(Role.ADMIN, Role.ENGINEER)
MAX_UPLOAD_BYTES = 5 * 1024 * 1024


class MaterialIn(BaseModel):
    grade: str = Field(min_length=1, max_length=64)
    bar_diameter: float = Field(gt=0, le=1000)
    available_length: float | None = Field(default=None, gt=0)
    stock_quantity: float | None = Field(default=None, ge=0)
    quantity_unit: str = Field(default="bars", max_length=16)
    notes: str = Field(default="", max_length=2000)


class MaterialOut(MaterialIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    updated_at: datetime


class PreviewOut(BaseModel):
    headers: list[str]
    sample_rows: list[list[str]]
    row_count: int
    suggested_mapping: dict[str, str | None]
    target_fields: list[str]


class RowReport(BaseModel):
    row_number: int
    status: Literal["created", "updated", "skipped_duplicate", "duplicate_in_file", "error"]
    message: str = ""


class ImportReport(BaseModel):
    dry_run: bool
    created: int
    updated: int
    skipped: int
    errors: int
    rows: list[RowReport]


# ---------- CRUD ----------


@router.get("", response_model=list[MaterialOut])
def search_materials(
    q: str | None = None,
    diameter_min: float | None = None,
    diameter_max: float | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(any_user),
) -> list[MaterialOut]:
    stmt = select(Material)
    if q and q.strip():
        term = q.strip()
        like = f"%{term}%"
        conds = [Material.grade.ilike(like), Material.notes.ilike(like)]
        conds.append(Material.grade_key.like(f"%{grade_key(term)}%"))
        stmt = stmt.where(or_(*conds))
    if diameter_min is not None:
        stmt = stmt.where(Material.bar_diameter >= diameter_min)
    if diameter_max is not None:
        stmt = stmt.where(Material.bar_diameter <= diameter_max)
    rows = db.scalars(stmt.order_by(Material.grade_key, Material.bar_diameter).limit(500))
    return [MaterialOut.model_validate(m) for m in rows]


def _get(db: Session, material_id: int) -> Material:
    m = db.get(Material, material_id)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Material not found.")
    return m


def _commit_or_duplicate(db: Session, body: MaterialIn) -> None:
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{body.grade} Ø{body.bar_diameter:g} mm is already in the register. Edit that row.",
        ) from e


@router.post("", response_model=MaterialOut, status_code=status.HTTP_201_CREATED)
def create_material(
    body: MaterialIn,
    db: Session = Depends(get_db),
    user: User = Depends(editors),
    audit: AuditLogger = Depends(get_audit),
) -> MaterialOut:
    m = Material(**body.model_dump(), grade_key=grade_key(body.grade))
    db.add(m)
    _commit_or_duplicate(db, body)
    audit.record("material_create", AuditResult.OK, user=user, payload=body.model_dump())
    return MaterialOut.model_validate(m)


@router.put("/{material_id}", response_model=MaterialOut)
def update_material(
    material_id: int,
    body: MaterialIn,
    db: Session = Depends(get_db),
    user: User = Depends(editors),
    audit: AuditLogger = Depends(get_audit),
) -> MaterialOut:
    m = _get(db, material_id)
    for k, v in body.model_dump().items():
        setattr(m, k, v)
    m.grade_key = grade_key(body.grade)
    _commit_or_duplicate(db, body)
    audit.record(
        "material_update",
        AuditResult.OK,
        user=user,
        payload={"material_id": material_id, **body.model_dump()},
    )
    return MaterialOut.model_validate(m)


@router.delete("/{material_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_material(
    material_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(editors),
    audit: AuditLogger = Depends(get_audit),
) -> None:
    m = _get(db, material_id)
    payload = {"material_id": material_id, "grade": m.grade, "bar_diameter": m.bar_diameter}
    db.delete(m)
    db.commit()
    audit.record("material_delete", AuditResult.OK, user=user, payload=payload)


# ---------- import ----------


async def _read_table(file: UploadFile) -> Table:
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File is larger than 5 MB.")
    try:
        return parse_table(data, file.filename or "")
    except ImportFileError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/import/preview", response_model=PreviewOut)
async def preview_import(
    file: UploadFile = File(...),
    _: User = Depends(editors),
) -> PreviewOut:
    table = await _read_table(file)
    return PreviewOut(
        headers=table.headers,
        sample_rows=table.rows[:10],
        row_count=len(table.rows),
        suggested_mapping=suggest_mapping(table.headers),
        target_fields=list(TARGET_FIELDS),
    )


def _apply(
    db: Session, data: MaterialData, on_duplicate: str
) -> Literal["created", "updated", "skipped_duplicate"]:
    key = grade_key(data.grade)
    existing = db.scalar(
        select(Material).where(
            Material.grade_key == key, Material.bar_diameter == data.bar_diameter
        )
    )
    if existing is None:
        db.add(Material(**data.__dict__, grade_key=key))
        return "created"
    if on_duplicate == "skip":
        return "skipped_duplicate"
    existing.grade = data.grade
    existing.available_length = data.available_length
    existing.stock_quantity = data.stock_quantity
    if data.notes:
        existing.notes = data.notes
    return "updated"


@router.post("/import", response_model=ImportReport)
async def import_materials(
    file: UploadFile = File(...),
    mapping: str | None = Form(default=None, description="JSON {field: column header}"),
    on_duplicate: Literal["skip", "update"] = Form(default="skip"),
    dry_run: bool = Form(default=False),
    db: Session = Depends(get_db),
    user: User = Depends(editors),
    audit: AuditLogger = Depends(get_audit),
) -> ImportReport:
    table = await _read_table(file)
    try:
        col_map: dict[str, str | None] = (
            json.loads(mapping) if mapping else suggest_mapping(table.headers)
        )
        if not isinstance(col_map, dict):
            raise ValueError
    except (ValueError, ValidationError) as e:
        raise HTTPException(422, "Column mapping must be a JSON object.") from e
    problems = validate_mapping(table, col_map)
    if problems:
        raise HTTPException(422, " ".join(problems))

    reports: list[RowReport] = []
    seen: dict[tuple[str, float], int] = {}
    for res in map_rows(table, col_map):
        if res.data is None:
            reports.append(
                RowReport(row_number=res.row_number, status="error", message="; ".join(res.errors))
            )
            continue
        key = (grade_key(res.data.grade), res.data.bar_diameter)
        if key in seen:
            reports.append(
                RowReport(
                    row_number=res.row_number,
                    status="duplicate_in_file",
                    message=f"Same grade and diameter as row {seen[key]}; row ignored.",
                )
            )
            continue
        seen[key] = res.row_number
        outcome = _apply(db, res.data, on_duplicate)
        label = f"{res.data.grade} Ø{res.data.bar_diameter:g}"
        reports.append(RowReport(row_number=res.row_number, status=outcome, message=label))

    counts = Counter(r.status for r in reports)
    report = ImportReport(
        dry_run=dry_run,
        created=counts["created"],
        updated=counts["updated"],
        skipped=counts["skipped_duplicate"] + counts["duplicate_in_file"],
        errors=counts["error"],
        rows=reports,
    )
    if dry_run:
        db.rollback()
    else:
        db.commit()
        audit.record(
            "material_import",
            AuditResult.OK,
            user=user,
            payload={
                "filename": file.filename,
                "on_duplicate": on_duplicate,
                "mapping": col_map,
                "created": report.created,
                "updated": report.updated,
                "skipped": report.skipped,
                "errors": report.errors,
            },
        )
    return report
