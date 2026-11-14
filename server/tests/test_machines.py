from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import LIMIT_KEYS, AuditLog, Machine
from app.seed import REAL_MACHINES, machine_key, run_seed

H = dict[str, dict[str, str]]


@pytest.fixture
def seeded(settings: Settings, db: Session) -> Machine:
    run_seed(settings, db)
    m = db.scalar(select(Machine).where(Machine.key == "lmw-lx20tl3-l110-00542"))
    assert m is not None
    return m


def _new_machine(client: TestClient, h: H, **extra: Any) -> dict[str, Any]:
    body = {"key": "test-lathe", "name": "Test Lathe", **extra}
    r = client.post("/api/machines", headers=h["admin"], json=body)
    assert r.status_code == 201, r.text
    return dict(r.json())


def test_real_seed_is_exactly_the_six_nameplate_machines(
    client: TestClient, role_headers: H, seeded: Machine
) -> None:
    r = client.get("/api/machines", headers=role_headers["operator"])
    keys = sorted(m["key"] for m in r.json())
    assert keys == sorted(machine_key(t, s) for t, s, _, _ in REAL_MACHINES)
    assert len(keys) == 6
    assert not any("sim" in k or k == "lmw-lathe-1" for k in keys)  # no demo machines


def test_seeded_machine_has_only_nameplate_data(
    client: TestClient, role_headers: H, seeded: Machine
) -> None:
    r = client.get(f"/api/machines/{seeded.id}", headers=role_headers["operator"])
    assert r.status_code == 200
    m = r.json()
    assert m["model"] == "LX20TL3"
    assert "L110-00542" in m["name"] and "29.04.2018" in m["notes"]
    assert m["controller"] == "FANUC 0i-TF"  # confirmed from the CNC panel photo
    assert m["focas_port"] == 8193
    assert m["remote_control_enabled"] is False  # safety rule 9
    assert m["ip_address"] is None
    assert all(v is None for v in m["limits"].values())
    assert sorted(m["limits_missing"]) == sorted(LIMIT_KEYS)


def test_seed_is_idempotent(settings: Settings, db: Session, seeded: Machine) -> None:
    run_seed(settings, db)
    assert len(db.scalars(select(Machine)).all()) == 6


def test_new_machine_defaults_are_safe(client: TestClient, role_headers: H) -> None:
    m = _new_machine(client, role_headers)
    assert m["remote_control_enabled"] is False
    assert m["focas_port"] == 8193
    assert m["status"] == "in_service"


@pytest.mark.parametrize(
    ("patch", "fragment"),
    [
        ({"ip_address": "192.168.1.300"}, "not a valid IP"),
        ({"focas_port": 70000}, "focas_port"),
        ({"limits": {"spindle_rpm_min": 3000, "spindle_rpm_max": 100}}, "Minimum spindle speed"),
        ({"limits": {"max_turning_diameter": -5}}, "max_turning_diameter"),
        ({"limits": {"made_up_limit": 1}}, "made_up_limit"),
        ({"status": "exploded"}, "status"),
    ],
)
def test_machine_validation(
    client: TestClient, role_headers: H, patch: dict[str, Any], fragment: str
) -> None:
    m = _new_machine(client, role_headers)
    r = client.patch(f"/api/machines/{m['id']}", headers=role_headers["admin"], json=patch)
    assert r.status_code == 422
    assert fragment in r.text


def test_update_limits_and_ip(client: TestClient, role_headers: H) -> None:
    m = _new_machine(client, role_headers)
    r = client.patch(
        f"/api/machines/{m['id']}",
        headers=role_headers["admin"],
        json={
            "ip_address": "10.0.0.5",
            "limits": {"max_turning_diameter": 200, "turret_stations": 8},
        },
    )
    assert r.status_code == 200
    out = r.json()
    assert out["ip_address"] == "10.0.0.5"
    assert out["limits"]["max_turning_diameter"] == 200
    assert "max_turning_diameter" not in out["limits_missing"]
    assert "max_turning_length" in out["limits_missing"]


def test_duplicate_key_rejected(client: TestClient, role_headers: H) -> None:
    _new_machine(client, role_headers)
    r = client.post(
        "/api/machines", headers=role_headers["admin"], json={"key": "test-lathe", "name": "x"}
    )
    assert r.status_code == 409


def test_remote_control_change_is_audited_separately(
    client: TestClient, role_headers: H, db: Session
) -> None:
    m = _new_machine(client, role_headers)
    client.patch(
        f"/api/machines/{m['id']}",
        headers=role_headers["admin"],
        json={"remote_control_enabled": True},
    )
    rows = db.scalars(select(AuditLog).where(AuditLog.action == "remote_control_changed")).all()
    assert len(rows) == 1 and rows[0].payload == {"remote_control_enabled": True}


def test_tool_crud(client: TestClient, role_headers: H, db: Session) -> None:
    m = _new_machine(client, role_headers, limits={"turret_stations": 8})
    base = f"/api/machines/{m['id']}/tools"
    tool = {"station": 1, "tool_code": "T0101", "description": "32 U-drill", "tool_type": "drill"}
    r = client.post(base, headers=role_headers["programmer"], json=tool)
    assert r.status_code == 201, r.text
    tid = r.json()["id"]
    # duplicate code
    assert client.post(base, headers=role_headers["programmer"], json=tool).status_code == 409
    # bad code / station beyond turret / bad type
    for bad in (
        {**tool, "tool_code": "T101"},
        {**tool, "tool_code": "T0909", "station": 9},
        {**tool, "tool_code": "T0202", "tool_type": "laser"},
    ):
        assert client.post(base, headers=role_headers["admin"], json=bad).status_code == 422
    r = client.put(
        f"{base}/{tid}",
        headers=role_headers["admin"],
        json={**tool, "nose_radius": 0.8, "insert_type": "WNMG"},
    )
    assert r.status_code == 200 and r.json()["nose_radius"] == 0.8
    assert len(client.get(base, headers=role_headers["operator"]).json()) == 1
    assert client.delete(f"{base}/{tid}", headers=role_headers["admin"]).status_code == 204
    assert client.get(base, headers=role_headers["operator"]).json() == []
    actions = {a.action for a in db.scalars(select(AuditLog))}
    assert {"tool_add", "tool_update", "tool_delete"} <= actions


def test_cannot_shrink_turret_below_used_station(client: TestClient, role_headers: H) -> None:
    m = _new_machine(client, role_headers)
    client.post(
        f"/api/machines/{m['id']}/tools",
        headers=role_headers["admin"],
        json={"station": 10, "tool_code": "T1010", "tool_type": "bore"},
    )
    r = client.patch(
        f"/api/machines/{m['id']}",
        headers=role_headers["admin"],
        json={"limits": {"turret_stations": 8}},
    )
    assert r.status_code == 422 and "T1010" in r.text


def test_delete_machine(client: TestClient, role_headers: H) -> None:
    m = _new_machine(client, role_headers)
    assert (
        client.delete(f"/api/machines/{m['id']}", headers=role_headers["admin"]).status_code == 204
    )
    assert client.get(f"/api/machines/{m['id']}", headers=role_headers["admin"]).status_code == 404


def test_seeded_smarturn_04927_has_its_ip_from_the_cnc(settings: Settings, db: Session) -> None:
    run_seed(settings, db)
    m = db.scalar(select(Machine).where(Machine.key == "lmw-smarturn-55-04927"))
    assert m is not None and m.ip_address == "192.168.11.12" and m.focas_port == 8193
