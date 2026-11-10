"""Raw material register import from CSV / XLSX with a configurable column mapping.

Pure functions (no DB) so they are easy to test:
    parse_table(data, filename) -> Table (headers + rows)
    suggest_mapping(headers)    -> {target_field: source_header}
    map_rows(table, mapping)    -> list[RowResult]
"""

import csv
import io
import re
from dataclasses import dataclass, field

from openpyxl import load_workbook

TARGET_FIELDS = ("grade", "bar_diameter", "available_length", "stock_quantity", "notes")
REQUIRED_FIELDS = ("grade", "bar_diameter")

# Header aliases used to suggest a mapping (lower-case, spaces/punctuation collapsed).
ALIASES: dict[str, tuple[str, ...]] = {
    "grade": ("grade", "material grade", "material", "mat grade", "steel grade"),
    "bar_diameter": (
        "bar diameter",
        "bar dia",
        "bar dia mm",
        "bar diameter mm",
        "diameter",
        "dia",
        "dia mm",
        "size",
        "od",
    ),
    "available_length": (
        "available length",
        "length",
        "bar length",
        "bar length mm",
        "length mm",
    ),
    "stock_quantity": ("stock quantity", "quantity", "qty", "stock", "nos", "no of bars"),
    "notes": ("notes", "remarks", "remark", "comment", "comments"),
}

MAX_ROWS = 10_000
_NUM = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


class ImportFileError(ValueError):
    """The file cannot be read at all (wrong type, empty, corrupt)."""


@dataclass
class Table:
    headers: list[str]
    rows: list[list[str]]


@dataclass
class MaterialData:
    grade: str
    bar_diameter: float
    available_length: float | None = None
    stock_quantity: float | None = None
    notes: str = ""


@dataclass
class RowResult:
    row_number: int  # 1-based line number in the file, header = 1
    data: MaterialData | None = None
    errors: list[str] = field(default_factory=list)


def _norm(header: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", header.lower()).split())


def _cell(v: object) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _parse_csv(data: bytes) -> list[list[str]]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")
    try:
        dialect: type[csv.Dialect] | csv.Dialect = csv.Sniffer().sniff(
            text[:4096], delimiters=",;\t"
        )
    except csv.Error:
        dialect = csv.excel
    return [[c.strip() for c in row] for row in csv.reader(io.StringIO(text), dialect)]


def _parse_xlsx(data: bytes) -> list[list[str]]:
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:  # openpyxl raises many types for bad files
        raise ImportFileError("This does not look like a valid .xlsx file.") from e
    ws = wb.worksheets[0]
    rows = [[_cell(v) for v in row] for row in ws.iter_rows(values_only=True)]
    wb.close()
    return rows


def parse_table(data: bytes, filename: str) -> Table:
    name = filename.lower()
    if name.endswith(".csv") or name.endswith(".txt"):
        raw = _parse_csv(data)
    elif name.endswith(".xlsx"):
        raw = _parse_xlsx(data)
    else:
        raise ImportFileError("Upload a .csv or .xlsx file.")
    raw = [r for r in raw if any(c for c in r)]
    if not raw:
        raise ImportFileError("The file is empty.")
    if len(raw) - 1 > MAX_ROWS:
        raise ImportFileError(f"Too many rows (limit {MAX_ROWS}).")
    headers = raw[0]
    width = len(headers)
    rows = [(r + [""] * width)[:width] for r in raw[1:]]
    return Table(headers=headers, rows=rows)


def suggest_mapping(headers: list[str]) -> dict[str, str | None]:
    normalised = {_norm(h): h for h in headers}
    out: dict[str, str | None] = {}
    for target, aliases in ALIASES.items():
        out[target] = next((normalised[a] for a in aliases if a in normalised), None)
    return out


def _number(raw: str, label: str, errors: list[str], positive: bool = True) -> float | None:
    if raw == "":
        return None
    m = _NUM.search(raw)
    if m is None:
        errors.append(f"{label}: '{raw}' is not a number")
        return None
    value = float(m.group().replace(",", "."))
    if positive and value <= 0:
        errors.append(f"{label}: must be greater than 0 (got {raw})")
        return None
    if not positive and value < 0:
        errors.append(f"{label}: cannot be negative (got {raw})")
        return None
    return value


def validate_mapping(table: Table, mapping: dict[str, str | None]) -> list[str]:
    problems = []
    for key in mapping:
        if key not in TARGET_FIELDS:
            problems.append(f"Unknown field '{key}'.")
    for req in REQUIRED_FIELDS:
        col = mapping.get(req)
        if not col:
            problems.append(f"Choose which column holds '{req}'.")
        elif col not in table.headers:
            problems.append(f"Column '{col}' (for '{req}') is not in the file.")
    for key, col in mapping.items():
        if key not in REQUIRED_FIELDS and col and col not in table.headers:
            problems.append(f"Column '{col}' (for '{key}') is not in the file.")
    return problems


def map_rows(table: Table, mapping: dict[str, str | None]) -> list[RowResult]:
    idx = {k: table.headers.index(v) for k, v in mapping.items() if v and v in table.headers}

    def get(row: list[str], key: str) -> str:
        return row[idx[key]].strip() if key in idx else ""

    results = []
    for i, row in enumerate(table.rows, start=2):
        errors: list[str] = []
        grade = get(row, "grade")
        if not grade:
            errors.append("grade: missing")
        dia = _number(get(row, "bar_diameter"), "bar diameter", errors)
        if dia is None and not any(e.startswith("bar diameter") for e in errors):
            errors.append("bar diameter: missing")
        length = _number(get(row, "available_length"), "length", errors)
        qty = _number(get(row, "stock_quantity"), "quantity", errors, positive=False)
        if errors or dia is None:
            results.append(RowResult(row_number=i, errors=errors))
            continue
        results.append(
            RowResult(
                row_number=i,
                data=MaterialData(
                    grade=grade[:64],
                    bar_diameter=dia,
                    available_length=length,
                    stock_quantity=qty,
                    notes=get(row, "notes")[:2000],
                ),
            )
        )
    return results
