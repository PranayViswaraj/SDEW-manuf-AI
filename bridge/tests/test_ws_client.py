"""BridgeService link behaviour (safety rules 5 and 8) with fake connections."""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from bridge.actions import MachineEntry
from bridge.config import BridgeConfig, MachineConfig
from bridge.drivers.simulated import SimConfig, SimulatedDriver
from bridge.signing import sign
from bridge.ws_client import BridgeService

KEY = "test-signing-key-123456"


def config() -> BridgeConfig:
    return BridgeConfig(
        server_url="ws://server.invalid/api/bridge/ws",
        bridge_token="t" * 20,
        signing_key=KEY,
        poll_interval_s=0.05,
        heartbeat_interval_s=0.05,
        machines=[MachineConfig(id="m1", remote_control_enabled=True, pmc_start_address="SIM")],
    )


def machines() -> tuple[dict[str, MachineEntry], SimulatedDriver]:
    sim = SimulatedDriver(
        SimConfig(manual_clock=True, remote_control_enabled=True, pmc_start_address="SIM")
    )
    cfg = config().machines[0]
    return {"m1": MachineEntry(config=cfg, driver=sim)}, sim


class FakeWS:
    """Async-iterable fake connection: yields scripted server messages, then closes."""

    def __init__(self, incoming: list[dict[str, Any]], hold_s: float = 0.3) -> None:
        self.incoming = incoming
        self.sent: list[dict[str, Any]] = []
        self.hold_s = hold_s

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    def __aiter__(self) -> "FakeWS":
        return self

    async def __anext__(self) -> str:
        if self.incoming:
            await asyncio.sleep(0.05)
            return json.dumps(self.incoming.pop(0))
        await asyncio.sleep(self.hold_s)
        raise StopAsyncIteration

    async def __aenter__(self) -> "FakeWS":
        return self

    async def __aexit__(self, *a: object) -> None:
        return None


async def test_no_machine_action_while_server_unreachable() -> None:
    entries, sim = machines()
    attempts = {"n": 0}

    def failing_connector(*a: Any, **k: Any) -> Any:
        attempts["n"] += 1
        raise OSError("server unreachable")

    svc = BridgeService(config(), entries, connector=failing_connector, backoff_initial_s=0.02)
    task = asyncio.create_task(svc.run_forever())
    await asyncio.sleep(0.4)
    svc.stop()
    await task
    assert attempts["n"] >= 2  # keeps retrying (auto-reconnect with backoff)
    assert sim.panel_events == [] and sim.selected is None
    assert sim.folders["//CNC_MEM/USER/PATH1/"] == {}
    assert svc.sessions == 0 and svc.last_error == "server unreachable"


async def test_session_sends_hello_heartbeat_status_and_acks() -> None:
    entries, _ = machines()
    cmd = {
        "id": str(uuid.uuid4()),
        "action": "read_status",
        "machine_id": "m1",
        "program_id": None,
        "program_hash": None,
        "user_id": 1,
        "issued_at": datetime.now(UTC).isoformat(),
    }
    ws = FakeWS([{"type": "command", "command": cmd, "signature": sign(cmd, KEY)}])
    svc = BridgeService(config(), entries, connector=lambda *a, **k: ws, backoff_initial_s=5)
    task = asyncio.create_task(svc.run_forever())
    await asyncio.sleep(0.5)
    svc.stop()
    await task
    kinds = [m["type"] for m in ws.sent]
    assert kinds[0] == "hello" and "heartbeat" in kinds and "status" in kinds
    ack = next(m for m in ws.sent if m["type"] == "ack")
    assert ack["command_id"] == cmd["id"] and ack["result"] == "ok"
    status = next(m for m in ws.sent if m["type"] == "status")
    assert status["machine_id"] == "m1" and status["connected"] is True


async def test_late_command_after_reconnect_is_rejected_not_executed() -> None:
    """A start command issued before a link drop must not run when it arrives late."""
    entries, sim = machines()
    old = (datetime.now(UTC) - timedelta(seconds=30)).isoformat()
    cmd = {
        "id": str(uuid.uuid4()),
        "action": "start",
        "machine_id": "m1",
        "program_id": 1,
        "program_hash": "a" * 64,
        "user_id": 1,
        "issued_at": old,
    }
    ws = FakeWS([{"type": "command", "command": cmd, "signature": sign(cmd, KEY)}])
    svc = BridgeService(config(), entries, connector=lambda *a, **k: ws, backoff_initial_s=5)
    task = asyncio.create_task(svc.run_forever())
    await asyncio.sleep(0.4)
    svc.stop()
    await task
    ack = next(m for m in ws.sent if m["type"] == "ack")
    assert ack["result"] == "rejected" and "expired" in ack["error"]
    assert sim.panel_events == []


async def test_non_command_messages_are_ignored() -> None:
    entries, sim = machines()
    ws = FakeWS([{"type": "delete_everything"}, {"type": "error", "message": "x"}, ["junk"]])  # type: ignore[list-item]
    svc = BridgeService(config(), entries, connector=lambda *a, **k: ws, backoff_initial_s=5)
    task = asyncio.create_task(svc.run_forever())
    await asyncio.sleep(0.4)
    svc.stop()
    await task
    assert not any(m["type"] == "ack" for m in ws.sent)
    assert sim.panel_events == []
