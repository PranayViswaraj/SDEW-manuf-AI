"""Command dispatcher tests: allow-list, signature, expiry, replay, machine, hash, state."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from bridge.actions import REMOTE_OFF_MESSAGE, Dispatcher, MachineEntry
from bridge.config import MachineConfig
from bridge.drivers.base import RunState
from bridge.drivers.simulated import SimConfig, SimulatedDriver
from bridge.signing import sign

KEY = "test-signing-key-123456"
PROGRAM = "%\nO9000(DEMO)\nG28U0W0\nG97S1000M4\nG0X20.0Z2.0\nM30\n%"
PHASH = hashlib.sha256(PROGRAM.encode()).hexdigest()


def sim(remote: bool = False) -> SimulatedDriver:
    return SimulatedDriver(
        SimConfig(manual_clock=True, remote_control_enabled=remote, pmc_start_address="SIM")
    )


async def dispatcher(remote: bool = False) -> tuple[Dispatcher, SimulatedDriver]:
    d = sim(remote)
    await d.connect()
    entry = MachineEntry(config=MachineConfig(id="m1", remote_control_enabled=remote), driver=d)
    return Dispatcher({"m1": entry}, KEY), d


def command(action: str, **over: Any) -> dict[str, Any]:
    cmd: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "action": action,
        "machine_id": "m1",
        "program_id": 7,
        "program_hash": PHASH,
        "user_id": 3,
        "issued_at": datetime.now(UTC).isoformat(),
    }
    if action == "send_program":
        cmd |= {"program_text": PROGRAM, "program_number": 9000}
    cmd |= over
    return {"type": "command", "command": cmd, "signature": sign(cmd, KEY)}


# ---------- envelope checks ----------


async def test_unknown_action_rejected_and_nothing_done() -> None:
    disp, d = await dispatcher()
    for action in ("delete_program", "emergency_stop", "write_param", ""):
        ack = await disp.handle(command(action))
        assert ack.result == "rejected" and "not allowed" in (ack.error or "")
    assert await d.list_programs() == []


async def test_bad_signature_rejected() -> None:
    disp, d = await dispatcher()
    msg = command("send_program")
    msg["command"]["program_text"] = PROGRAM.replace("X20.0", "X99.0")  # tampered after signing
    ack = await disp.handle(msg)
    assert ack.result == "rejected" and "signature" in (ack.error or "")
    assert await d.list_programs() == []


async def test_expired_and_future_commands_rejected() -> None:
    disp, _ = await dispatcher()
    old = (datetime.now(UTC) - timedelta(seconds=11)).isoformat()
    ack = await disp.handle(command("read_status", issued_at=old))
    assert ack.result == "rejected" and "expired" in (ack.error or "")
    future = (datetime.now(UTC) + timedelta(seconds=60)).isoformat()
    ack = await disp.handle(command("read_status", issued_at=future))
    assert ack.result == "rejected" and "future" in (ack.error or "")


async def test_replayed_command_rejected() -> None:
    disp, _ = await dispatcher()
    msg = command("read_status")
    assert (await disp.handle(msg)).result == "ok"
    ack = await disp.handle(msg)
    assert ack.result == "rejected" and "replay" in (ack.error or "")


async def test_wrong_machine_rejected() -> None:
    disp, _ = await dispatcher()
    ack = await disp.handle(command("read_status", machine_id="other-lathe"))
    assert ack.result == "rejected" and "not connected to this bridge" in (ack.error or "")


async def test_hash_mismatch_rejected() -> None:
    disp, d = await dispatcher()
    ack = await disp.handle(command("send_program", program_hash="0" * 64))
    assert ack.result == "rejected" and "hash mismatch" in (ack.error or "")
    assert await d.list_programs() == []


async def test_malformed_message() -> None:
    disp, _ = await dispatcher()
    assert (await disp.handle({"type": "command"})).result == "rejected"


# ---------- send_program ----------


async def test_send_program_downloads_verifies_and_selects() -> None:
    disp, d = await dispatcher()
    ack = await disp.handle(command("send_program"))
    assert ack.result == "ok", ack.error
    assert ack.details["program_number"] == 9000 and not ack.details["replaced_existing"]
    st = await d.read_status()
    assert st.program_number == 9000
    # Same program again: already present, not re-downloaded.
    ack = await disp.handle(command("send_program"))
    assert ack.details["already_present"] is True


async def test_send_program_replaces_different_existing_program() -> None:
    disp, d = await dispatcher()
    await d.download_program(PROGRAM.replace("X20.0", "X55.0"))
    ack = await disp.handle(command("send_program"))
    assert ack.result == "ok" and ack.details["replaced_existing"] is True
    assert "X20.0" in await d.upload_program(9000)


async def test_send_program_refused_while_running_or_alarm() -> None:
    disp, d = await dispatcher()
    await disp.handle(command("send_program"))
    d.press_cycle_start()
    ack = await disp.handle(command("send_program"))
    assert ack.result == "rejected" and "not idle" in (ack.error or "")
    d.press_reset()
    d.inject_alarm(500, "OVERTRAVEL")
    ack = await disp.handle(command("send_program"))
    assert ack.result == "rejected" and "alarm" in (ack.error or "")


async def test_readback_mismatch_reported_as_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    disp, d = await dispatcher()
    real_upload = d.upload_program
    calls = {"n": 0}

    async def corrupt(number: int, folder: str = "//CNC_MEM/USER/PATH1/") -> str:
        calls["n"] += 1
        text = await real_upload(number, folder)
        return text.replace("X20.0", "X21.0")

    async def missing_first(number: int, folder: str = "//CNC_MEM/USER/PATH1/") -> str:
        if calls["n"] == 0:
            calls["n"] += 1
            from bridge.drivers.base import ProgramNotFound

            raise ProgramNotFound("not there")
        return await corrupt(number, folder)

    monkeypatch.setattr(d, "upload_program", missing_first)
    ack = await disp.handle(command("send_program"))
    assert ack.result == "failed" and "Read-back check failed" in (ack.error or "")
    # Start must now be impossible: nothing verified is loaded.
    disp.machines["m1"].config.remote_control_enabled = True
    d.cfg.remote_control_enabled = True
    ack = await disp.handle(command("start"))
    assert ack.result == "rejected"


# ---------- start / feed hold / stop ----------


async def test_remote_actions_rejected_when_remote_control_off() -> None:
    disp, d = await dispatcher(remote=False)
    await disp.handle(command("send_program"))
    for action in ("start", "feed_hold", "stop"):
        ack = await disp.handle(command(action))
        assert ack.result == "rejected" and ack.error == REMOTE_OFF_MESSAGE
    assert d.run_state == RunState.IDLE


async def test_start_runs_only_verified_selected_program() -> None:
    disp, d = await dispatcher(remote=True)
    ack = await disp.handle(command("start"))
    assert ack.result == "rejected" and "no verified program" in (ack.error or "")
    await disp.handle(command("send_program"))
    ack = await disp.handle(command("start", program_hash="f" * 64))
    assert ack.result == "rejected" and "not the one loaded" in (ack.error or "")
    ack = await disp.handle(command("start"))
    assert ack.result == "ok", ack.error
    assert d.run_state == RunState.RUNNING


async def test_start_rechecks_machine_state() -> None:
    disp, d = await dispatcher(remote=True)
    await disp.handle(command("send_program"))
    d.inject_alarm(1, "X")
    assert "alarm" in ((await disp.handle(command("start"))).error or "")
    d.clear_alarms()
    d.set_emergency(True)
    assert "emergency" in ((await disp.handle(command("start"))).error or "")
    d.set_emergency(False)
    await d.select_main_program(9000)  # emergency reset cleared nothing else
    d.selected = None
    assert "expected O9000" in ((await disp.handle(command("start"))).error or "")


async def test_feed_hold_and_stop_when_enabled() -> None:
    disp, d = await dispatcher(remote=True)
    await disp.handle(command("send_program"))
    await disp.handle(command("start"))
    assert (await disp.handle(command("feed_hold"))).result == "ok"
    assert d.run_state == RunState.FEED_HOLD
    assert (await disp.handle(command("stop"))).result == "ok"
    assert d.run_state == RunState.IDLE


async def test_read_status() -> None:
    disp, _ = await dispatcher()
    ack = await disp.handle(command("read_status"))
    assert ack.result == "ok" and ack.details["status"]["mode"] == "MEM"
