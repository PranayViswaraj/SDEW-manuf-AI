"""FOCAS2 driver for the real FANUC 0i-TF.

Design:
- One dedicated worker thread per machine owns the FOCAS handle ("one handle per thread").
  Every library call runs in that thread via run_in_executor.
- connect() retries with exponential backoff; any socket/handle error marks the driver
  disconnected so the bridge reconnects on its next poll.
- Program text: sent with '%' markers and LF endings; '\\r' stripped from text read back.
- Remote control writes PMC bits only when enabled AND an address is configured; the ladder
  logic behind those bits is machine-specific and does not exist yet (TODO(REAL-DATA)).

Requires the licensed FANUC library (see docs/focas-notes.md). Untested on a real machine yet.
"""

import asyncio
import contextlib
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, TypeVar

from bridge.drivers.base import (
    DEFAULT_FOLDER,
    Alarm,
    ConnectionLost,
    DriverError,
    MachineAlarm,
    MachineBusy,
    MachineConnectionError,
    MachineDriver,
    MachineStatus,
    Mode,
    ProgramExists,
    ProgramFormatError,
    ProgramInfo,
    ProgramNotFound,
    RemoteControlNotAvailable,
    RunState,
    format_o_number,
)
from bridge.focas_ctypes import (
    EW_ALARM,
    EW_BUSY,
    EW_DATA,
    EW_HANDLE,
    EW_MODE,
    EW_NUMBER,
    EW_PASSWD,
    EW_PROT,
    EW_PROTOCOL,
    EW_REJECT,
    EW_RESET,
    EW_SOCKET,
    PMC_ADDRESS_TYPES,
    FocasError,
    Fwlib,
    load_library,
    parse_pmc_bit,
)
from bridge.program_text import from_received, program_number_from_text, to_send_format

T = TypeVar("T")

AUT_TO_MODE = {
    0: Mode.MDI,
    1: Mode.MEM,
    2: Mode.UNKNOWN,
    3: Mode.EDIT,
    4: Mode.HANDLE,
    5: Mode.JOG,
    6: Mode.TJOG,
    7: Mode.THND,
    8: Mode.INC,
    9: Mode.REF,
    10: Mode.REMOTE,
}
RUN_TO_STATE = {
    0: RunState.IDLE,
    1: RunState.STOPPED,
    2: RunState.FEED_HOLD,
    3: RunState.RUNNING,
    4: RunState.RUNNING,
}
CONNECTION_CODES = {EW_SOCKET, EW_HANDLE, EW_PROTOCOL}
PART_COUNT_PARAM = 6711  # number of machined parts.  # VERIFY ON MACHINE
FEED_OVERRIDE_PMC = ("G", 12)  # *FV0-*FV7, negative logic.  # VERIFY ON MACHINE


@dataclass
class FocasConfig:
    ip: str
    port: int = 8193
    library_path: str | None = None
    timeout_s: int = 10
    connect_attempts: int = 4
    backoff_initial_s: float = 0.5
    backoff_max_s: float = 8.0
    remote_control_enabled: bool = False
    # TODO(REAL-DATA): PMC bits for remote cycle start / feed hold / reset (ladder change).
    pmc_start_address: str | None = None
    pmc_feed_hold_address: str | None = None
    pmc_reset_address: str | None = None
    pmc_pulse_s: float = 0.3


def map_focas_error(e: FocasError, context: str = "") -> DriverError:
    """Turn a FOCAS return code into an operator-readable driver error."""
    prefix = f"{context}: " if context else ""
    code = e.code
    if code in CONNECTION_CODES:
        return ConnectionLost(f"{prefix}Lost connection to the machine ({e}).")
    if code in (EW_BUSY, EW_MODE, EW_REJECT, EW_RESET):
        return MachineBusy(f"{prefix}{e}")
    if code == EW_ALARM:
        return MachineAlarm(f"{prefix}{e}")
    if code == EW_PROT:
        return MachineBusy(f"{prefix}Program memory is protected. Turn the program-protect key.")
    if code == EW_PASSWD:
        return MachineBusy(f"{prefix}The program is locked by a password on the machine.")
    if code in (EW_DATA, EW_NUMBER):
        return ProgramNotFound(f"{prefix}{e}")
    return DriverError(f"{prefix}{e}")


