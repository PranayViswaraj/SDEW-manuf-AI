"""Read-only audit log API. There are deliberately NO update or delete endpoints (rule 7)."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.deps import require_roles
from app.db.models import AuditLog, Role, User
from app.db.session import get_db

router = APIRouter(prefix="/audit-log", tags=["audit"])


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    timestamp: datetime
    user_id: int | None
    username: str | None
    machine_id: int | None
    program_id: int | None
    program_hash: str | None
    action: str
    payload: dict[str, Any]
    result: str
    error: str | None


class AuditPage(BaseModel):
    total: int
    items: list[AuditOut]


@router.get("", response_model=AuditPage)
def list_audit(
    action: str | None = None,
    machine_id: int | None = None,
    program_id: int | None = None,
    user_id: int | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _: User = Depends(require_roles(Role.ADMIN)),
) -> AuditPage:
    q = select(AuditLog)
    if action:
        q = q.where(AuditLog.action == action)
    if machine_id is not None:
        q = q.where(AuditLog.machine_id == machine_id)
    if program_id is not None:
        q = q.where(AuditLog.program_id == program_id)
    if user_id is not None:
        q = q.where(AuditLog.user_id == user_id)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(AuditLog.id.desc()).limit(limit).offset(offset))
    return AuditPage(total=total, items=[AuditOut.model_validate(r) for r in rows])
