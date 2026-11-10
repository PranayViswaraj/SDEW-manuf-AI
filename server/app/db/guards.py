"""App-level guard that keeps the audit log append-only (safety rule 7).

Second layer after the database triggers created in migration 0002. Blocks:
- modifying or deleting a loaded AuditLog object and flushing,
- bulk ORM `update(AuditLog)` / `delete(AuditLog)` statements.
"""

from typing import Any

from sqlalchemy import event
from sqlalchemy.orm import ORMExecuteState, Session, UOWTransaction

from app.db.models import AuditLog


class AuditLogImmutableError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("The audit log is append-only. Entries cannot be changed or deleted.")


def _before_flush(session: Session, _ctx: UOWTransaction, _instances: Any) -> None:
    for obj in list(session.dirty) + list(session.deleted):
        if isinstance(obj, AuditLog) and (obj in session.deleted or session.is_modified(obj)):
            raise AuditLogImmutableError()


def _do_orm_execute(state: ORMExecuteState) -> None:
    if not (state.is_update or state.is_delete):
        return
    mapper = state.bind_mapper
    if mapper is not None and mapper.class_ is AuditLog:
        raise AuditLogImmutableError()


def install_audit_guards() -> None:
    """Idempotent: attach guards to every Session."""
    if not event.contains(Session, "before_flush", _before_flush):
        event.listen(Session, "before_flush", _before_flush)
    if not event.contains(Session, "do_orm_execute", _do_orm_execute):
        event.listen(Session, "do_orm_execute", _do_orm_execute)
