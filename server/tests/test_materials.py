import io
import json
from typing import Any

from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import AuditLog, Material
from app.seed import run_seed
from app.services.material_import import map_rows, parse_table, suggest_mapping
from tests.conftest import REPO_DIR

H = dict[str, dict[str, str]]
SAMPLE = REPO_DIR / "samples" / "materials" / "raw-material-register.sample.csv"


def _upload(
    client: TestClient,
    h: dict[str, str],
    content: bytes,
    name: str = "stock.csv",
    path: str = "/api/materials/import",
    **form: Any,
) -> Any:
    data = {k: (json.dumps(v) if isinstance(v, dict) else str(v)) for k, v in form.items()}
    return client.post(path, headers=h, files={"file": (name, content)}, data=data)


# ---------- pure parsing ----------


def test_sample_csv_parses_with_suggested_mapping() -> None:
    table = parse_table(SAMPLE.read_bytes(), SAMPLE.name)
    mapping = suggest_mapping(table.headers)
    assert mapping == {
        "grade": "Material Grade",
        "bar_diameter": "Bar Dia (mm)",
        "available_length": "Bar Length (mm)",
        "stock_quantity": "Qty",
        "notes": "Remarks",
    }
    rows = map_rows(table, mapping)
    assert all(r.data for r in rows) and len(rows) == 8
    assert all("SAMPLE DATA" in r.data.notes for r in rows if r.data)


def test_number_formats_and_row_errors() -> None:
    csv = "grade;dia;qty\nEN8;Ø25 mm;3\nEN8;25,5;x\n;30;1\nC45;-4;1\n".encode()
    rows = map_rows(
        parse_table(csv, "a.csv"),
        {"grade": "grade", "bar_diameter": "dia", "stock_quantity": "qty"},
    )
    assert rows[0].data is not None and rows[0].data.bar_diameter == 25.0
    assert rows[1].errors == ["quantity: 'x' is not a number"]
    assert rows[2].errors == ["grade: missing"]
    assert "must be greater than 0" in rows[3].errors[0]


# ---------- API ----------


def test_preview_suggests_mapping(client: TestClient, role_headers: H) -> None:
    r = _upload(
        client, role_headers["engineer"], SAMPLE.read_bytes(), path="/api/materials/import/preview"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["row_count"] == 8
    assert body["suggested_mapping"]["bar_diameter"] == "Bar Dia (mm)"


def test_import_sample_then_duplicates_skip_and_update(
    client: TestClient, role_headers: H, db: Session
) -> None:
    h = role_headers["engineer"]
    r = _upload(client, h, SAMPLE.read_bytes())
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 8 and r.json()["errors"] == 0

    # Same file again: every row is a duplicate -> skipped by default, nothing changes.
    r = _upload(client, h, SAMPLE.read_bytes())
    assert r.json()["created"] == 0 and r.json()["skipped"] == 8

    # Update mode: grade spelt differently still matches ("en 8" == "EN8").
    r = _upload(client, h, b"Grade,Dia,Qty\nen 8,28,99\n", on_duplicate="update")
    assert r.json()["updated"] == 1
    m = db.scalar(select(Material).where(Material.bar_diameter == 28))
    assert m is not None and m.stock_quantity == 99
    assert len(db.scalars(select(Material)).all()) == 8
    assert db.scalars(select(AuditLog).where(AuditLog.action == "material_import")).all()


def test_duplicate_rows_inside_one_file(client: TestClient, role_headers: H) -> None:
    r = _upload(client, role_headers["admin"], b"grade,dia\nEN8,30\nEN8 ,30\nEN8,31\n")
    body = r.json()
    assert body["created"] == 2
    assert [x["status"] for x in body["rows"]] == ["created", "duplicate_in_file", "created"]


def test_custom_mapping_and_xlsx(client: TestClient, role_headers: H) -> None:
    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.append(["Spec", "OD", "Pieces"])
    ws.append(["SS304", 30, 3])
    ws.append(["EN1A", 25.0, 20])
    buf = io.BytesIO()
    wb.save(buf)
    mapping = {"grade": "Spec", "bar_diameter": "OD", "stock_quantity": "Pieces"}
    r = _upload(client, role_headers["admin"], buf.getvalue(), name="reg.xlsx", mapping=mapping)
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 2


def test_bad_mapping_and_bad_files(client: TestClient, role_headers: H) -> None:
    h = role_headers["admin"]
    r = _upload(client, h, b"a,b\n1,2\n", mapping={"grade": "a"})
    assert r.status_code == 422 and "bar_diameter" in r.json()["detail"]
    r = _upload(client, h, b"a,b\n1,2\n", mapping={"grade": "nope", "bar_diameter": "b"})
    assert r.status_code == 422 and "not in the file" in r.json()["detail"]
    assert _upload(client, h, b"x", name="stock.pdf").status_code == 422
    assert _upload(client, h, b"", name="stock.csv").status_code == 422
    assert _upload(client, h, b"garbage", name="stock.xlsx").status_code == 422


def test_dry_run_changes_nothing(client: TestClient, role_headers: H, db: Session) -> None:
    r = _upload(client, role_headers["admin"], SAMPLE.read_bytes(), dry_run="true")
    assert r.json()["created"] == 8 and r.json()["dry_run"] is True
    assert db.scalars(select(Material)).all() == []


def test_search(client: TestClient, role_headers: H) -> None:
    _upload(client, role_headers["admin"], SAMPLE.read_bytes())
    h = role_headers["operator"]
    grades = {m["grade"] for m in client.get("/api/materials?q=en8", headers=h).json()}
    assert grades == {"EN8"}
    r = client.get("/api/materials?diameter_min=40&diameter_max=45", headers=h).json()
    assert sorted(m["bar_diameter"] for m in r) == [40, 45]
    assert len(client.get("/api/materials?q=SAMPLE", headers=h).json()) == 8


def test_crud_and_duplicate_conflict(client: TestClient, role_headers: H) -> None:
    h = role_headers["engineer"]
    body = {"grade": "EN8", "bar_diameter": 32, "stock_quantity": 4}
    r = client.post("/api/materials", headers=h, json=body)
    assert r.status_code == 201
    mid = r.json()["id"]
    assert (
        client.post("/api/materials", headers=h, json={**body, "grade": "en8"}).status_code == 409
    )
    r = client.put(f"/api/materials/{mid}", headers=h, json={**body, "stock_quantity": 2})
    assert r.json()["stock_quantity"] == 2
    assert (
        client.post(
            "/api/materials", headers=h, json={"grade": "x", "bar_diameter": -1}
        ).status_code
        == 422
    )
    assert client.delete(f"/api/materials/{mid}", headers=h).status_code == 204


def test_dev_seed_loads_sample_materials_once(settings: Settings, db: Session) -> None:
    s = settings.model_copy(update={"seed_dev_data": True})
    log = run_seed(s, db)
    assert any("8 SAMPLE materials" in x for x in log)
    run_seed(s, db)
    assert len(db.scalars(select(Material)).all()) == 8
