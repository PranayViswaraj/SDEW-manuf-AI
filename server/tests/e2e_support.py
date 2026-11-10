"""Shared helpers for end-to-end tests: a real uvicorn server and a real bridge in threads."""

import asyncio
import hashlib
import socket
import threading
import time
from collections.abc import Callable, Coroutine, Iterator
from pathlib import Path
from typing import Any, TypeVar

import httpx
import pytest
import uvicorn

# The bridge package is a dev dependency (scripts/setup.* install it into the same venv).
from bridge.actions import MachineEntry
from bridge.config import BridgeConfig, MachineConfig
from bridge.drivers.simulated import SimConfig, SimulatedDriver
from bridge.ws_client import BridgeService
from sqlalchemy import select

from app.config import Settings
from app.db.models import AuditLog, Machine, User
from app.main import create_app
from app.seed import run_seed
from app.services.audit_log import AuditLogger
from app.services.run_control import ActionResult, ProgramRef, execute_machine_action
from tests.conftest import token_for

T = TypeVar("T")
REPO = Path(__file__).resolve().parents[2]
DEMO = (REPO / "samples" / "demo" / "O9000").read_text()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for(cond: Callable[[], bool], timeout: float = 10.0, what: str = "condition") -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


class LiveServer:
    def __init__(self, settings: Settings) -> None:
        self.app = create_app(settings)
        with self.app.state.session_factory() as db:
            run_seed(settings.model_copy(update={"seed_dev_data": True}), db)
        self.port = free_port()
        cfg = uvicorn.Config(self.app, host="127.0.0.1", port=self.port, log_level="warning")
        self.server = uvicorn.Server(cfg)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> None:
        self.thread.start()
        wait_for(lambda: self.server.started, what="server start")

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(10)

    def run(self, coro: Coroutine[Any, Any, T], timeout: float = 30) -> T:
        return asyncio.run_coroutine_threadsafe(coro, self.app.state.loop).result(timeout)

    def db_get(self, model: type[T], **where: Any) -> T:
        with self.app.state.session_factory() as db:
            stmt = select(model)
            for k, v in where.items():
                stmt = stmt.where(getattr(model, k) == v)
            obj = db.scalars(stmt).one()
            db.expunge_all()
            return obj  # type: ignore[no-any-return]


class BridgeThread:
    def __init__(self, port: int, settings: Settings) -> None:
        self.sims = {
            "lmw-lathe-1": SimulatedDriver(SimConfig(block_time_s=0.05)),
            "sim-lathe-dev": SimulatedDriver(
                SimConfig(block_time_s=0.05, remote_control_enabled=True, pmc_start_address="SIM")
            ),
        }
        cfg = BridgeConfig(
            server_url=f"ws://127.0.0.1:{port}/api/bridge/ws",
            bridge_token=settings.dev_bridge_token,
            signing_key=settings.dev_bridge_signing_key,
            poll_interval_s=0.2,
            heartbeat_interval_s=0.5,
            machines=[
                MachineConfig(id="lmw-lathe-1"),
                MachineConfig(
                    id="sim-lathe-dev", remote_control_enabled=True, pmc_start_address="SIM"
                ),
            ],
        )
        entries = {m.id: MachineEntry(config=m, driver=self.sims[m.id]) for m in cfg.machines}
        self.service = BridgeService(cfg, entries, backoff_initial_s=0.2, backoff_max_s=0.5)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread = threading.Thread(target=self._main, daemon=True)

    def _main(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.loop.run_until_complete(self.service.run_forever())
        self.loop.close()

    def start(self) -> None:
        self.thread.start()
        wait_for(lambda: self.service.connected.is_set(), what="bridge connect")

    def stop(self) -> None:
        if self.loop is not None and self.thread.is_alive():
            self.loop.call_soon_threadsafe(self.service.stop)
            self.thread.join(10)


@pytest.fixture
def e2e_settings(settings: Settings) -> Settings:
    return settings.model_copy(update={"status_stale_seconds": 1.0, "bridge_send_timeout_s": 10})


@pytest.fixture
def server(e2e_settings: Settings) -> Iterator[LiveServer]:
    s = LiveServer(e2e_settings)
    s.start()
    yield s
    s.stop()


@pytest.fixture
def bridge(server: LiveServer, e2e_settings: Settings) -> Iterator[BridgeThread]:
    b = BridgeThread(server.port, e2e_settings)
    b.start()
    yield b
    b.stop()


def http(server: LiveServer, username: str = "operator") -> httpx.Client:
    user = server.db_get(User, username=username)
    return httpx.Client(
        base_url=f"http://127.0.0.1:{server.port}",
        headers={"Authorization": f"Bearer {token_for(user)}"},
        timeout=10,
    )


def live(server: LiveServer, key: str) -> dict[str, Any]:
    m = server.db_get(Machine, key=key)
    with http(server) as c:
        return dict(c.get(f"/api/machines/{m.id}/live").json())


def act(
    server: LiveServer,
    key: str,
    action: str,
    program: ProgramRef | None = None,
    user: str = "operator",
) -> ActionResult:
    m = server.db_get(Machine, key=key)
    u = server.db_get(User, username=user)
    factory = server.app.state.session_factory
    with factory() as db:  # load roles eagerly
        u = db.get(User, u.id)
        assert u is not None
        _ = u.roles
    return server.run(
        execute_machine_action(
            hub=server.app.state.hub,
            audit=AuditLogger(factory),
            settings=server.app.state.settings,
            user=u,
            machine=m,
            action=action,
            program=program,
        )
    )


def demo_program(pid: int = 1) -> ProgramRef:
    return ProgramRef(
        id=pid, number=9000, sha256=hashlib.sha256(DEMO.encode()).hexdigest(), text=DEMO
    )


def audit_rows(server: LiveServer, action: str) -> list[AuditLog]:
    with server.app.state.session_factory() as db:
        return list(
            db.scalars(select(AuditLog).where(AuditLog.action == action).order_by(AuditLog.id))
        )
