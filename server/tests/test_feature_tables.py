"""Feature tables (Milestone 12) and the AI boundary (safety rule 2)."""

import ast
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai.drawing_reader import DrawingReader, StubDrawingReader
from app.gcode.generator import ProgramGenerator
from app.services.feature_tables import feature_table_problem

H = dict[str, dict[str, str]]


def cell(v: Any, confirmed: bool = True, ai: Any = None) -> dict[str, Any]:
    return {"ai": ai, "value": v, "confirmed": confirmed}


def full_data() -> dict[str, Any]:
    return {
        "header": {
            "material_grade": cell("EN8"),
            "bar_diameter": cell(50.0),
            "overall_length": cell(27.0),
        },
        "features": [
            {
                "type": "od",
                "fields": {
                    "diameter": cell(44.7),
                    "length": cell(26.0),
                    "tol_plus": cell(0.0),
                    "tol_minus": cell(-0.05),
                },
            },
            {
                "type": "thread",
                "fields": {
                    "size": cell("M24"),
                    "pitch": cell(1.5),
                    "length": cell(12.0),
                    "tol_class": cell("6g"),
                },
            },
        ],
    }


def create(client: TestClient, h: H, part: str = "3773480M01") -> dict[str, Any]:
    r = client.post("/api/feature-tables", headers=h["engineer"], json={"part_number": part})
    assert r.status_code == 201, r.text
    return dict(r.json())


