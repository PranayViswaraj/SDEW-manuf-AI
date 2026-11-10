"""Audit log writer (safety rule 7).

Each entry is written in its OWN session and committed immediately, so an entry written
"before acting" survives even if the action (or the caller's transaction) fails afterwards.
"""

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from app.db.models import AuditLog, User


class AuditResult:
    REQUESTED = "requested"
    OK = "ok"
    FAILED = "failed"
    REJECTED = "rejected"


@dataclass(frozen=True)
class AuditLogger:
    session_factory: sessionmaker[Session]

    def record(
        self,
        action: str,
        result: str,
        *,
        user: User | None = None,
        machine_id: int | None = None,
        program_id: int | None = None,
        program_hash: str | None = None,
        payload: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> int:
        entry = AuditLog(
            action=action,
            result=result,
            user_id=user.id if user else None,
            username=user.username if user else None,
            machine_id=machine_id,
            program_id=program_id,
            program_hash=program_hash,
            payload=payload or {},
            error=error,
        )
        with self.session_factory() as s:
            s.add(entry)
            s.commit()
            return entry.id
