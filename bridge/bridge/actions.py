"""Allow-list command dispatcher (safety rules 4, 6, 8, 9).

Every command from the server is checked here before anything touches a machine:
  signature -> allowed action -> not expired -> not replayed -> known machine -> hash
and then action-specific machine checks. Every rejection is logged locally and acked.
"""

import asyncio
import hashlib
import logging
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final, Literal

from bridge.config import MachineConfig
from bridge.drivers.base import (
    DriverError,
    MachineDriver,
    MachineStatus,
    Mode,
    ProgramExists,
    ProgramNotFound,
    RunState,
    format_o_number,
)
from bridge.program_text import canonical, canonical_hash, program_number_from_text
from bridge.signing import verify

log = logging.getLogger("bridge.actions")

ALLOWED_ACTIONS: Final[frozenset[str]] = frozenset(
    {"send_program", "start", "feed_hold", "stop", "read_status"}
)

# Actions that physically move or stop the machine. Gated by remote_control_enabled (rule 9).
REMOTE_CONTROL_ACTIONS: Final[frozenset[str]] = frozenset({"start", "feed_hold", "stop"})

REMOTE_OFF_MESSAGE = "Remote control is off for this machine. Press Cycle Start at the machine."

Result = Literal["ok", "rejected", "failed"]


def is_allowed(action: str) -> bool:
    return action in ALLOWED_ACTIONS


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class Ack:
    command_id: str
    result: Result
    error: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def to_message(self) -> dict[str, Any]:
        return {
            "type": "ack",
            "command_id": self.command_id,
            "result": self.result,
            "error": self.error,
            "details": self.details,
        }


@dataclass
class MachineEntry:
    config: MachineConfig
    driver: MachineDriver
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Program this bridge sent, verified by read-back and selected: (number, server hash).
    loaded: tuple[int, str] | None = None


class Rejected(Exception):
    pass


