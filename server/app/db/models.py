"""ORM models."""

from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.types import UTCDateTime, utcnow


class Role(StrEnum):
    ADMIN = "admin"
    ENGINEER = "engineer"
    PROGRAMMER = "programmer"
    OPERATOR = "operator"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(128), default="")
    password_hash: Mapped[str] = mapped_column(String(256))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # The "allowed to press Start" list (safety rule 4). Set by admin only.
    can_start_machine: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    role_links: Mapped[list["UserRole"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", lazy="selectin"
    )

    @property
    def roles(self) -> set[Role]:
        return {Role(link.role) for link in self.role_links}

    def has_role(self, *roles: Role) -> bool:
        return bool(self.roles & set(roles))

    def set_roles(self, roles: set[Role]) -> None:
        keep = [link for link in self.role_links if Role(link.role) in roles]
        existing = {Role(link.role) for link in keep}
        self.role_links = keep + [UserRole(role=r.value) for r in roles - existing]


class UserRole(Base):
    __tablename__ = "user_roles"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(32), primary_key=True)

    user: Mapped[User] = relationship(back_populates="role_links")


class AuditLog(Base):
    """Append-only (safety rule 7). Guarded in the app (app/db/guards.py) and by DB triggers.

    No foreign keys on purpose: deleting a user or machine must never touch the log.
    """

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True)
    username: Mapped[str | None] = mapped_column(String(64))
    machine_id: Mapped[int | None] = mapped_column(Integer, index=True)
    program_id: Mapped[int | None] = mapped_column(Integer)
    program_hash: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    result: Mapped[str] = mapped_column(String(32))
    error: Mapped[str | None] = mapped_column(Text)