def test_create_by_hand_fill_confirm(client: TestClient, role_headers: H, db: Session) -> None:
    ft = create(client, role_headers)
    assert ft["status"] == "draft" and ft["source"] == "manual"
    assert all(c["value"] is None for c in ft["data"]["header"].values())
    assert "Material grade" in ft["unconfirmed"]
    assert feature_table_problem(db, "3773480M01") is not None

    r = client.put(
        f"/api/feature-tables/{ft['id']}",
        headers=role_headers["engineer"],
        json={"data": full_data()},
    )
    assert r.status_code == 200 and r.json()["unconfirmed"] == []
    r = client.post(f"/api/feature-tables/{ft['id']}/confirm", headers=role_headers["engineer"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "confirmed" and body["confirmed_by_name"] and body["confirmed_at"]
    db.expire_all()
    assert feature_table_problem(db, "3773480M01") is None


def test_confirm_requires_every_value_confirmed(client: TestClient, role_headers: H) -> None:
    ft = create(client, role_headers)
    data = full_data()
    data["features"][0]["fields"]["tol_minus"] = cell(-0.05, confirmed=False)
    client.put(
        f"/api/feature-tables/{ft['id']}", headers=role_headers["engineer"], json={"data": data}
    )
    r = client.post(f"/api/feature-tables/{ft['id']}/confirm", headers=role_headers["engineer"])
    assert r.status_code == 422 and "Tolerance -" in r.json()["detail"]
    data["features"] = []
    data["features"].clear()
    client.put(
        f"/api/feature-tables/{ft['id']}", headers=role_headers["engineer"], json={"data": data}
    )
    r = client.post(f"/api/feature-tables/{ft['id']}/confirm", headers=role_headers["engineer"])
    assert r.status_code == 422 and "at least one feature" in r.json()["detail"]


def test_any_change_clears_confirmation(client: TestClient, role_headers: H, db: Session) -> None:
    ft = create(client, role_headers)
    h = role_headers["engineer"]
    client.put(f"/api/feature-tables/{ft['id']}", headers=h, json={"data": full_data()})
    client.post(f"/api/feature-tables/{ft['id']}/confirm", headers=h)
    changed = full_data()
    changed["header"]["bar_diameter"] = cell(52.0)
    r = client.put(f"/api/feature-tables/{ft['id']}", headers=h, json={"data": changed})
    assert r.json()["status"] == "draft" and r.json()["confirmed_by_name"] is None
    db.expire_all()
    assert "not confirmed" in (feature_table_problem(db, "3773480M01") or "")


@pytest.mark.parametrize(
    ("mutate", "fragment"),
    [
        (lambda d: d["features"].append({"type": "laser", "fields": {}}), "Unknown feature type"),
        (
            lambda d: d["features"][0]["fields"].update({"diameter": cell(-5.0)}),
            "cannot be negative",
        ),
        (lambda d: d["features"][1]["fields"].update({"pitch": cell("fine")}), "must be a number"),
        (lambda d: d["header"].update({"colour": cell("red")}), "Unknown header fields"),
        (lambda d: d["features"][0]["fields"].update({"angle": cell(30.0)}), "unknown fields"),
    ],
)
def test_validation(client: TestClient, role_headers: H, mutate: Any, fragment: str) -> None:
    ft = create(client, role_headers)
    data = full_data()
    mutate(data)
    r = client.put(
        f"/api/feature-tables/{ft['id']}", headers=role_headers["engineer"], json={"data": data}
    )
    assert r.status_code == 422 and fragment in r.text


def test_duplicate_part_number(client: TestClient, role_headers: H) -> None:
    create(client, role_headers)
    r = client.post(
        "/api/feature-tables", headers=role_headers["engineer"], json={"part_number": "3773480M01"}
    )
    assert r.status_code == 409


def test_only_engineers_edit_and_confirm(client: TestClient, role_headers: H) -> None:
    ft = create(client, role_headers)
    for who in ("admin", "programmer", "operator"):
        h = role_headers[who]
        assert (
            client.put(
                f"/api/feature-tables/{ft['id']}", headers=h, json={"data": full_data()}
            ).status_code
            == 403
        )
        assert client.post(f"/api/feature-tables/{ft['id']}/confirm", headers=h).status_code == 403
    assert (
        client.get(f"/api/feature-tables/{ft['id']}", headers=role_headers["operator"]).status_code
        == 200
    )


def test_schema_lists_all_feature_types(client: TestClient, role_headers: H) -> None:
    s = client.get("/api/feature-tables/schema", headers=role_headers["operator"]).json()
    types = {t["type"] for t in s["feature_types"]}
    assert types == {"od", "bore", "face", "chamfer", "radius", "groove", "thread", "drill"}
    assert [h["key"] for h in s["header"]] == ["material_grade", "bar_diameter", "overall_length"]
    for t in s["feature_types"]:
        keys = {f["key"] for f in t["fields"]}
        assert ("tol_plus" in keys and "tol_minus" in keys) or "tol_class" in keys


# ---------------------------------------------------------------- AI boundary (rule 2)


def test_drawing_reader_stub_returns_empty_table() -> None:
    data = StubDrawingReader().read(b"%PDF-1.4 fake", "part.pdf").model_dump()
    assert data["features"] == []
    assert all(c["ai"] is None and c["value"] is None for c in data["header"].values())


def test_reader_output_never_sets_confirmed_values(
    client: TestClient, role_headers: H, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api import feature_tables as api_mod
    from app.services.feature_tables import TableData

    class SneakyReader(DrawingReader):
        def read(self, file: bytes, filename: str = "") -> TableData:
            return TableData.model_validate(full_data())  # tries to fill AND confirm values

    monkeypatch.setattr(api_mod, "get_drawing_reader", lambda: SneakyReader())
    r = client.post(
        "/api/feature-tables/from-drawing",
        headers=role_headers["engineer"],
        data={"part_number": "P-AI-1"},
        files={"file": ("p.pdf", b"x")},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["source"] == "drawing_reader" and body["status"] == "draft"
    cells = list(body["data"]["header"].values()) + [
        c for f in body["data"]["features"] for c in f["fields"].values()
    ]
    assert all(c["value"] is None and c["confirmed"] is False for c in cells)


def test_ai_package_cannot_touch_programs() -> None:
    forbidden = (
        "app.services.program_store",
        "app.gcode",
        "app.services.run_control",
        "app.api.programs",
    )
    pkg = Path(__file__).resolve().parents[1] / "app" / "ai"
    for path in pkg.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            for name in names:
                assert not name.startswith(forbidden), f"{path.name} imports {name}"


def test_program_generator_is_an_empty_interface() -> None:
    with pytest.raises(TypeError):
        ProgramGenerator()  # type: ignore[abstract]


def test_dev_seed_demo_table_has_confirmation_time(settings: object, db: Session) -> None:
    from sqlalchemy import select

    from app.config import Settings
    from app.db.models import FeatureTable
    from app.seed import run_seed

    assert isinstance(settings, Settings)
    run_seed(settings.model_copy(update={"seed_dev_data": True}), db)
    ft = db.scalars(select(FeatureTable).where(FeatureTable.part_number == "DEMO-SIM-001")).one()
    assert ft.confirmed_at is not None and ft.confirmed_by_name


def test_inspection_plan_from_feature_table() -> None:
    from app.services.feature_tables import build_inspection_plan, normalise

    rows = build_inspection_plan(normalise(full_data()))
    assert rows == [
        {"feature": "Overall length", "nominal": 27.0, "unit": "mm", "min": None, "max": None},
        # tolerance applies to the main dimension only; signed values are added, never guessed
        {"feature": "1. OD diameter", "nominal": 44.7, "unit": "mm", "min": 44.65, "max": 44.7},
        {"feature": "1. OD length", "nominal": 26.0, "unit": "mm", "min": None, "max": None},
        {
            "feature": "2. Thread M24 x 1.5 6g",
            "nominal": None,
            "unit": "gauge",
            "min": None,
            "max": None,
        },
        {"feature": "2. Thread length", "nominal": 12.0, "unit": "mm", "min": None, "max": None},
    ]


def test_inspection_plan_empty_unless_confirmed(
    client: TestClient, role_headers: H, db: Session
) -> None:
    from app.services.feature_tables import inspection_plan

    ft = create(client, role_headers)
    assert inspection_plan(db, "3773480M01") == []
    r = client.put(
        f"/api/feature-tables/{ft['id']}",
        headers=role_headers["engineer"],
        json={"data": full_data()},
    )
    assert r.status_code == 200, r.text
    assert inspection_plan(db, "3773480M01") == []  # saved but not confirmed
    r = client.post(f"/api/feature-tables/{ft['id']}/confirm", headers=role_headers["engineer"])
    assert r.status_code == 200, r.text
    db.expire_all()
    assert len(inspection_plan(db, "3773480M01")) == 5
