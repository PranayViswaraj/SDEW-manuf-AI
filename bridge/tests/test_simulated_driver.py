"""Driver test suite run against the simulated FANUC 0i-TF."""

import asyncio
from pathlib import Path

import pytest

from bridge.drivers.base import (
    ConnectionLost,
    MachineBusy,
    MachineConnectionError,
    Mode,
    ProgramExists,
    ProgramFormatError,
    ProgramNotFound,
    RemoteControlNotAvailable,
    RunState,
)
from bridge.drivers.simulated import SimConfig, SimulatedDriver
from bridge.program_text import canonical

SAMPLES = Path(__file__).resolve().parents[2] / "samples" / "programs"
DEMO = """%
O9000(SIM DEMO)
N1(TOOL 1)
G28U0W0
G97S1000M4
T0101
G0X30.0Z2.0
G1Z-10.0F0.2
M00
N2(TOOL 2)
G97S1500M4
G1X20.0
G28U0W0M5
M30
%"""


async def make(**cfg: object) -> SimulatedDriver:
    d = SimulatedDriver(SimConfig(manual_clock=True, **cfg))  # type: ignore[arg-type]
    await d.connect()
    return d


async def loaded(**cfg: object) -> SimulatedDriver:
    d = await make(**cfg)
    await d.download_program(DEMO)
    await d.select_main_program(9000)
    return d


async def test_initial_status() -> None:
    d = await make()
    s = await d.read_status()
    assert s.mode == Mode.MEM and s.run_state == RunState.IDLE
    assert not s.alarm and not s.emergency and s.program_number is None
    assert s.timestamp.tzinfo is not None
    assert s.to_dict()["run_state"] == "idle"


async def test_download_list_upload_roundtrip_with_trusted_sample() -> None:
    d = await make()
    raw = (SAMPLES / "O0004").read_bytes().decode("ascii")
    assert await d.download_program(raw) == 4
    progs = await d.list_programs()
    assert [p.name for p in progs] == ["O0004"]
    assert progs[0].comment == "3314A01701 SLEEVE COMPACT"
    back = await d.upload_program(4)
    assert "\r" not in back and canonical(back) == canonical(raw)


async def test_o_number_format_enforced() -> None:
    d = await make()
    for bad in ("%\nG0X0\n%", "%\nO12345\n%", "%\nO0001(UNCLOSED\nM30\n%"):
        with pytest.raises(ProgramFormatError):
            await d.download_program(bad)


async def test_existing_program_not_overwritten() -> None:
    d = await make()
    await d.download_program(DEMO)
    with pytest.raises(ProgramExists):
        await d.download_program(DEMO.replace("X30.0", "X99.0"))
    assert "X30.0" in await d.upload_program(9000)


async def test_missing_program_errors() -> None:
    d = await make()
    with pytest.raises(ProgramNotFound):
        await d.upload_program(1)
    with pytest.raises(ProgramNotFound):
        await d.select_main_program(1)
    with pytest.raises(ProgramNotFound):
        await d.delete_program(1)


async def test_runs_through_blocks_m00_stop_and_m30_end() -> None:
    d = await loaded()
    assert d.press_cycle_start()
    d.advance(3)  # N1, G28, G97 S1000 M4
    s = await d.read_status()
    assert s.run_state == RunState.RUNNING and s.sequence_number == 1 and s.spindle_speed == 1000
    d.advance(10)  # reaches M00
    assert (await d.read_status()).run_state == RunState.STOPPED
    assert d.press_cycle_start()  # operator continues
    d.advance(3)
    s = await d.read_status()
    assert s.sequence_number == 2 and s.spindle_speed == 1500
    d.advance(10)
    s = await d.read_status()
    assert s.run_state == RunState.IDLE and s.part_count == 1 and s.spindle_speed == 0


async def test_m99_p_jumps_to_sequence() -> None:
    raw = (SAMPLES / "O0009").read_bytes().decode("ascii")  # starts with M99P2
    d = await make()
    await d.download_program(raw)
    await d.select_main_program(9)
    d.press_cycle_start()
    d.advance(2)  # M99P2 then N2 block
    assert (await d.read_status()).sequence_number == 2


