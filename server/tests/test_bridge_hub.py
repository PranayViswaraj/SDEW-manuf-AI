"""BridgeHub unit tests: live status states (safety rule 8) and command round-trips."""

import asyncio
from typing import Any

import pytest

from app.services.bridge_hub import BridgeHub, BridgeUnavailable, CommandTimeout
from app.services.command_signing import sign


class FakeWS:
    def __init__(self, hub: BridgeHub | None = None, reply: dict[str, Any] | None = None) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed = False
        self.hub = hub
        self.reply = reply

    async def send_json(self, data: Any) -> None:
        self.sent.append(data)
        if self.hub is not None and self.reply is not None:
            cid = data["command"]["id"]
            asyncio.get_running_loop().call_soon(
                self.hub.resolve_ack, {"type": "ack", "command_id": cid, **self.reply}
            )

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = True


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


STATUS = {"machine_id": "m1", "connected": True, "status": {"mode": "MEM"}, "driver": "simulated"}


def test_states_online_stale_offline() -> None:
    async def go() -> None:
        clock = Clock()
        hub = BridgeHub(stale_after_s=5.0, clock=clock)
        assert hub.live_view("m1", "b1")["state"] == "offline"
        conn = await hub.register("b1", FakeWS(), "key")
        assert hub.live_view("m1", "b1")["state"] == "offline"  # connected, no status yet
        hub.update_status("b1", STATUS)
        v = hub.live_view("m1", "b1")
        assert v["state"] == "online" and v["status"] == {"mode": "MEM"}
        clock.t += 5.1
        assert hub.live_view("m1", "b1")["state"] == "stale"  # > 5 s without updates
        assert hub.fresh_status("m1", "b1") is None
        hub.update_status("b1", {**STATUS, "connected": False, "status": None, "error": "x"})
        assert hub.live_view("m1", "b1")["state"] == "machine_unreachable"
        hub.unregister(conn)
        v = hub.live_view("m1", "b1")
        assert v["state"] == "offline" and v["status"] is None
        # status reported by a different bridge never counts for this machine
        await hub.register("b2", FakeWS(), "k2")
        hub.update_status("b2", STATUS)
        assert hub.live_view("m1", "b1")["state"] == "offline"

    asyncio.run(go())


def test_command_signed_and_ack_returned() -> None:
    async def go() -> None:
        hub = BridgeHub(stale_after_s=5)
        ws = FakeWS(hub, {"result": "ok", "error": None, "details": {"x": 1}})
        await hub.register("b1", ws, "secret-key")
        cmd = hub.build_command(action="read_status", machine_key="m1", user_id=1)
        ack = await hub.send_command("b1", cmd, timeout_s=2)
        assert ack["result"] == "ok"
        sent = ws.sent[0]
        assert sent["signature"] == sign(sent["command"], "secret-key")
        assert sent["command"]["issued_at"].endswith("+00:00")

    asyncio.run(go())


def test_no_bridge_means_nothing_sent() -> None:
    async def go() -> None:
        hub = BridgeHub(stale_after_s=5)
        cmd = hub.build_command(action="read_status", machine_key="m1", user_id=1)
        with pytest.raises(BridgeUnavailable):
            await hub.send_command("b1", cmd, 1)
        with pytest.raises(BridgeUnavailable):
            await hub.send_command(None, cmd, 1)

    asyncio.run(go())


def test_timeout_and_disconnect_fail_pending() -> None:
    async def go() -> None:
        hub = BridgeHub(stale_after_s=5)
        conn = await hub.register("b1", FakeWS(), "k")
        cmd = hub.build_command(action="read_status", machine_key="m1", user_id=1)
        with pytest.raises(CommandTimeout):
            await hub.send_command("b1", cmd, 0.05)
        cmd2 = hub.build_command(action="read_status", machine_key="m1", user_id=1)
        task = asyncio.create_task(hub.send_command("b1", cmd2, 5))
        await asyncio.sleep(0.05)
        hub.unregister(conn)
        with pytest.raises(BridgeUnavailable, match="disconnected"):
            await task

    asyncio.run(go())


def test_reconnect_replaces_old_socket() -> None:
    async def go() -> None:
        hub = BridgeHub(stale_after_s=5)
        old_ws = FakeWS()
        old = await hub.register("b1", old_ws, "k")
        await hub.register("b1", FakeWS(), "k")
        assert old_ws.closed
        hub.unregister(old)  # late cleanup of the old socket must not drop the new one
        assert hub.is_connected("b1")

    asyncio.run(go())
