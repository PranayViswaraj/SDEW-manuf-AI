"""End-to-end: real server (uvicorn) + real bridge service + simulated FANUC, over WebSockets.

Covers: status flow, offline detection, send_program with read-back, remote start rules,
connection drops and automatic reconnect, and that nothing is sent while the bridge is offline
(safety rule 8).
"""

import pytest
from bridge.drivers.base import RunState
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect

from app.config import Settings
from tests.e2e_support import (
    BridgeThread,
    LiveServer,
    act,
    audit_rows,
    demo_program,
    live,
    wait_for,
)

# ---------------------------------------------------------------- tests


def test_status_flows_and_goes_offline_when_bridge_stops(
    server: LiveServer, bridge: BridgeThread
) -> None:
    wait_for(lambda: live(server, "lmw-lathe-1")["state"] == "online", what="online")
    v = live(server, "lmw-lathe-1")
    assert v["driver"] == "simulated" and v["status"]["mode"] == "MEM"
    assert v["status"]["run_state"] == "idle" and v["remote_control_enabled"] is False
    bridge.stop()
    wait_for(lambda: live(server, "lmw-lathe-1")["state"] == "offline", what="offline")
    assert live(server, "lmw-lathe-1")["status"] is None
    assert audit_rows(server, "bridge_disconnected")


def test_send_program_end_to_end_with_readback(server: LiveServer, bridge: BridgeThread) -> None:
    res = act(server, "lmw-lathe-1", "send_program", demo_program())
    assert res.ok, res.error
    assert res.details["program_number"] == 9000
    sim = bridge.sims["lmw-lathe-1"]
    assert sim.selected == 9000 and 9000 in sim.folders["//CNC_MEM/USER/PATH1/"]
    rows = audit_rows(server, "send_program")
    assert [r.result for r in rows] == ["requested", "ok"]  # audit before AND after
    assert rows[0].program_hash == demo_program().sha256 and rows[0].user_id is not None
    wait_for(lambda: live(server, "lmw-lathe-1").get("loaded_program") == 9000, what="loaded")


def test_remote_start_refused_when_disabled(server: LiveServer, bridge: BridgeThread) -> None:
    act(server, "lmw-lathe-1", "send_program", demo_program())
    res = act(server, "lmw-lathe-1", "start", demo_program())
    assert res.result == "rejected" and "Press Cycle Start at the machine" in (res.error or "")
    assert bridge.sims["lmw-lathe-1"].run_state == RunState.IDLE
    assert audit_rows(server, "start")[-1].result == "rejected"


def test_remote_start_feed_hold_stop_when_enabled(server: LiveServer, bridge: BridgeThread) -> None:
    assert act(server, "sim-lathe-dev", "send_program", demo_program()).ok
    res = act(server, "sim-lathe-dev", "start", demo_program())
    assert res.ok, res.error
    sim = bridge.sims["sim-lathe-dev"]
    assert sim.run_state == RunState.RUNNING
    wait_for(
        lambda: live(server, "sim-lathe-dev")["status"]["run_state"] == "running", what="running"
    )
    assert act(server, "sim-lathe-dev", "feed_hold").ok
    assert sim.run_state == RunState.FEED_HOLD
    assert act(server, "sim-lathe-dev", "stop").ok
    assert sim.run_state == RunState.IDLE


def test_start_needs_allowed_to_start_list(server: LiveServer, bridge: BridgeThread) -> None:
    res = act(server, "sim-lathe-dev", "start", demo_program(), user="programmer")
    assert res.result == "rejected" and "operator" in (res.error or "")


def test_nothing_sent_while_bridge_offline(server: LiveServer, bridge: BridgeThread) -> None:
    bridge.stop()
    wait_for(lambda: live(server, "lmw-lathe-1")["state"] == "offline", what="offline")
    res = act(server, "lmw-lathe-1", "send_program", demo_program())
    assert res.result == "failed" and "offline" in (res.error or "")
    assert bridge.sims["lmw-lathe-1"].folders["//CNC_MEM/USER/PATH1/"] == {}
    assert [r.result for r in audit_rows(server, "send_program")] == ["requested", "failed"]


def test_bridge_reconnects_after_connection_drop(server: LiveServer, bridge: BridgeThread) -> None:
    wait_for(lambda: live(server, "lmw-lathe-1")["state"] == "online", what="online")
    sessions = bridge.service.sessions
    conn = server.app.state.hub.connections["dev-bridge"]
    server.run(conn.ws.close(code=1011))
    wait_for(lambda: bridge.service.sessions > sessions, what="reconnect")
    wait_for(lambda: live(server, "lmw-lathe-1")["state"] == "online", what="online again")
    # The machine was never touched by the bridge on its own during the drop.
    assert bridge.sims["lmw-lathe-1"].panel_events == []
    assert act(server, "lmw-lathe-1", "send_program", demo_program()).ok


def test_bad_bridge_token_is_refused(server: LiveServer, e2e_settings: Settings) -> None:
    with pytest.raises(InvalidStatus):
        connect(
            f"ws://127.0.0.1:{server.port}/api/bridge/ws",
            additional_headers={"Authorization": "Bearer wrong-token"},
        )
    assert audit_rows(server, "bridge_auth")[-1].result == "rejected"
