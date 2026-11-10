"""Simulated FANUC 0i-TF for development and tests. No real machine is touched.

Behaviour copied from the real control where it matters for safety:
- programs live in folders, O-number format enforced, existing numbers are not overwritten;
- download / delete / select are refused while a program is running;
- a running program steps through blocks over time; M00 stops, M30 ends (part count + 1),
  M99 Pn jumps to sequence Nn, M99 alone rewinds; S..M3/M4 sets spindle speed, M5 stops it;
- alarms, emergency stop and connection drops can be injected for testing.

Two clocks: background task (real use, `block_time_s`) or manual (`manual_clock=True`, tests call
`advance()`).
"""

import asyncio
import contextlib
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime

from bridge.drivers.base import (
    DEFAULT_FOLDER,
    Alarm,
    ConnectionLost,
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
from bridge.program_text import (
    program_comment,
    program_lines,
    program_number_from_text,
    to_send_format,
)

_WORD = re.compile(r"([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))")
_COMMENT = re.compile(r"\([^)]*\)")


@dataclass
class SimConfig:
    block_time_s: float = 0.25
    manual_clock: bool = False
    remote_control_enabled: bool = False
    pmc_start_address: str | None = None
    # Simulates the operator pressing Cycle Start on the machine panel N seconds after a
    # program has been selected. None = never (operator must press it via press_cycle_start).
    auto_cycle_start_after_s: float | None = None
    optional_stop: bool = False  # M01 stops only when the optional-stop switch is on
    fail_connect: bool = False
    drop_connection_after_reads: int | None = None
    initial_programs: dict[int, str] = field(default_factory=dict)


@dataclass
class _Block:
    raw: str
    words: dict[str, float]
    seq: int | None


def _parse_block(line: str) -> _Block:
    code = _COMMENT.sub("", line).upper()
    words: dict[str, float] = {}
    for letter, value in _WORD.findall(code):
        # Keep the first occurrence of each letter except M (several M codes allowed per block).
        if letter == "M":
            words.setdefault("M", float(value))
            words[f"M{float(value):g}"] = 1.0
        else:
            words.setdefault(letter, float(value))
    seq = int(words["N"]) if "N" in words else None
    return _Block(raw=line, words=words, seq=seq)


class SimulatedDriver(MachineDriver):
    def __init__(self, config: SimConfig | None = None) -> None:
        self.cfg = config or SimConfig()
        self._connected = False
        self._reads = 0
        self.folders: dict[str, dict[int, str]] = {DEFAULT_FOLDER: {}}
        for number, text in self.cfg.initial_programs.items():
            self.folders[DEFAULT_FOLDER][number] = to_send_format(text)
        self.mode = Mode.MEM
        self.run_state = RunState.IDLE
        self.alarms: list[Alarm] = []
        self.emergency = False
        self.selected: int | None = None
        self.block_index = 0
        self.sequence: int | None = None
        self.spindle = 0.0
        self.feed_override = 100
        self.part_count = 0
        self._last_s = 0.0
        self._blocks: list[_Block] = []
        self._task: asyncio.Task[None] | None = None
        self._armed_at: float | None = None
        self.panel_events: list[str] = []

    # ---------- connection ----------

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        if self.cfg.fail_connect:
            raise MachineConnectionError("Simulated machine refused the connection.")
        self._connected = True
        self._reads = 0
        if not self.cfg.manual_clock and self._task is None:
            self._task = asyncio.create_task(self._clock())

    async def disconnect(self) -> None:
        self._connected = False
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def drop_connection(self) -> None:
        """Test hook: the network cable is pulled. Calls fail until connect() again."""
        self._connected = False

    def _require_connection(self) -> None:
        if not self._connected:
            raise ConnectionLost()

    # ---------- status ----------

    async def read_status(self) -> MachineStatus:
        self._require_connection()
        self._reads += 1
        limit = self.cfg.drop_connection_after_reads
        if limit is not None and self._reads > limit:
            self.drop_connection()
            raise ConnectionLost()
        return MachineStatus(
            mode=self.mode,
            run_state=self.run_state,
            alarm=bool(self.alarms),
            alarms=list(self.alarms),
            emergency=self.emergency,
            program_number=self.selected,
            sequence_number=self.sequence,
            spindle_speed=self.spindle,
            feed_override=self.feed_override,
            part_count=self.part_count,
            timestamp=datetime.now(UTC),
        )

    # ---------- programs ----------

    def _folder(self, folder: str) -> dict[int, str]:
        if folder not in self.folders:
            raise ProgramNotFound(f"Folder {folder} does not exist on the machine.")
        return self.folders[folder]

    def _is_running(self) -> bool:
        return self.run_state in (RunState.RUNNING, RunState.FEED_HOLD, RunState.STOPPED)

    async def list_programs(self, folder: str = DEFAULT_FOLDER) -> list[ProgramInfo]:
        self._require_connection()
        return [
            ProgramInfo(number=n, comment=program_comment(t), size=len(t))
            for n, t in sorted(self._folder(folder).items())
        ]

    async def upload_program(self, number: int, folder: str = DEFAULT_FOLDER) -> str:
        self._require_connection()
        progs = self._folder(folder)
        if number not in progs:
            raise ProgramNotFound(f"{format_o_number(number)} is not on the machine.")
        return progs[number]

    async def download_program(self, text: str, folder: str = DEFAULT_FOLDER) -> int:
        self._require_connection()
        if self._is_running():
            raise MachineBusy("Cannot send a program while the machine is running.")
        if self.mode not in (Mode.EDIT, Mode.MEM):
            raise MachineBusy(f"Machine is in {self.mode} mode. Switch to EDIT or MEM.")
        number = program_number_from_text(text)  # raises ProgramFormatError
        if text.count("(") != text.count(")"):
            raise ProgramFormatError("Unbalanced brackets in the program comments.")
        progs = self._folder(folder)
        if number in progs:
            # Real 0i-TF answers EW_DATA: program already exists.
            raise ProgramExists(f"{format_o_number(number)} already exists on the machine.")
        progs[number] = to_send_format(text)
        return number

    async def delete_program(self, number: int, folder: str = DEFAULT_FOLDER) -> None:
        self._require_connection()
        progs = self._folder(folder)
        if number not in progs:
            raise ProgramNotFound(f"{format_o_number(number)} is not on the machine.")
        if number == self.selected and self._is_running():
            raise MachineBusy("Cannot delete the program that is running.")
        del progs[number]
        if number == self.selected:
            self.selected = None

    async def select_main_program(self, number: int, folder: str = DEFAULT_FOLDER) -> None:
        self._require_connection()
        if self._is_running():
            raise MachineBusy("Cannot change the main program while the machine is running.")
        progs = self._folder(folder)
        if number not in progs:
            raise ProgramNotFound(f"{format_o_number(number)} is not on the machine.")
        self.selected = number
        # First line is the O-number header, not an executable block.
        self._blocks = [_parse_block(ln) for ln in program_lines(progs[number])[1:]]
        self.block_index = 0
        self.sequence = None
        self._arm_auto_start()

    # ---------- remote control (gated, safety rule 9) ----------

    def _remote_allowed(self) -> None:
        if not self.cfg.remote_control_enabled or not self.cfg.pmc_start_address:
            raise RemoteControlNotAvailable()

    async def cycle_start(self) -> None:
        self._require_connection()
        self._remote_allowed()
        if not self.press_cycle_start():
            raise MachineBusy(self._why_cannot_start())

    async def feed_hold(self) -> None:
        self._require_connection()
        self._remote_allowed()
        self.press_feed_hold()

    async def reset_stop(self) -> None:
        self._require_connection()
        self._remote_allowed()
        self.press_reset()

    # ---------- physical panel (what an operator does at the machine) ----------

    def _why_cannot_start(self) -> str:
        if self.emergency:
            return "Emergency stop is pressed on the machine."
        if self.alarms:
            return "The machine has an alarm. Clear it at the machine first."
        if self.mode != Mode.MEM:
            return f"Machine is in {self.mode} mode, not MEM (auto)."
        if self.selected is None:
            return "No program is selected on the machine."
        if self.run_state == RunState.RUNNING:
            return "The machine is already running."
        return "The machine cannot start now."

    def press_cycle_start(self) -> bool:
        """Cycle Start button on the machine. Returns True if the machine started."""
        if (
            self.emergency
            or self.alarms
            or self.mode != Mode.MEM
            or self.selected is None
            or self.run_state == RunState.RUNNING
        ):
            return False
        self.panel_events.append("cycle_start")
        self._armed_at = None
        self.run_state = RunState.RUNNING
        return True

    def press_feed_hold(self) -> None:
        if self.run_state == RunState.RUNNING:
            self.panel_events.append("feed_hold")
            self.run_state = RunState.FEED_HOLD

    def press_reset(self) -> None:
        self.panel_events.append("reset")
        self.run_state = RunState.IDLE
        self.block_index = 0
        self.sequence = None
        self.spindle = 0.0
        self._armed_at = None

    def inject_alarm(self, code: int, message: str) -> None:
        self.alarms.append(Alarm(code=code, message=message))
        if self._is_running():
            self.run_state = RunState.STOPPED
            self.spindle = 0.0

    def clear_alarms(self) -> None:
        self.alarms.clear()

    def set_emergency(self, pressed: bool) -> None:
        self.emergency = pressed
        if pressed:
            self.press_reset()

    # ---------- execution ----------

    def _arm_auto_start(self) -> None:
        if self.cfg.auto_cycle_start_after_s is not None:
            self._armed_at = time.monotonic()

    async def _clock(self) -> None:
        while True:
            await asyncio.sleep(self.cfg.block_time_s)
            self.tick()

    def tick(self) -> None:
        """One clock step: maybe auto-start, then execute one block if running."""
        if self._armed_at is not None and self.run_state == RunState.IDLE:
            delay = self.cfg.auto_cycle_start_after_s or 0.0
            if time.monotonic() - self._armed_at >= delay:
                self.press_cycle_start()
        if self.run_state == RunState.RUNNING:
            self._execute_next()

    def advance(self, blocks: int = 1) -> None:
        """Manual clock (tests): execute up to `blocks` blocks."""
        for _ in range(blocks):
            if self.run_state != RunState.RUNNING:
                return
            self._execute_next()

    def _jump_to(self, seq: int) -> bool:
        for i, b in enumerate(self._blocks):
            if b.seq == seq:
                self.block_index = i
                return True
        return False

    def _end_of_program(self) -> None:
        self.part_count += 1
        self.run_state = RunState.IDLE
        self.block_index = 0
        self.sequence = None
        self.spindle = 0.0

    def _execute_next(self) -> None:
        if self.block_index >= len(self._blocks):
            self._end_of_program()
            return
        block = self._blocks[self.block_index]
        self.block_index += 1
        w = block.words
        if block.seq is not None:
            self.sequence = block.seq
        if "S" in w:
            self._last_s = w["S"]
        if "M3" in w or "M4" in w:
            self.spindle = self._last_s
        elif "S" in w and self.spindle > 0:
            self.spindle = w["S"]
        if "M5" in w:
            self.spindle = 0.0
        if "M0" in w or (self.cfg.optional_stop and "M1" in w):
            self.run_state = RunState.STOPPED
            return
        if "M30" in w or "M2" in w:
            self._end_of_program()
            return
        if "M99" in w:
            if "P" in w and self._jump_to(int(w["P"])):
                return
            self.block_index = 0  # M99 in a main program rewinds
            self.part_count += 1
