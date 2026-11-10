"""Run screen end to end (Milestone 11): real server + real bridge + simulated lathes.

Full flow: create run -> checklist -> send (verified) -> start -> completes -> first piece ->
program proven, and every step in the audit log. Plus the Start lock (safety rule 4) and the
feature-table / approval gate on Send (safety rule 3).
"""

from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.db.models import AuditLog, FeatureTable, FeatureTableStatus, Machine, Program, User
from app.services.feature_tables import data_hash, normalise
from app.services.run_service import CHECKLIST
from tests.e2e_support import (
    BridgeThread,
    LiveServer,
    http,
    wait_for,
)


def machine_id(server: LiveServer, key: str) -> int:
    return server.db_get(Machine, key=key).id


def program_id(server: LiveServer, machine_key: str, number: int) -> int:
    with server.app.state.session_factory() as db:
        m = db.scalars(select(Machine).where(Machine.key == machine_key)).one()
        return int(
            db.scalars(
                select(Program.id).where(
                    Program.machine_id == m.id, Program.program_number == number
                )
            ).one()
        )


def approve_demo(server: LiveServer) -> int:
    pid = program_id(server, "sim-lathe-dev", 9000)
    with http(server, "programmer") as c:
        r = c.post(f"/api/programs/{pid}/approve")
        assert r.status_code == 200, r.text
    return pid


def confirm_feature_table(server: LiveServer, part_number: str) -> None:
    cell = {"ai": None, "value": 1.0, "confirmed": True}
    data = normalise(
        {
            "header": {
                "material_grade": {"ai": None, "value": "EN8", "confirmed": True},
                "bar_diameter": {**cell, "value": 50.0},
                "overall_length": {**cell, "value": 27.0},
            },
            "features": [
                {
                    "type": "od",
                    "fields": {
                        "diameter": cell,
                        "length": cell,
                        "tol_plus": cell,
                        "tol_minus": cell,
                    },
                }
            ],
        }
    )
    with server.app.state.session_factory() as db:
        db.add(
            FeatureTable(
                part_number=part_number,
                data=data,
                status=FeatureTableStatus.CONFIRMED.value,
                confirmed_by_name="test engineer",
                confirmed_hash=data_hash(data),
            )
        )
        db.commit()


def new_run(c: httpx.Client, mid: int, pid: int) -> dict[str, Any]:
    r = c.post("/api/runs", json={"machine_id": mid, "program_id": pid})
    assert r.status_code == 201, r.text
    return dict(r.json())


def tick_all(c: httpx.Client, run_id: int) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, _ in CHECKLIST:
        r = c.put(f"/api/runs/{run_id}/checklist", json={"item": key, "ticked": True})
        assert r.status_code == 200
        out = r.json()
    return out


def get_run(c: httpx.Client, run_id: int) -> dict[str, Any]:
    return dict(c.get(f"/api/runs/{run_id}").json())


def wait_online(server: LiveServer, c: httpx.Client, mid: int) -> None:
    wait_for(lambda: c.get(f"/api/machines/{mid}/live").json()["state"] == "online", what="online")


def test_full_simulated_run_with_remote_start(server: LiveServer, bridge: BridgeThread) -> None:
    pid = approve_demo(server)
    mid = machine_id(server, "sim-lathe-dev")
    with http(server, "operator") as c:
        wait_online(server, c, mid)
        run = new_run(c, mid, pid)
        assert run["status"] == "checklist"
        assert any("checklist" in b for b in run["send_blockers"])
        assert run["required_material"]["material_grade"] == "EN8"  # from the confirmed table
        run = tick_all(c, run["id"])
        assert run["send_blockers"] == [], run["send_blockers"]
        assert run["start_blockers"] == ["Send the program first."]

        r = c.post(f"/api/runs/{run['id']}/send").json()
        assert r["action"]["result"] == "ok", r["action"]
        assert r["run"]["status"] == "sent"
        wait_for(lambda: get_run(c, run["id"])["start_blockers"] == [], what="start unlocked")

        r = c.post(f"/api/runs/{run['id']}/start").json()
        assert r["action"]["result"] == "ok", r["action"]
        wait_for(lambda: get_run(c, run["id"])["status"] == "completed", timeout=15, what="done")
        done = get_run(c, run["id"])
        assert done["status_note"] == "", done["status_note"]  # finished at M30, not a reset
        assert done["live"]["status"]["part_count"] == 1

        r = c.post(
            f"/api/runs/{run['id']}/first-piece",
            json={
                "result": "pass",
                "measurements": [{"feature": "OD 40", "nominal": "40.00", "measured": "39.98"}],
                "notes": "ok",
            },
        )
        assert r.status_code == 200 and r.json()["status"] == "closed"
        assert r.json()["program"]["proven"] is True

    with server.app.state.session_factory() as db:
        actions = [a.action for a in db.scalars(select(AuditLog).order_by(AuditLog.id))]
    for expected in (
        "program_approve",
        "run_create",
        "checklist_tick",
        "send_program",
        "start",
        "run_completed",
        "first_piece_result",
        "program_proven",
    ):
        assert expected in actions, expected
    assert actions.count("checklist_tick") == len(CHECKLIST)


