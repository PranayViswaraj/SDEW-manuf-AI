"""Outbound-only WebSocket link to the ManufAI server (safety rules 5 and 8).

The bridge never listens on a port. It dials out, sends hello / heartbeats / status, and only
acts on signed commands it receives. When the link drops it keeps polling the machines locally
but takes NO machine action and queues nothing; commands that arrive late are rejected as expired.
"""

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

from bridge import __version__
from bridge.actions import Dispatcher, MachineEntry
from bridge.config import BridgeConfig
from bridge.drivers.base import DriverError

log = logging.getLogger("bridge.ws")

Connector = Callable[..., Any]


def _now() -> str:
    return datetime.now(UTC).isoformat()


class BridgeService:
    def __init__(
        self,
        config: BridgeConfig,
        machines: dict[str, MachineEntry],
        connector: Connector = connect,
        backoff_initial_s: float = 1.0,
        backoff_max_s: float = 30.0,
    ) -> None:
        self.cfg = config
        self.machines = machines
        self.dispatcher = Dispatcher(machines, config.signing_key, config.command_max_age_s)
        self._connector = connector
        self._backoff_initial = backoff_initial_s
        self._backoff_max = backoff_max_s
        self._stop = asyncio.Event()
        self.connected = asyncio.Event()
        self.sessions = 0
        self.last_error: str | None = None

    def stop(self) -> None:
        self._stop.set()

    async def run_forever(self) -> None:
        delay = self._backoff_initial
        while not self._stop.is_set():
            try:
                async with self._connector(
                    self.cfg.server_url,
                    additional_headers={"Authorization": f"Bearer {self.cfg.bridge_token}"},
                    open_timeout=10,
                    ping_interval=20,
                    max_size=8 * 1024 * 1024,
                ) as ws:
                    delay = self._backoff_initial
                    self.sessions += 1
                    log.info("Connected to %s", self.cfg.server_url)
                    await self._session(ws)
            except (OSError, WebSocketException, TimeoutError) as e:
                self.last_error = str(e) or type(e).__name__
                log.warning("Server link down: %s. Retrying in %.0f s.", self.last_error, delay)
            finally:
                self.connected.clear()
            if self._stop.is_set():
                break
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            delay = min(delay * 2, self._backoff_max)
        await self._disconnect_drivers()

    async def _disconnect_drivers(self) -> None:
        for entry in self.machines.values():
            with contextlib.suppress(DriverError):
                await entry.driver.disconnect()

    # ---------- one connected session ----------

    async def _session(self, ws: ClientConnection) -> None:
        send_lock = asyncio.Lock()

        async def send(msg: dict[str, Any]) -> None:
            async with send_lock:
                await ws.send(json.dumps(msg))

        await send(
            {
                "type": "hello",
                "bridge_version": __version__,
                "machines": [
                    {"id": key, "driver": e.config.driver} for key, e in self.machines.items()
                ],
            }
        )
        self.connected.set()
        tasks = [
            asyncio.create_task(self._heartbeat(send)),
            asyncio.create_task(self._poll(send)),
        ]
        stopper = asyncio.create_task(self._stop.wait())
        receiver = asyncio.create_task(self._receive(ws, send))
        try:
            done, _ = await asyncio.wait(
                [receiver, stopper, *tasks], return_when=asyncio.FIRST_COMPLETED
            )
            for t in done:
                if t is not stopper and t.exception() is not None:
                    raise t.exception()  # type: ignore[misc]
        finally:
            for t in (receiver, stopper, *tasks):
                t.cancel()
            await asyncio.gather(receiver, stopper, *tasks, return_exceptions=True)

    async def _heartbeat(self, send: Callable[[dict[str, Any]], Any]) -> None:
        while True:
            await send({"type": "heartbeat", "ts": _now()})
            await asyncio.sleep(self.cfg.heartbeat_interval_s)

    async def _poll(self, send: Callable[[dict[str, Any]], Any]) -> None:
        while True:
            for key, entry in self.machines.items():
                await send(await self.poll_machine(key, entry))
            await asyncio.sleep(self.cfg.poll_interval_s)

    @staticmethod
    async def poll_machine(key: str, entry: MachineEntry) -> dict[str, Any]:
        """Read one machine. Reconnects the driver if needed. Never writes to the machine."""
        msg: dict[str, Any] = {
            "type": "status",
            "machine_id": key,
            "driver": entry.config.driver,
            "ts": _now(),
        }
        async with entry.lock:
            try:
                if not entry.driver.connected:
                    await entry.driver.connect()
                st = await entry.driver.read_status()
                msg |= {
                    "connected": True,
                    "status": st.to_dict(),
                    "error": None,
                    "loaded_program": entry.loaded[0] if entry.loaded else None,
                }
            except DriverError as e:
                msg |= {"connected": False, "status": None, "error": str(e)}
        return msg

    async def _receive(self, ws: ClientConnection, send: Callable[[dict[str, Any]], Any]) -> None:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except (TypeError, ValueError):
                log.warning("Ignored non-JSON message from server")
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "command":
                ack = await self.dispatcher.handle(msg)
                await send(ack.to_message())
            elif msg.get("type") == "error":
                log.error("Server error: %s", msg.get("message"))
            # anything else is ignored: the server cannot make the bridge do other things
