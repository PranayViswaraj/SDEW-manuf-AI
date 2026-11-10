"""MachineDriver interface shared by the simulated and FOCAS2 drivers."""

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

DEFAULT_FOLDER = "//CNC_MEM/USER/PATH1/"


class Mode(StrEnum):
    MEM = "MEM"
    EDIT = "EDIT"
    MDI = "MDI"
    JOG = "JOG"
    HANDLE = "HND"
    INC = "INC"
    REF = "REF"
    REMOTE = "RMT"
    TJOG = "TJOG"
    THND = "THND"
    UNKNOWN = "UNKNOWN"


class RunState(StrEnum):
    IDLE = "idle"  # FANUC "****" (reset)
    RUNNING = "running"  # STRT
    FEED_HOLD = "feed_hold"  # HOLD
    STOPPED = "stopped"  # STOP (M00/M01, single block)


@dataclass(frozen=True)
class Alarm:
    code: int
    message: str


@dataclass(frozen=True)
class MachineStatus:
    mode: Mode
    run_state: RunState
    alarm: bool
    alarms: list[Alarm]
    emergency: bool
    program_number: int | None
    sequence_number: int | None
    spindle_speed: float | None
    feed_override: int | None
    part_count: int | None
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["mode"] = self.mode.value
        d["run_state"] = self.run_state.value
        d["timestamp"] = self.timestamp.isoformat()
        return d

    @property
    def is_idle(self) -> bool:
        return self.run_state == RunState.IDLE


@dataclass(frozen=True)
class ProgramInfo:
    number: int
    comment: str
    size: int

    @property
    def name(self) -> str:
        return format_o_number(self.number)


# ---------- errors (messages are shown to operators: keep them plain) ----------


class DriverError(Exception):
    """Base class for all machine driver errors."""


class MachineConnectionError(DriverError):
    """Could not connect to the machine."""


class ConnectionLost(DriverError):
    def __init__(self, message: str = "Lost connection to the machine.") -> None:
        super().__init__(message)


class RemoteControlNotAvailable(DriverError):
    def __init__(self, message: str = "Remote control is off. Press Cycle Start at the machine."):
        super().__init__(message)


class MachineBusy(DriverError):
    """The machine is running or otherwise cannot accept the request now."""


class ProgramFormatError(DriverError):
    """Program text is not a valid FANUC program."""


class ProgramNotFound(DriverError):
    pass


class ProgramExists(DriverError):
    pass


class MachineAlarm(DriverError):
    """The controller refused the request because of an alarm."""


# ---------- helpers ----------


def format_o_number(number: int) -> str:
    return f"O{number:04d}"


def parse_o_number(value: str | int) -> int:
    """'O0001' / 'o1' / 1 -> 1. Range 1..9999 (0i-TF standard 4-digit O numbers)."""
    if isinstance(value, int):
        n = value
    else:
        v = value.strip().upper()
        if v.startswith("O"):
            v = v[1:]
        if not v.isdigit():
            raise ProgramFormatError(f"'{value}' is not a program number (example: O0001).")
        n = int(v)
    if not 1 <= n <= 9999:
        raise ProgramFormatError(f"Program number must be O0001 to O9999 (got {value}).")
    return n


class MachineDriver(ABC):
    """Async interface to one CNC. Implementations must be safe to call from one task."""

    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def disconnect(self) -> None: ...

    @property
    @abstractmethod
    def connected(self) -> bool: ...

    @abstractmethod
    async def read_status(self) -> MachineStatus: ...

    @abstractmethod
    async def list_programs(self, folder: str = DEFAULT_FOLDER) -> list[ProgramInfo]: ...

    @abstractmethod
    async def upload_program(self, number: int, folder: str = DEFAULT_FOLDER) -> str:
        """Read program text FROM the CNC (FANUC calls this 'upload')."""

    @abstractmethod
    async def download_program(self, text: str, folder: str = DEFAULT_FOLDER) -> int:
        """Send program text TO the CNC (FANUC 'download'). Returns the program number."""

    @abstractmethod
    async def delete_program(self, number: int, folder: str = DEFAULT_FOLDER) -> None: ...

    @abstractmethod
    async def select_main_program(self, number: int, folder: str = DEFAULT_FOLDER) -> None: ...

    @abstractmethod
    async def cycle_start(self) -> None:
        """Raise RemoteControlNotAvailable unless enabled with a configured PMC address."""

    @abstractmethod
    async def feed_hold(self) -> None: ...

    @abstractmethod
    async def reset_stop(self) -> None: ...
