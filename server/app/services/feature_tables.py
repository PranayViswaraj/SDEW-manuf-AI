"""Feature tables: a turned part as structured values (safety rule 3, engineer half).

Every value is a cell: {"ai": <suggestion or null>, "value": <engineer's value>, "confirmed": bool}.
The AI drawing reader (future) may only fill "ai". Only an engineer sets "value"/"confirmed",
and a table counts as confirmed only after an engineer confirms the WHOLE table; any change
clears that confirmation.
"""

import hashlib
import json
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import FeatureTable, FeatureTableStatus, User

Kind = Literal["mm", "deg", "text", "tol"]

HEADER_FIELDS: list[tuple[str, str, Kind]] = [
    ("material_grade", "Material grade", "text"),
    ("bar_diameter", "Bar diameter", "mm"),
    ("overall_length", "Overall length", "mm"),
]
_TOL: list[tuple[str, str, Kind]] = [
    ("tol_plus", "Tolerance +", "tol"),
    ("tol_minus", "Tolerance -", "tol"),
]
FEATURE_TYPES: dict[str, tuple[str, list[tuple[str, str, Kind]]]] = {
    "od": (
        "OD (outside diameter)",
        [("diameter", "Diameter", "mm"), ("length", "Length", "mm"), *_TOL],
    ),
    "bore": ("ID / bore", [("diameter", "Diameter", "mm"), ("depth", "Depth", "mm"), *_TOL]),
    "face": ("Face", [("position", "Position from datum", "mm"), *_TOL]),
    "chamfer": ("Chamfer", [("size", "Size", "mm"), ("angle", "Angle", "deg"), *_TOL]),
    "radius": ("Radius", [("radius", "Radius", "mm"), *_TOL]),
    "groove": (
        "Groove",
        [
            ("diameter", "Diameter", "mm"),
            ("width", "Width", "mm"),
            ("position", "Position", "mm"),
            *_TOL,
        ],
    ),
    "thread": (
        "Thread",
        [
            ("size", "Size (e.g. M24)", "text"),
            ("pitch", "Pitch", "mm"),
            ("length", "Length", "mm"),
            ("tol_class", "Tolerance class (e.g. 6g)", "text"),
        ],
    ),
    "drill": ("Drill", [("diameter", "Diameter", "mm"), ("depth", "Depth", "mm"), *_TOL]),
    "cone": (
        "Cone / countersink",
        [
            ("diameter", "Mouth diameter", "mm"),
            ("angle", "Angle from axis", "deg"),
            ("radius", "Blend radius (0 = none)", "mm"),
            *_TOL,
        ],
    ),
    "flip": ("Turn part around (2nd clamping)", []),
}

CellValue = float | str | None


