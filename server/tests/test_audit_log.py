"""Safety rule 7: the audit log is append-only."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text, update
from sqlalchemy.exc import DatabaseError
from sqlalchemy.orm import Session

from app.db.guards import AuditLogImmutableError
from app.db.models import AuditLog
from app.services.audit_log import AuditLogger


@pytest.fixture
def entry_id(app: FastAPI) -> int:
    return AuditLogger(app.state.session_factory).record(
        "test_action", "ok", machine_id=1, program_hash="abc", payload={"k": 1}
    )


def test_entry_written_with_all_fields(db: Session, entry_id: int) -> None:
    row = db.get(AuditLog, entry_id)
    assert row is not None
    assert row.action == "test_action" and row.result == "ok"
    assert row.timestamp.tzinfo is not None  # UTC aware
    assert row.payload == {"k": 1}


def test_orm_update_blocked(db: Session, entry_id: int) -> None:
    row = db.get(AuditLog, entry_id)
    assert row is not None
    row.result = "tampered"
    with pytest.raises(AuditLogImmutableError):
        db.commit()


def test_orm_delete_blocked(db: Session, entry_id: int) -> None:
    db.delete(db.get(AuditLog, entry_id))
    with pytest.raises(AuditLogImmutableError):
        db.commit()


def test_bulk_update_and_delete_blocked(db: Session, entry_id: int) -> None:
    with pytest.raises(AuditLogImmutableError):
        db.execute(update(AuditLog).values(result="x"))
    db.rollback()
    with pytest.raises(AuditLogImmutableError):
        db.execute(delete(AuditLog))


def test_raw_sql_blocked_by_database_trigger(app: FastAPI, entry_id: int) -> None:
    with app.state.engine.connect() as conn:
        with pytest.raises(DatabaseError, match="append-only"):
            conn.execute(text("UPDATE audit_log SET result='x'"))
        conn.rollback()
        with pytest.raises(DatabaseError, match="append-only"):
            conn.execute(text("DELETE FROM audit_log"))
        conn.rollback()
    with app.state.session_factory() as s:
        assert s.scalars(select(AuditLog.result)).all() == ["ok"]


def test_no_update_or_delete_endpoints(
    client: TestClient, role_headers: dict[str, dict[str, str]], entry_id: int
) -> None:
    h = role_headers["admin"]
    for method in ("put", "patch", "delete"):
        r = client.request(method, f"/api/audit-log/{entry_id}", headers=h, json={})
        assert r.status_code in (404, 405)
        r = client.request(method, "/api/audit-log", headers=h, json={})
        assert r.status_code == 405


def test_admin_can_read_and_filter(
    client: TestClient, role_headers: dict[str, dict[str, str]], entry_id: int
) -> None:
    r = client.get("/api/audit-log?action=test_action", headers=role_headers["admin"])
    assert r.status_code == 200
    assert r.json()["total"] == 1
    assert r.json()["items"][0]["id"] == entry_id