class FocasDriver(MachineDriver):
    def __init__(
        self,
        config: FocasConfig,
        library_loader: Callable[[str | None], Any] = load_library,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.cfg = config
        self._loader = library_loader
        self._sleep = sleep
        self._fw: Fwlib | None = None
        self._handle: int | None = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"focas-{config.ip}")

    # ---------- thread plumbing ----------

    async def _run(self, fn: Callable[[], T]) -> T:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, fn)

    def _h(self) -> int:
        if self._handle is None or self._fw is None:
            raise ConnectionLost("Not connected to the machine.")
        return self._handle

    def _fwlib(self) -> Fwlib:
        if self._fw is None:
            raise ConnectionLost("Not connected to the machine.")
        return self._fw

    async def _call(self, fn: Callable[[Fwlib, int], T], context: str) -> T:
        def work() -> T:
            return fn(self._fwlib(), self._h())

        try:
            return await self._run(work)
        except FocasError as e:
            err = map_focas_error(e, context)
            if isinstance(err, ConnectionLost):
                await self._drop_handle()
            raise err from e

    async def _drop_handle(self) -> None:
        h, self._handle = self._handle, None
        if h is not None and self._fw is not None:
            fw = self._fw

            def free() -> None:
                with contextlib.suppress(FocasError):
                    fw.freelibhndl(h)

            await self._run(free)

    # ---------- connection ----------

    @property
    def connected(self) -> bool:
        return self._handle is not None

    async def connect(self) -> None:
        if self._fw is None:
            self._fw = Fwlib(await self._run(lambda: self._loader(self.cfg.library_path)))
        fw = self._fw
        delay = self.cfg.backoff_initial_s
        last: Exception | None = None
        for attempt in range(1, self.cfg.connect_attempts + 1):
            try:
                self._handle = await self._run(
                    lambda: fw.allclibhndl3(self.cfg.ip, self.cfg.port, self.cfg.timeout_s)
                )
                return
            except FocasError as e:
                last = e
                if attempt < self.cfg.connect_attempts:
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, self.cfg.backoff_max_s)
        raise MachineConnectionError(
            f"Cannot connect to the machine at {self.cfg.ip}:{self.cfg.port} after "
            f"{self.cfg.connect_attempts} attempts. {last}"
        )

    async def disconnect(self) -> None:
        await self._drop_handle()

    async def close(self) -> None:
        await self.disconnect()
        self._executor.shutdown(wait=True)

    # ---------- status ----------

    async def read_status(self) -> MachineStatus:
        def work(fw: Fwlib, h: int) -> MachineStatus:
            st = fw.statinfo(h)
            prg = fw.rdprgnum(h)
            seq = fw.rdseqnum(h)
            alarm_bits = fw.alarm2(h)
            alarms = [Alarm(code=c, message=m) for c, m in fw.rdalmmsg2(h)] if alarm_bits else []
            spindle = fw.acts(h)
            part_count: int | None
            try:
                part_count = fw.rdparam_word(h, PART_COUNT_PARAM)
            except FocasError:
                part_count = None
            feed: int | None
            try:
                letter, num = FEED_OVERRIDE_PMC
                feed = (~fw.pmc_read_byte(h, PMC_ADDRESS_TYPES[letter], num)) & 0xFF
            except FocasError:
                feed = None
            main = int(prg.mdata) or int(prg.data)
            return MachineStatus(
                mode=AUT_TO_MODE.get(int(st.aut), Mode.UNKNOWN),
                run_state=RUN_TO_STATE.get(int(st.run), RunState.IDLE),
                alarm=bool(alarm_bits) or int(st.alarm) == 1,
                alarms=alarms,
                emergency=int(st.emergency) == 1,
                program_number=main or None,
                sequence_number=seq or None,
                spindle_speed=float(spindle),
                feed_override=feed,
                part_count=part_count,
                timestamp=datetime.now(UTC),
            )

        return await self._call(work, "Read status")

    # ---------- programs ----------

    @staticmethod
    def _path(folder: str, number: int) -> str:
        folder = folder if folder.endswith("/") else folder + "/"
        return f"{folder}{format_o_number(number)}"

    async def list_programs(self, folder: str = DEFAULT_FOLDER) -> list[ProgramInfo]:
        if folder != DEFAULT_FOLDER:
            # cnc_rdprogdir3 lists the current folder only; other folders need
            # cnc_rdpdf_alldir.  # VERIFY ON MACHINE
            raise DriverError(f"Listing folder {folder} is not supported yet; use {DEFAULT_FOLDER}")

        def work(fw: Fwlib, h: int) -> list[ProgramInfo]:
            out: list[ProgramInfo] = []
            top = 0
            while True:
                batch = fw.rdprogdir3(h, top, 10)
                out += [ProgramInfo(number=n, comment=c, size=s) for n, s, c in batch]
                if len(batch) < 10:
                    return out
                top = batch[-1][0] + 1

        return await self._call(work, "List programs")

    async def upload_program(self, number: int, folder: str = DEFAULT_FOLDER) -> str:
        path = self._path(folder, number)
        raw = await self._call(lambda fw, h: fw.upload(h, path, self._sleep), f"Read {path}")
        return from_received(raw)

    async def download_program(self, text: str, folder: str = DEFAULT_FOLDER) -> int:
        number = program_number_from_text(text)
        data = to_send_format(text).encode("ascii", errors="strict")
        try:
            await self._call(lambda fw, h: fw.download(h, folder, data, self._sleep), "Send")
        except ProgramNotFound as e:
            # EW_DATA from cnc_dwnend4 means the number already exists (or bad program).
            raise ProgramExists(
                f"{format_o_number(number)} could not be stored: it already exists on the "
                f"machine or the program was rejected. ({e})"
            ) from e
        except UnicodeEncodeError as e:  # pragma: no cover - guarded by to_send_format
            raise ProgramFormatError("Program contains non-ASCII characters.") from e
        return number

    async def delete_program(self, number: int, folder: str = DEFAULT_FOLDER) -> None:
        path = self._path(folder, number)
        await self._call(lambda fw, h: fw.pdf_del(h, path), f"Delete {path}")

    async def select_main_program(self, number: int, folder: str = DEFAULT_FOLDER) -> None:
        path = self._path(folder, number)
        await self._call(lambda fw, h: fw.pdf_slctmain(h, path), f"Select {path}")

    # ---------- remote control (safety rule 9) ----------

    def _require_remote(self, address: str | None) -> str:
        if not self.cfg.remote_control_enabled or not address:
            raise RemoteControlNotAvailable()
        return address

    async def _pulse(self, address: str, context: str) -> None:
        """Set a PMC bit, hold for pmc_pulse_s, clear it.  # VERIFY ON MACHINE with ladder."""
        bit = parse_pmc_bit(address)
        pulse = self.cfg.pmc_pulse_s

        def work(fw: Fwlib, h: int) -> None:
            value = fw.pmc_read_byte(h, bit.adr_type, bit.number)
            fw.pmc_write_byte(h, bit.adr_type, bit.number, value | (1 << bit.bit))
            try:
                self._sleep(pulse)
            finally:
                value = fw.pmc_read_byte(h, bit.adr_type, bit.number)
                fw.pmc_write_byte(h, bit.adr_type, bit.number, value & ~(1 << bit.bit))

        await self._call(work, context)

    async def cycle_start(self) -> None:
        await self._pulse(self._require_remote(self.cfg.pmc_start_address), "Cycle start")

    async def feed_hold(self) -> None:
        await self._pulse(self._require_remote(self.cfg.pmc_feed_hold_address), "Feed hold")

    async def reset_stop(self) -> None:
        await self._pulse(self._require_remote(self.cfg.pmc_reset_address), "Reset")