async def test_download_delete_select_rejected_while_running() -> None:
    d = await loaded()
    d.press_cycle_start()
    with pytest.raises(MachineBusy, match="running"):
        await d.download_program(DEMO.replace("O9000", "O9001"))
    with pytest.raises(MachineBusy):
        await d.delete_program(9000)
    with pytest.raises(MachineBusy):
        await d.select_main_program(9000)
    d.press_feed_hold()
    with pytest.raises(MachineBusy):  # feed hold still counts as running
        await d.download_program(DEMO.replace("O9000", "O9001"))


async def test_remote_control_disabled_by_default() -> None:
    d = await loaded()
    for action in (d.cycle_start, d.feed_hold, d.reset_stop):
        with pytest.raises(RemoteControlNotAvailable, match="Press Cycle Start at the machine"):
            await action()
    assert (await d.read_status()).run_state == RunState.IDLE


async def test_remote_control_needs_pmc_address_too() -> None:
    d = await loaded(remote_control_enabled=True, pmc_start_address=None)
    with pytest.raises(RemoteControlNotAvailable):
        await d.cycle_start()


async def test_remote_control_when_enabled() -> None:
    d = await loaded(remote_control_enabled=True, pmc_start_address="SIM")
    await d.cycle_start()
    assert d.run_state == RunState.RUNNING
    await d.feed_hold()
    assert d.run_state == RunState.FEED_HOLD
    await d.reset_stop()
    assert d.run_state == RunState.IDLE


async def test_alarm_stops_run_and_blocks_start() -> None:
    d = await loaded(remote_control_enabled=True, pmc_start_address="SIM")
    d.press_cycle_start()
    d.inject_alarm(1001, "SIMULATED SPINDLE ALARM")
    s = await d.read_status()
    assert s.alarm and s.alarms[0].code == 1001 and s.run_state == RunState.STOPPED
    with pytest.raises(MachineBusy, match="alarm"):
        await d.cycle_start()
    d.clear_alarms()
    await d.cycle_start()
    assert d.run_state == RunState.RUNNING


async def test_emergency_resets_and_blocks_start() -> None:
    d = await loaded()
    d.press_cycle_start()
    d.set_emergency(True)
    s = await d.read_status()
    assert s.emergency and s.run_state == RunState.IDLE
    assert not d.press_cycle_start()


async def test_edit_mode_cannot_start() -> None:
    d = await loaded()
    d.mode = Mode.EDIT
    assert not d.press_cycle_start()


async def test_connection_drops() -> None:
    d = await make(drop_connection_after_reads=2)
    await d.read_status()
    await d.read_status()
    with pytest.raises(ConnectionLost):
        await d.read_status()
    with pytest.raises(ConnectionLost):
        await d.list_programs()
    await d.connect()
    assert (await d.read_status()).mode == Mode.MEM


async def test_manual_drop_and_refused_connect() -> None:
    d = await make()
    d.drop_connection()
    assert not d.connected
    with pytest.raises(ConnectionLost):
        await d.download_program(DEMO)
    with pytest.raises(MachineConnectionError):
        await SimulatedDriver(SimConfig(fail_connect=True)).connect()


async def test_background_clock_and_auto_cycle_start() -> None:
    # Steps >= 20 ms: on Windows the asyncio clock ticks in ~15.6 ms steps, shorter sleeps
    # return immediately.
    d = SimulatedDriver(SimConfig(block_time_s=0.02, auto_cycle_start_after_s=0.05))
    await d.connect()
    await d.download_program(DEMO.replace("M00\n", ""))
    await d.select_main_program(9000)
    for _ in range(250):
        await asyncio.sleep(0.02)
        if d.part_count == 1:
            break
    await d.disconnect()
    assert d.part_count == 1
    assert d.panel_events[0] == "cycle_start"


async def test_delete_program() -> None:
    d = await loaded()
    await d.delete_program(9000)
    assert await d.list_programs() == []
    assert (await d.read_status()).program_number is None
