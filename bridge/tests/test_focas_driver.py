"""FocasDriver + ctypes wrapper against a fake FOCAS library (no DLL, no machine)."""

import threading
from collections.abc import AsyncIterator

import pytest

from bridge.drivers.base import (
    ConnectionLost,
    DriverError,
    MachineAlarm,
    MachineBusy,
    MachineConnectionError,
    Mode,
    ProgramExists,
    ProgramNotFound,
    RemoteControlNotAvailable,
    RunState,
)
from bridge.drivers.focas import FocasConfig, FocasDriver, map_focas_error
from bridge.focas_ctypes import (
    EW_ALARM,
    EW_BUSY,
    EW_HANDLE,
    EW_PROT,
    EW_REJECT,
    EW_SOCKET,
    LIBRARY_NOT_FOUND,
    ODBALMMSG2,
    ODBST,
    PRGDIR3,
    FocasError,
    FocasLibraryNotFound,
    load_library,
    parse_pmc_bit,
)
from bridge.program_text import canonical
from tests.fake_fwlib import CRLF_PROGRAM, FakeFwlib

NEW_PROGRAM = "%\nO9001(ROUNDTRIP TEST)\nG28U0W0\nG0X20.0Z5.0\nG1Z-10.0F0.2\nM30\n%"


@pytest.fixture
def fake() -> FakeFwlib:
    return FakeFwlib()


def make_driver(fake: FakeFwlib, **cfg: object) -> FocasDriver:
    config = FocasConfig(ip="10.0.0.9", backoff_initial_s=0.0, **cfg)  # type: ignore[arg-type]
    return FocasDriver(config, library_loader=lambda _p: fake, sleep=lambda _s: None)


@pytest.fixture
async def driver(fake: FakeFwlib) -> AsyncIterator[FocasDriver]:
    d = make_driver(fake)
    await d.connect()
    yield d
    await d.close()


# ---------- library loading ----------


def test_missing_library_has_clear_message(tmp_path: object) -> None:
    for path in (None, "C:/nope/Fwlib64.dll"):
        with pytest.raises(FocasLibraryNotFound) as ei:
            load_library(path)
        assert LIBRARY_NOT_FOUND in str(ei.value)
    assert LIBRARY_NOT_FOUND == "FOCAS library not found – obtain Fwlib from FANUC/machine supplier"


async def test_driver_connect_without_library_fails_clearly() -> None:
    d = FocasDriver(FocasConfig(ip="10.0.0.9", library_path=None))
    with pytest.raises(FocasLibraryNotFound, match="obtain Fwlib"):
        await d.connect()
    await d.close()


def test_struct_sizes_match_header() -> None:
    import ctypes as C

    long_sz = C.sizeof(C.c_long)
    assert C.sizeof(ODBST) == 9 * 2
    assert C.sizeof(ODBALMMSG2) == long_sz + 4 * 2 + 64 + (0 if long_sz == 4 else 4)
    assert C.sizeof(PRGDIR3) >= 3 * long_sz + 52 + 2 * 12


def test_pmc_address_parsing() -> None:
    b = parse_pmc_bit("r0100.3")
    assert (b.letter, b.number, b.bit, b.adr_type) == ("R", 100, 3, 5)
    for bad in ("R100", "Z0001.0", "R0001.9", ""):
        with pytest.raises(ValueError):
            parse_pmc_bit(bad)


# ---------- connection ----------


async def test_connect_retries_with_backoff(fake: FakeFwlib) -> None:
    fake.connect_failures = 2
    d = make_driver(fake, connect_attempts=4)
    await d.connect()
    assert d.connected and fake.calls.count("cnc_allclibhndl3") == 3
    await d.close()


async def test_connect_gives_up(fake: FakeFwlib) -> None:
    fake.connect_failures = 10
    d = make_driver(fake, connect_attempts=3)
    with pytest.raises(MachineConnectionError, match="after 3 attempts"):
        await d.connect()
    await d.close()


async def test_all_calls_on_one_thread(driver: FocasDriver, fake: FakeFwlib) -> None:
    await driver.read_status()
    await driver.list_programs()
    await driver.upload_program(1)
    assert len(fake.threads) == 1
    assert threading.get_ident() not in fake.threads  # not the event-loop thread


async def test_socket_error_marks_disconnected_and_frees_handle(
    driver: FocasDriver, fake: FakeFwlib
) -> None:
    fake.fail_next["cnc_statinfo"] = EW_SOCKET
    with pytest.raises(ConnectionLost):
        await driver.read_status()
    assert not driver.connected and fake.handles_open == 0
    with pytest.raises(ConnectionLost):
        await driver.read_status()
    await driver.connect()
    assert (await driver.read_status()).mode == Mode.MEM


# ---------- status ----------


async def test_status_mapping(driver: FocasDriver, fake: FakeFwlib) -> None:
    fake.run = 3
    s = await driver.read_status()
    assert s.mode == Mode.MEM and s.run_state == RunState.RUNNING
    assert s.program_number == 1 and s.sequence_number == 20
    assert s.spindle_speed == 1500 and s.part_count == 42 and s.feed_override == 100
    assert not s.alarm and s.alarms == [] and not s.emergency


