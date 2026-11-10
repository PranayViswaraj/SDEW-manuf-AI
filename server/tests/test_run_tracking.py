"""Run tracking from live status, including the race right after a remote start."""

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

from app.db.models import Machine, Program, Run, RunStatus
from app.services.audit_log import AuditLogger
from app.services.bridge_hub import BridgeHub, LiveEntry
from app.services.run_service import refresh_from_live


class _NullAudit(AuditLogger):
    def __init__(self) -> None:
        self.rows: list[str] = []

    def record(self, action: str, result: str, **kw: Any) -> int:  # type: ignore[override]
        self.rows.append(action)
        return 0


def _hub_with(status: dict[str, Any], received_at: datetime) -> BridgeHub:
    hub = BridgeHub(stale_after_s=5)
    hub.connections["b1"] = object()  # type: ignore[assignment]  # "connected"
    hub.live["m1"] = LiveEntry(
        bridge="b1",
        status=status,
        machine_connected=True,
        error=None,
        driver="simulated",
        loaded_program=9000,
        received_mono=hub.clock(),
        received_at=received_at,
    )
    return hub


def _run(status: str, started: datetime | None, sent: datetime) -> Run:
    m = Machine(id=1, key="m1", name="M", bridge_id="b1")
    p = Program(id=1, program_number=9000, sha256="h")
    return Run(
        id=1,
        machine_id=1,
        program_id=1,
        program_hash="h",
        machine=m,
        program=p,
        status=status,
        started_at=started,
        sent_at=sent,
        part_count_at_send=0,
        status_note="",
    )


IDLE = {"program_number": 9000, "run_state": "idle", "part_count": 0}


def test_status_from_before_the_start_does_not_complete_the_run() -> None:
    now = datetime.now(UTC)
    run = _run(RunStatus.RUNNING.value, started=now, sent=now - timedelta(seconds=5))
    hub = _hub_with(IDLE, received_at=now - timedelta(seconds=0.5))  # read before the start
    assert refresh_from_live(hub, run, _NullAudit()) is False
    assert run.status == RunStatus.RUNNING.value


def test_idle_after_start_without_part_count_is_flagged() -> None:
    now = datetime.now(UTC)
    run = _run(
        RunStatus.RUNNING.value,
        started=now - timedelta(seconds=3),
        sent=now - timedelta(seconds=10),
    )
    hub = _hub_with(IDLE, received_at=now)
    audit = _NullAudit()
    refresh_from_live(hub, run, audit)
    assert run.status == RunStatus.COMPLETED.value
    assert "without finishing" in run.status_note
    assert audit.rows == ["run_completed"]


def test_part_count_increase_completes_even_if_running_never_seen() -> None:
    now = datetime.now(UTC)
    run = _run(RunStatus.SENT.value, started=None, sent=now - timedelta(seconds=3))
    hub = _hub_with({**IDLE, "part_count": 1}, received_at=now)
    audit = _NullAudit()
    refresh_from_live(hub, run, audit)
    assert run.status == RunStatus.COMPLETED.value and run.start_mode == "at_machine"
    assert run.status_note == ""
    assert audit.rows == ["run_started", "run_completed"]


def test_fresh_status_after_filter() -> None:
    async def go() -> None:
        now = datetime.now(UTC)
        hub = _hub_with(IDLE, received_at=now)
        assert hub.fresh_status("m1", "b1") == IDLE
        assert hub.fresh_status("m1", "b1", after=now - timedelta(seconds=1)) == IDLE
        assert hub.fresh_status("m1", "b1", after=now) is None

    asyncio.run(go())
