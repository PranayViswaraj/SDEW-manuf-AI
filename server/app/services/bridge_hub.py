"""In-memory hub for connected bridges: live machine status and command round-trips.

Single server process assumption (first release). With several server workers this state would
need to move to a shared store (e.g. Redis) - see docs/architecture.md.

Live status states shown in the UI (safety rule 8):
  online              bridge connected, fresh status (< status_stale_seconds), machine reachable
  machine_unreachable bridge connected and fresh, but the bridge cannot reach the CNC
  stale               bridge connected but no status for > status_stale_seconds
  offline             bridge not connected (or never reported this machine)
"""

import asyncio
import contextlib
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from app.services.command_signing import sign


class WebSocketLike(Protocol):
    async def send_json(self, data: Any) -> None: ...
    async def close(self, code: int = 1000, reason: str | None = None) -> None: ...


class BridgeUnavailable(Exception):
    def __init__(self, message: str = "The machine's bridge is offline. Nothing was sent.") -> None:
        super().__init__(message)


class CommandTimeout(Exception):
    def __init__(self, seconds: float) -> None:
        super().__init__(f"No answer from the bridge within {seconds:.0f} s. Check the machine.")


@dataclass
class Conn:
    name: str
    ws: WebSocketLike
    signing_key: str
    connected_at: datetime
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_heartbeat: float = 0.0
    machines: list[dict[str, Any]] = field(default_factory=list)
    bridge_version: str | None = None


@dataclass
class LiveEntry:
    bridge: str
    status: dict[str, Any] | None
    machine_connected: bool
    error: str | None
    driver: str | None
    loaded_program: int | None
    received_mono: float
    received_at: datetime


class BridgeHub:
    def __init__(self, stale_after_s: float, clock: Callable[[], float] = time.monotonic):
        self.stale_after_s = stale_after_s
        self.clock = clock
        self.connections: dict[str, Conn] = {}
        self.live: dict[str, LiveEntry] = {}
        self._pending: dict[str, tuple[str, asyncio.Future[dict[str, Any]]]] = {}

    # ---------- connections ----------

    async def register(self, name: str, ws: WebSocketLike, signing_key: str) -> Conn:
        old = self.connections.get(name)
        conn = Conn(name=name, ws=ws, signing_key=signing_key, connected_at=datetime.now(UTC))
        conn.last_heartbeat = self.clock()
        self.connections[name] = conn
        if old is not None:  # same bridge reconnected: drop the stale socket
            self._fail_pending(name)
            with contextlib.suppress(Exception):  # socket may already be dead
                await old.ws.close(code=4000, reason="replaced by a new connection")
        return conn

    def unregister(self, conn: Conn) -> None:
        if self.connections.get(conn.name) is conn:
            del self.connections[conn.name]
            self._fail_pending(conn.name)

    def _fail_pending(self, bridge: str) -> None:
        for cid, (b, fut) in list(self._pending.items()):
            if b == bridge and not fut.done():
                fut.set_exception(BridgeUnavailable("The bridge disconnected before answering."))
                self._pending.pop(cid, None)

    def is_connected(self, bridge: str | None) -> bool:
        return bridge is not None and bridge in self.connections

    # ---------- incoming messages ----------

    def heartbeat(self, conn: Conn) -> None:
        conn.last_heartbeat = self.clock()

    def update_status(self, bridge: str, msg: dict[str, Any]) -> None:
        self.live[str(msg["machine_id"])] = LiveEntry(
            bridge=bridge,
            status=msg.get("status"),
            machine_connected=bool(msg.get("connected")),
            error=msg.get("error"),
            driver=msg.get("driver"),
            loaded_program=msg.get("loaded_program"),
            received_mono=self.clock(),
            received_at=datetime.now(UTC),
        )

    def resolve_ack(self, msg: dict[str, Any]) -> None:
        item = self._pending.pop(str(msg.get("command_id")), None)
        if item is not None and not item[1].done():
            item[1].set_result(msg)

    # ---------- reading ----------

    def live_view(self, machine_key: str, bridge: str | None) -> dict[str, Any]:
        entry = self.live.get(machine_key)
        connected = self.is_connected(bridge)
        age = None if entry is None else round(self.clock() - entry.received_mono, 1)
        if not connected or entry is None or entry.bridge != bridge:
            state = "offline"
        elif age is not None and age > self.stale_after_s:
            state = "stale"
        elif not entry.machine_connected:
            state = "machine_unreachable"
        else:
            state = "online"
        return {
            "state": state,
            "bridge_connected": connected,
            "age_s": age,
            "received_at": entry.received_at.isoformat() if entry else None,
            "machine_connected": bool(entry and entry.machine_connected),
            "driver": entry.driver if entry else None,
            "status": entry.status if entry and state != "offline" else None,
            "loaded_program": entry.loaded_program if entry else None,
            "error": entry.error if entry else None,
        }

    def fresh_status(self, machine_key: str, bridge: str | None) -> dict[str, Any] | None:
        """Status only if it is fresh and the machine is reachable; else None."""
        view = self.live_view(machine_key, bridge)
        return view["status"] if view["state"] == "online" else None

    # ---------- commands ----------

    def build_command(
        self,
        *,
        action: str,
        machine_key: str,
        user_id: int,
        program_id: int | None = None,
        program_hash: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cmd: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "action": action,
            "machine_id": machine_key,
            "program_id": program_id,
            "program_hash": program_hash,
            "user_id": user_id,
            "issued_at": datetime.now(UTC).isoformat(),
        }
        cmd |= extra or {}
        return cmd

    async def send_command(
        self, bridge: str | None, command: dict[str, Any], timeout_s: float
    ) -> dict[str, Any]:
        conn = self.connections.get(bridge or "")
        if conn is None:
            raise BridgeUnavailable()
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[command["id"]] = (conn.name, fut)
        message = {
            "type": "command",
            "command": command,
            "signature": sign(command, conn.signing_key),
        }
        try:
            async with conn.send_lock:
                await conn.ws.send_json(message)
        except Exception as e:
            self._pending.pop(command["id"], None)
            raise BridgeUnavailable(f"Could not reach the bridge: {e}") from e
        try:
            return await asyncio.wait_for(fut, timeout=timeout_s)
        except TimeoutError as e:
            self._pending.pop(command["id"], None)
            raise CommandTimeout(timeout_s) from e