class Cell(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ai: CellValue = None
    value: CellValue = None
    confirmed: bool = False


class Feature(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str
    fields: dict[str, Cell] = Field(default_factory=dict)

    @field_validator("type")
    @classmethod
    def _known_type(cls, v: str) -> str:
        if v not in FEATURE_TYPES:
            raise ValueError(f"Unknown feature type '{v}'. Use one of: {', '.join(FEATURE_TYPES)}.")
        return v


class TableData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    header: dict[str, Cell] = Field(default_factory=dict)
    features: list[Feature] = Field(default_factory=list, max_length=200)


class FeatureTableError(ValueError):
    pass


def schema() -> dict[str, Any]:
    return {
        "header": [{"key": k, "label": lbl, "kind": kind} for k, lbl, kind in HEADER_FIELDS],
        "feature_types": [
            {
                "type": t,
                "label": label,
                "fields": [{"key": k, "label": lbl, "kind": kind} for k, lbl, kind in fields],
            }
            for t, (label, fields) in FEATURE_TYPES.items()
        ],
    }


def empty_data() -> dict[str, Any]:
    return {"header": {k: Cell().model_dump() for k, _, _ in HEADER_FIELDS}, "features": []}


def _check_cell(where: str, kind: Kind, cell: Cell) -> None:
    for name in ("ai", "value"):
        v = getattr(cell, name)
        if v is None or v == "":
            continue
        if kind == "text":
            if not isinstance(v, str) or len(v) > 64:
                raise FeatureTableError(f"{where}: must be text (max 64 characters).")
        else:
            if isinstance(v, bool) or not isinstance(v, int | float):
                raise FeatureTableError(f"{where}: must be a number.")
            if kind in ("mm", "deg") and v < 0:
                raise FeatureTableError(f"{where}: cannot be negative.")
            if kind == "deg" and v > 180:
                raise FeatureTableError(f"{where}: angle must be 0-180 degrees.")


def normalise(raw: dict[str, Any]) -> dict[str, Any]:
    """Validate structure and value types; add any missing cells (empty)."""
    try:
        data = TableData.model_validate(raw)
    except ValueError as e:
        raise FeatureTableError(str(e)) from e
    header_keys = {k for k, _, _ in HEADER_FIELDS}
    unknown = set(data.header) - header_keys
    if unknown:
        raise FeatureTableError(f"Unknown header fields: {', '.join(sorted(unknown))}.")
    out_header: dict[str, Any] = {}
    for key, label, kind in HEADER_FIELDS:
        cell = data.header.get(key, Cell())
        _check_cell(label, kind, cell)
        out_header[key] = cell.model_dump()
    out_features = []
    for n, f in enumerate(data.features, start=1):
        label, fields = FEATURE_TYPES[f.type]
        allowed = {k for k, _, _ in fields}
        extra = set(f.fields) - allowed
        if extra:
            raise FeatureTableError(
                f"Feature {n} ({label}): unknown fields {', '.join(sorted(extra))}."
            )
        cells = {}
        for key, flabel, kind in fields:
            cell = f.fields.get(key, Cell())
            _check_cell(f"Feature {n} ({label}) {flabel}", kind, cell)
            cells[key] = cell.model_dump()
        out_features.append({"type": f.type, "fields": cells})
    return {"header": out_header, "features": out_features}


def unconfirmed_cells(data: dict[str, Any]) -> list[str]:
    """Human-readable list of cells that still need an engineer-confirmed value."""
    missing = []
    for key, label, _ in HEADER_FIELDS:
        c = data["header"][key]
        if c["value"] in (None, "") or not c["confirmed"]:
            missing.append(label)
    for n, f in enumerate(data["features"], start=1):
        label, fields = FEATURE_TYPES[f["type"]]
        for key, flabel, _ in fields:
            c = f["fields"][key]
            if c["value"] in (None, "") or not c["confirmed"]:
                missing.append(f"Feature {n} ({label}): {flabel}")
    return missing


def data_hash(data: dict[str, Any]) -> str:
    canon = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def update_data(ft: FeatureTable, raw: dict[str, Any]) -> None:
    """Replace the values; any change clears the table confirmation."""
    new = normalise(raw)
    if new != ft.data or ft.status != FeatureTableStatus.DRAFT.value:
        ft.data = new
        ft.status = FeatureTableStatus.DRAFT.value
        ft.confirmed_by = None
        ft.confirmed_by_name = None
        ft.confirmed_at = None
        ft.confirmed_hash = None


def confirm(ft: FeatureTable, engineer: User) -> None:
    data = normalise(ft.data)
    if not data["features"]:
        raise FeatureTableError("Add at least one feature before confirming.")
    missing = unconfirmed_cells(data)
    if missing:
        more = f" (+{len(missing) - 5} more)" if len(missing) > 5 else ""
        raise FeatureTableError(
            "Every value must be entered and ticked as confirmed. Missing: "
            + "; ".join(missing[:5])
            + more
        )
    ft.data = data
    ft.status = FeatureTableStatus.CONFIRMED.value
    ft.confirmed_by = engineer.id
    ft.confirmed_by_name = engineer.full_name or engineer.username
    ft.confirmed_at = datetime.now(UTC)
    ft.confirmed_hash = data_hash(data)


def feature_table_problem(db: Session, part_number: str) -> str | None:
    """None if an engineer-confirmed, unchanged feature table exists for this part."""
    ft = db.scalar(select(FeatureTable).where(FeatureTable.part_number == part_number))
    if ft is None:
        return (
            f"No feature table for part {part_number}. An engineer must create and confirm one "
            "(Parts page)."
        )
    if ft.status != FeatureTableStatus.CONFIRMED.value:
        return f"The feature table for part {part_number} is not confirmed by an engineer yet."
    if ft.confirmed_hash != data_hash(ft.data):
        return f"The feature table for part {part_number} changed after it was confirmed."
    return None


def _num(v: CellValue) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def _fmt(v: float) -> str:
    return f"{v:g}"


def build_inspection_plan(data: dict[str, Any]) -> list[dict[str, Any]]:
    """First-piece measurement rows from a feature table (fixed rules, no AI).

    The tolerance of a feature applies to its first (main) dimension, e.g. an OD's diameter.
    Its other dimensions are listed with their nominal only. Tolerances are signed values
    added to the nominal (e.g. +0 / -0.05), so the limits are never guessed.
    """
    rows: list[dict[str, Any]] = []
    length = _num(data["header"]["overall_length"]["value"])
    if length is not None:
        rows.append(
            {"feature": "Overall length", "nominal": length, "unit": "mm", "min": None, "max": None}
        )
    for n, f in enumerate(data["features"], start=1):
        label, fields = FEATURE_TYPES[f["type"]]
        short = label.split(" (")[0]
        cells = f["fields"]
        if f["type"] == "thread":
            size = cells["size"]["value"]
            cls = cells["tol_class"]["value"]
            pitch = _num(cells["pitch"]["value"])
            desc = " ".join(str(x) for x in (size, f"x {_fmt(pitch)}" if pitch else None, cls) if x)
            rows.append(
                {
                    "feature": f"{n}. Thread {desc}".strip(),
                    "nominal": None,
                    "unit": "gauge",
                    "min": None,
                    "max": None,
                }
            )
            if (tl := _num(cells["length"]["value"])) is not None:
                rows.append(
                    {
                        "feature": f"{n}. Thread length",
                        "nominal": tl,
                        "unit": "mm",
                        "min": None,
                        "max": None,
                    }
                )
            continue
        tp, tm = _num(cells.get("tol_plus", {}).get("value")), _num(
            cells.get("tol_minus", {}).get("value")
        )
        dims = [(k, flabel, kind) for k, flabel, kind in fields if kind in ("mm", "deg")]
        for i, (key, flabel, kind) in enumerate(dims):
            nominal = _num(cells[key]["value"])
            if nominal is None:
                continue
            lo = hi = None
            if i == 0 and tp is not None and tm is not None:
                lo, hi = sorted((round(nominal + tm, 6), round(nominal + tp, 6)))
            rows.append(
                {
                    "feature": f"{n}. {short} {flabel.lower()}",
                    "nominal": nominal,
                    "unit": "°" if kind == "deg" else "mm",
                    "min": lo,
                    "max": hi,
                }
            )
    return rows


def inspection_plan(db: Session, part_number: str) -> list[dict[str, Any]]:
    """Measurement rows for the first piece, only from a CONFIRMED, unchanged feature table."""
    ft = db.scalar(select(FeatureTable).where(FeatureTable.part_number == part_number))
    if ft is None or feature_table_problem(db, part_number) is not None:
        return []
    return build_inspection_plan(ft.data)


def required_material(db: Session, part_number: str) -> dict[str, Any] | None:
    """Material grade and bar diameter from a CONFIRMED feature table, if any."""
    ft = db.scalar(select(FeatureTable).where(FeatureTable.part_number == part_number))
    if ft is None or ft.status != FeatureTableStatus.CONFIRMED.value:
        return None
    h = ft.data["header"]
    return {
        "material_grade": h["material_grade"]["value"],
        "bar_diameter": h["bar_diameter"]["value"],
        "overall_length": h["overall_length"]["value"],
    }
