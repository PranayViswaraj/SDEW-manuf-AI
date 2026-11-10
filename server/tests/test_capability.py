"""Capability check: pass, fail and unknown cases (never assume capable)."""

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import FeatureTable, Machine, Tool, empty_limits
from app.seed import SIM_LIMITS, run_seed
from app.services.capability_check import UNKNOWN_LIMITS, availability, check_capability


def cell(v: Any) -> dict[str, Any]:
    return {"ai": None, "value": v, "confirmed": True}


def part(bar: float = 45.0, length: float = 20.0, *features: dict[str, Any]) -> dict[str, Any]:
    return {
        "header": {
            "material_grade": cell("EN8"),
            "bar_diameter": cell(bar),
            "overall_length": cell(length),
        },
        "features": list(features)
        or [{"type": "od", "fields": {"diameter": cell(40.0), "length": cell(20.0)}}],
    }


def feat(ftype: str, **fields: float) -> dict[str, Any]:
    return {"type": ftype, "fields": {k: cell(v) for k, v in fields.items()}}


def machine(
    limits: dict[str, Any] | None = None, tools: tuple[str, ...] = ("od_rough", "od_finish")
) -> Machine:
    m = Machine(
        key="m",
        name="M",
        status="in_service",
        limits=limits if limits is not None else dict(SIM_LIMITS),
    )
    m.tools = [
        Tool(station=i + 1, tool_code=f"T{i + 1:02d}{i + 1:02d}", tool_type=t)
        for i, t in enumerate(tools)
    ]
    return m


def test_capable_when_everything_known_and_within_limits() -> None:
    r = check_capability(part(), machine())
    assert r.verdict == "capable" and r.capable
    assert all(x.status == "pass" for x in r.reasons)


def test_unknown_limits_are_never_capable() -> None:
    r = check_capability(part(), machine(limits=empty_limits()))
    assert r.verdict == "unknown" and not r.capable
    assert r.to_dict()["summary"] == UNKNOWN_LIMITS
    partial = dict(SIM_LIMITS, max_turning_length=None)
    assert check_capability(part(), machine(limits=partial)).verdict == "unknown"


def test_empty_tool_list_is_unknown() -> None:
    r = check_capability(part(), machine(tools=()))
    assert r.verdict == "unknown"
    assert any("tool list is not entered" in x.message for x in r.reasons)


@pytest.mark.parametrize(
    ("data", "fragment"),
    [
        (part(bar=60.0), "bar diameter 60 mm is more than the machine's 52 mm"),
        (part(45.0, 350.0), "overall length 350 mm"),
        (part(45.0, 20.0, feat("od", diameter=250.0, length=5.0)), "largest diameter 250 mm"),
    ],
)
def test_limits_exceeded(data: dict[str, Any], fragment: str) -> None:
    r = check_capability(data, machine())
    assert r.verdict == "not_capable"
    assert any(fragment in x.message for x in r.reasons if x.status == "fail")


def test_missing_tool_for_feature_fails() -> None:
    data = part(
        45.0, 20.0, feat("od", diameter=40.0, length=20.0), feat("thread", pitch=1.5, length=10.0)
    )
    r = check_capability(data, machine(tools=("od_rough",)))
    assert r.verdict == "not_capable"
    assert any("Thread needs a threading tool" in x.message for x in r.reasons)


def test_bore_needs_boring_bar_and_drill() -> None:
    data = part(45.0, 20.0, feat("bore", diameter=20.0, depth=15.0))
    r = check_capability(data, machine(tools=("od_rough", "bore")))
    assert r.verdict == "not_capable" and any(
        "drill" in x.message for x in r.reasons if x.status == "fail"
    )
    assert check_capability(data, machine(tools=("od_rough", "bore", "drill"))).capable


def test_fail_beats_unknown_and_retired_machine_fails() -> None:
    m = machine(limits=dict(empty_limits(), max_bar_diameter=30.0))
    assert check_capability(part(bar=45.0), m).verdict == "not_capable"
    retired = machine()
    retired.status = "retired"
    assert check_capability(part(), retired).verdict == "not_capable"


def test_availability_needs_online_idle_no_alarm() -> None:
    online = {
        "state": "online",
        "status": {"run_state": "idle", "alarm": False, "emergency": False},
    }
    assert availability(online) == (True, [])
    assert availability({"state": "offline", "status": None})[0] is False
    assert availability({"state": "stale", "status": {}})[0] is False
    busy = {
        "state": "online",
        "status": {"run_state": "running", "alarm": True, "emergency": False},
    }
    ok, why = availability(busy)
    assert not ok and len(why) == 2


def test_endpoint_lists_available_and_excluded(
    app: FastAPI,
    client: TestClient,
    role_headers: dict[str, dict[str, str]],
    settings: Settings,
    db: Session,
) -> None:
    run_seed(settings.model_copy(update={"seed_dev_data": True}), db)
    ft = db.scalars(select(FeatureTable).where(FeatureTable.part_number == "DEMO-SIM-001")).one()
    sim = db.scalars(select(Machine).where(Machine.key == "sim-lathe-dev")).one()
    h = role_headers["engineer"]

    # Bridge offline: SIM lathe is capable but excluded as offline; LMW unknown.
    body = client.get(f"/api/capability?feature_table_id={ft.id}", headers=h).json()
    assert body["available"] == []
    by_name = {r["machine_name"]: r for r in body["excluded"]}
    assert by_name["LMW Lathe 1"]["verdict"] == "unknown"
    assert by_name["LMW Lathe 1"]["summary"] == UNKNOWN_LIMITS
    assert by_name[sim.name]["verdict"] == "capable"
    assert by_name[sim.name]["excluded_because"] == ["Machine is offline."]

    # Simulate the bridge online with an idle machine.
    hub = app.state.hub
    hub.connections["dev-bridge"] = object()
    hub.update_status(
        "dev-bridge",
        {
            "machine_id": sim.key,
            "connected": True,
            "status": {"run_state": "idle", "alarm": False, "emergency": False},
        },
    )
    body = client.get(f"/api/capability?feature_table_id={ft.id}", headers=h).json()
    assert [r["machine_name"] for r in body["available"]] == [sim.name]


def test_endpoint_requires_confirmed_table(
    client: TestClient, role_headers: dict[str, dict[str, str]], db: Session
) -> None:
    from app.services.feature_tables import empty_data

    ft = FeatureTable(part_number="X-1", data=empty_data(), status="draft")
    db.add(ft)
    db.commit()
    r = client.get(f"/api/capability?feature_table_id={ft.id}", headers=role_headers["engineer"])
    assert r.status_code == 409 and "Confirm the feature table first" in r.json()["detail"]