def test_lmw_run_needs_feature_table_and_cycle_start_at_machine(
    server: LiveServer, bridge: BridgeThread
) -> None:
    mid = machine_id(server, "lmw-lathe-1")
    pid = program_id(server, "lmw-lathe-1", 9)  # trusted O0009
    with http(server, "operator") as c:
        wait_online(server, c, mid)
        run = new_run(c, mid, pid)
        run = tick_all(c, run["id"])
        assert any("No feature table for part 3216C11701" in b for b in run["send_blockers"])
        r = c.post(f"/api/runs/{run['id']}/send").json()
        assert r["action"]["result"] == "rejected"  # rule 3: nothing sent
        assert bridge.sims["lmw-lathe-1"].folders["//CNC_MEM/USER/PATH1/"] == {}

        confirm_feature_table(server, "3216C11701")
        r = c.post(f"/api/runs/{run['id']}/send").json()
        assert r["action"]["result"] == "ok", r["action"]
        wait_for(
            lambda: "Press Cycle Start at the machine"
            in " ".join(get_run(c, run["id"])["start_blockers"]),
            what="remote off message",
        )
        # Start is refused by the server (remote control off) ...
        assert c.post(f"/api/runs/{run['id']}/start").json()["action"]["result"] == "rejected"
        # ... the operator presses Cycle Start on the machine (and again after each M00).
        sim = bridge.sims["lmw-lathe-1"]
        assert sim.press_cycle_start()
        wait_for(
            lambda: get_run(c, run["id"])["status"] in ("running", "completed"), what="running"
        )
        assert get_run(c, run["id"])["start_mode"] == "at_machine"

        def finish() -> bool:
            sim.press_cycle_start()  # continue after any program stop
            return get_run(c, run["id"])["status"] == "completed"

        wait_for(finish, timeout=20, what="completed")


def test_start_lock_conditions(server: LiveServer, bridge: BridgeThread) -> None:
    pid = approve_demo(server)
    mid = machine_id(server, "sim-lathe-dev")
    with server.app.state.session_factory() as db:
        op = db.scalars(select(User).where(User.username == "operator")).one()
        op.can_start_machine = False
        db.commit()
    with http(server, "operator") as c:
        wait_online(server, c, mid)
        run = tick_all(c, new_run(c, mid, pid)["id"])
        assert c.post(f"/api/runs/{run['id']}/send").json()["action"]["result"] == "ok"
        wait_for(
            lambda: any(
                "allowed to press Start" in b for b in get_run(c, run["id"])["start_blockers"]
            ),
            what="not on start list",
        )
        r = c.post(f"/api/runs/{run['id']}/start").json()
        assert r["action"]["result"] == "rejected"
        assert bridge.sims["sim-lathe-dev"].run_state.value == "idle"

        # Alarm on the machine also locks Start.
        bridge.sims["sim-lathe-dev"].inject_alarm(2001, "SIMULATED LUBE ALARM")
        wait_for(
            lambda: any("alarm" in b for b in get_run(c, run["id"])["start_blockers"]), what="alarm"
        )
        # Untick a checklist item -> locked again.
        c.put(f"/api/runs/{run['id']}/checklist", json={"item": "door_closed", "ticked": False})
        assert any("Door closed" in b for b in get_run(c, run["id"])["start_blockers"])


def test_start_locked_when_bridge_offline(server: LiveServer, bridge: BridgeThread) -> None:
    pid = approve_demo(server)
    mid = machine_id(server, "sim-lathe-dev")
    with http(server, "operator") as c:
        wait_online(server, c, mid)
        run = tick_all(c, new_run(c, mid, pid)["id"])
        assert c.post(f"/api/runs/{run['id']}/send").json()["action"]["result"] == "ok"
        bridge.stop()
        wait_for(
            lambda: any("not live" in b for b in get_run(c, run["id"])["start_blockers"]),
            what="offline lock",
        )
        assert c.post(f"/api/runs/{run['id']}/start").json()["action"]["result"] == "rejected"


# ---------------------------------------------------------------- API rules without a bridge


def test_run_requires_approved_program_and_one_open_run(server: LiveServer) -> None:
    mid = machine_id(server, "sim-lathe-dev")
    draft = program_id(server, "sim-lathe-dev", 9000)  # still draft
    with http(server, "operator") as c:
        r = c.post("/api/runs", json={"machine_id": mid, "program_id": draft})
        assert r.status_code == 409 and "approved" in r.json()["detail"]
    approve_demo(server)
    with http(server, "operator") as c:
        run = new_run(c, mid, draft)
        r = c.post("/api/runs", json={"machine_id": mid, "program_id": draft})
        assert r.status_code == 409 and "still open" in r.json()["detail"]
        assert (
            c.put(
                f"/api/runs/{run['id']}/checklist", json={"item": "x", "ticked": True}
            ).status_code
            == 422
        )
        r = c.post(f"/api/runs/{run['id']}/first-piece", json={"result": "pass"})
        assert r.status_code == 409
        assert c.post(f"/api/runs/{run['id']}/abort").json()["status"] == "aborted"
        new_run(c, mid, draft)  # a new run starts with an empty checklist
    with http(server, "programmer") as c:
        assert c.post("/api/runs", json={"machine_id": mid, "program_id": draft}).status_code == 403


@pytest.mark.parametrize("item", [k for k, _ in CHECKLIST])
def test_each_checklist_item_is_required(server: LiveServer, item: str) -> None:
    mid = machine_id(server, "sim-lathe-dev")
    pid = program_id(server, "sim-lathe-dev", 9000)
    with server.app.state.session_factory() as db:
        p = db.get(Program, pid)
        assert p is not None
        if p.status != "approved":
            from app.services.program_store import mark_approved

            mark_approved(p, None, "test")
            db.commit()
    with http(server, "operator") as c:
        run = tick_all(c, new_run(c, mid, pid)["id"])
        run = c.put(f"/api/runs/{run['id']}/checklist", json={"item": item, "ticked": False}).json()
        label = dict(CHECKLIST)[item]
        assert any(label in b for b in run["send_blockers"])