@pytest.mark.parametrize(
    ("aut", "run", "mode", "state"),
    [
        (3, 0, Mode.EDIT, RunState.IDLE),
        (0, 2, Mode.MDI, RunState.FEED_HOLD),
        (5, 1, Mode.JOG, RunState.STOPPED),
    ],
)
async def test_mode_and_run_codes(
    driver: FocasDriver, fake: FakeFwlib, aut: int, run: int, mode: Mode, state: RunState
) -> None:
    fake.aut, fake.run = aut, run
    s = await driver.read_status()
    assert s.mode == mode and s.run_state == state


async def test_alarm_and_emergency(driver: FocasDriver, fake: FakeFwlib) -> None:
    fake.alarm_bits, fake.emergency = 0b100, 1
    s = await driver.read_status()
    assert s.alarm and s.emergency
    assert s.alarms[0].code == 1001 and s.alarms[0].message == "SPINDLE OVERHEAT"


# ---------- programs ----------


async def test_list_programs(driver: FocasDriver, fake: FakeFwlib) -> None:
    for n in range(2, 15):
        fake.programs[n] = f"%\nO{n:04d}(P{n})\nM30\n%"
    progs = await driver.list_programs()
    assert [p.number for p in progs] == list(range(1, 15))  # paged in batches of 10
    assert progs[0].comment == "FAKE PART"


async def test_upload_strips_cr_and_handles_busy_buffer(
    driver: FocasDriver, fake: FakeFwlib
) -> None:
    fake.buffer_busy_once.add("cnc_upload4")
    text = await driver.upload_program(1)
    assert "\r" not in text and text.startswith("%\n") and text.endswith("\n%")
    assert canonical(text) == canonical(CRLF_PROGRAM)
    assert fake.calls[-1] == "cnc_upend4"


async def test_upload_missing_program(driver: FocasDriver) -> None:
    with pytest.raises(ProgramNotFound):
        await driver.upload_program(77)


async def test_download_chunks_lf_and_roundtrip(driver: FocasDriver, fake: FakeFwlib) -> None:
    fake.buffer_busy_once.add("cnc_download4")
    assert await driver.download_program(NEW_PROGRAM.replace("\n", "\r\n")) == 9001
    stored = fake.programs[9001]
    assert "\r" not in stored and stored.startswith("%\n") and stored.endswith("\n%")
    assert fake.calls.count("cnc_download4") >= 3  # sent in several chunks
    back = await driver.upload_program(9001)
    assert canonical(back) == canonical(NEW_PROGRAM)


async def test_download_existing_number_rejected(driver: FocasDriver) -> None:
    with pytest.raises(ProgramExists):
        await driver.download_program(CRLF_PROGRAM)


async def test_delete_and_select(driver: FocasDriver, fake: FakeFwlib) -> None:
    await driver.download_program(NEW_PROGRAM)
    await driver.select_main_program(9001)
    assert fake.main_program == 9001
    await driver.delete_program(9001)
    assert 9001 not in fake.programs


# ---------- error mapping ----------


@pytest.mark.parametrize(
    ("code", "exc", "text"),
    [
        (EW_SOCKET, ConnectionLost, "Lost connection"),
        (EW_HANDLE, ConnectionLost, "Lost connection"),
        (EW_BUSY, MachineBusy, "busy"),
        (EW_REJECT, MachineBusy, "rejected"),
        (EW_ALARM, MachineAlarm, "alarm"),
        (EW_PROT, MachineBusy, "program-protect key"),
        (999, DriverError, "unknown error"),
    ],
)
def test_error_codes_map_to_clear_exceptions(code: int, exc: type, text: str) -> None:
    err = map_focas_error(FocasError("cnc_x", code))
    assert isinstance(err, exc) and text in str(err)


# ---------- remote control (safety rule 9) ----------


async def test_remote_control_off_by_default(driver: FocasDriver, fake: FakeFwlib) -> None:
    for action in (driver.cycle_start, driver.feed_hold, driver.reset_stop):
        with pytest.raises(RemoteControlNotAvailable):
            await action()
    assert fake.pmc_writes == []


async def test_remote_control_needs_address(fake: FakeFwlib) -> None:
    d = make_driver(fake, remote_control_enabled=True)
    await d.connect()
    with pytest.raises(RemoteControlNotAvailable):
        await d.cycle_start()
    assert fake.pmc_writes == []
    await d.close()


async def test_remote_cycle_start_pulses_configured_bit(fake: FakeFwlib) -> None:
    d = make_driver(fake, remote_control_enabled=True, pmc_start_address="R0100.2")
    await d.connect()
    fake.pmc[(5, 100)] = 0b1000_0001
    await d.cycle_start()
    assert fake.pmc_writes == [(5, 100, 0b1000_0101), (5, 100, 0b1000_0001)]
    await d.close()