class Dispatcher:
    def __init__(
        self,
        machines: dict[str, MachineEntry],
        signing_key: str,
        max_age_s: float = 10.0,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        replay_memory: int = 1000,
    ) -> None:
        self.machines = machines
        self.signing_key = signing_key
        self.max_age_s = max_age_s
        self.clock = clock
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._replay_memory = replay_memory

    # ---------- entry point ----------

    async def handle(self, message: dict[str, Any]) -> Ack:
        cmd = message.get("command")
        cmd_id = str(cmd.get("id", "")) if isinstance(cmd, dict) else ""
        try:
            if not isinstance(cmd, dict):
                raise Rejected("Malformed command message.")
            self._check_envelope(cmd, str(message.get("signature", "")))
            entry = self.machines[cmd["machine_id"]]
            async with entry.lock:
                ack = await self._run(entry, cmd)
        except Rejected as e:
            log.warning("REJECTED command %s: %s (%s)", cmd_id or "?", e, _summary(cmd))
            return Ack(cmd_id, "rejected", str(e))
        except DriverError as e:
            log.error("FAILED command %s: %s (%s)", cmd_id, e, _summary(cmd))
            return Ack(cmd_id, "failed", str(e))
        log.info("OK command %s %s", cmd_id, _summary(cmd))
        return ack

    # ---------- generic checks ----------

    def _check_envelope(self, cmd: dict[str, Any], signature: str) -> None:
        if not verify(cmd, signature, self.signing_key):
            raise Rejected("Command signature is not valid.")
        action = cmd.get("action")
        if not isinstance(action, str) or not is_allowed(action):
            raise Rejected(f"Action '{action}' is not allowed.")
        try:
            issued = datetime.fromisoformat(str(cmd["issued_at"]))
        except (KeyError, ValueError) as e:
            raise Rejected("Command has no valid issued_at time.") from e
        if issued.tzinfo is None:
            raise Rejected("Command time must include a timezone.")
        age = (self.clock() - issued).total_seconds()
        if age > self.max_age_s:
            raise Rejected(f"Command expired ({age:.1f} s old, limit {self.max_age_s:.0f} s).")
        if age < -self.max_age_s:
            raise Rejected("Command time is in the future. Check the PC clock (NTP).")
        cmd_id = str(cmd.get("id", ""))
        if not cmd_id:
            raise Rejected("Command has no id.")
        if cmd_id in self._seen:
            raise Rejected("Command was already received (replay).")
        self._seen[cmd_id] = None
        while len(self._seen) > self._replay_memory:
            self._seen.popitem(last=False)
        if cmd.get("machine_id") not in self.machines:
            raise Rejected(f"Machine '{cmd.get('machine_id')}' is not connected to this bridge.")

    @staticmethod
    def _check_ready(status: MachineStatus, what: str) -> None:
        if status.emergency:
            raise Rejected(f"Cannot {what}: emergency stop is pressed on the machine.")
        if status.alarm:
            codes = ", ".join(f"{a.code} {a.message}" for a in status.alarms) or "alarm"
            raise Rejected(f"Cannot {what}: the machine has an alarm ({codes}).")
        if status.run_state != RunState.IDLE:
            raise Rejected(f"Cannot {what}: the machine is not idle ({status.run_state}).")

    # ---------- actions ----------

    async def _run(self, entry: MachineEntry, cmd: dict[str, Any]) -> Ack:
        action = cmd["action"]
        if action in REMOTE_CONTROL_ACTIONS and not entry.config.remote_control_enabled:
            raise Rejected(REMOTE_OFF_MESSAGE)
        handler = {
            "read_status": self._read_status,
            "send_program": self._send_program,
            "start": self._start,
            "feed_hold": self._feed_hold,
            "stop": self._stop,
        }[action]
        return await handler(entry, cmd)

    async def _read_status(self, entry: MachineEntry, cmd: dict[str, Any]) -> Ack:
        st = await entry.driver.read_status()
        return Ack(cmd["id"], "ok", details={"status": st.to_dict()})

    async def _send_program(self, entry: MachineEntry, cmd: dict[str, Any]) -> Ack:
        text = cmd.get("program_text")
        expected = cmd.get("program_hash")
        if not isinstance(text, str) or not text:
            raise Rejected("send_program needs the program text.")
        if not expected or sha256_text(text) != expected:
            raise Rejected("Program hash does not match the program text (hash mismatch).")
        number = program_number_from_text(text)
        if cmd.get("program_number") not in (None, number):
            raise Rejected("Program number does not match the program text.")

        self._check_ready(await entry.driver.read_status(), "send a program")

        replaced, already_present = False, False
        try:
            existing = await entry.driver.upload_program(number)
        except ProgramNotFound:
            existing = None
        if existing is not None and canonical(existing) == canonical(text):
            already_present = True
        else:
            if existing is not None:
                await entry.driver.delete_program(number)
                replaced = True
            entry.loaded = None
            try:
                await entry.driver.download_program(text)
            except ProgramExists as e:
                raise DriverError(str(e)) from e

        back = await entry.driver.upload_program(number)
        if canonical_hash(back) != canonical_hash(text):
            entry.loaded = None
            return Ack(
                cmd["id"],
                "failed",
                f"Read-back check failed: {format_o_number(number)} on the machine differs "
                "from the approved program. Do not run it.",
                {"program_number": number},
            )
        await entry.driver.select_main_program(number)
        entry.loaded = (number, expected)
        return Ack(
            cmd["id"],
            "ok",
            details={
                "program_number": number,
                "readback_canonical_hash": canonical_hash(back),
                "replaced_existing": replaced,
                "already_present": already_present,
            },
        )

    async def _start(self, entry: MachineEntry, cmd: dict[str, Any]) -> Ack:
        st = await entry.driver.read_status()
        self._check_ready(st, "start")
        if st.mode != Mode.MEM:
            raise Rejected(f"Cannot start: machine is in {st.mode} mode, not MEM.")
        if entry.loaded is None:
            raise Rejected("Cannot start: no verified program was sent by ManufAI.")
        number, loaded_hash = entry.loaded
        if cmd.get("program_hash") != loaded_hash:
            raise Rejected("Cannot start: the approved program is not the one loaded.")
        if st.program_number != number:
            raise Rejected(
                f"Cannot start: machine has {format_o_number(st.program_number or 0)} selected, "
                f"expected {format_o_number(number)}."
            )
        await entry.driver.cycle_start()
        return Ack(cmd["id"], "ok", details={"program_number": number})

    async def _feed_hold(self, entry: MachineEntry, cmd: dict[str, Any]) -> Ack:
        await entry.driver.feed_hold()
        return Ack(cmd["id"], "ok")

    async def _stop(self, entry: MachineEntry, cmd: dict[str, Any]) -> Ack:
        await entry.driver.reset_stop()
        return Ack(cmd["id"], "ok")


def _summary(cmd: Any) -> str:
    if not isinstance(cmd, dict):
        return "malformed"
    keys = ("action", "machine_id", "program_id", "program_hash", "user_id", "issued_at")
    return " ".join(f"{k}={cmd.get(k)}" for k in keys)
