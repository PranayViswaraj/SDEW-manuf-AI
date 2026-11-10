"""ORM models."""

from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, String, Text, UniqueConstraint
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


class MachineState(StrEnum):
    """Administrative state set by an admin (live run state comes from the bridge)."""

    IN_SERVICE = "in_service"
    MAINTENANCE = "maintenance"
    RETIRED = "retired"


class ToolType(StrEnum):
    OD_ROUGH = "od_rough"
    OD_FINISH = "od_finish"
    BORE = "bore"
    DRILL = "drill"
    GROOVE = "groove"
    THREAD = "thread"
    STOPPER = "stopper"
    PARTING = "parting"
    OTHER = "other"


# Keys of Machine.limits. All values nullable: TODO(REAL-DATA): from nameplate.
LIMIT_KEYS = (
    "max_turning_diameter",
    "max_turning_length",
    "max_bar_diameter",
    "spindle_rpm_min",
    "spindle_rpm_max",
    "chuck_size",
    "turret_stations",
)


def empty_limits() -> dict[str, Any]:
    return dict.fromkeys(LIMIT_KEYS)


class Machine(Base):
    __tablename__ = "machines"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Stable identifier the bridge config uses for this machine (e.g. "lmw-lathe-1").
    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    make: Mapped[str] = mapped_column(String(64), default="")
    model: Mapped[str] = mapped_column(String(64), default="")
    controller: Mapped[str] = mapped_column(String(64), default="FANUC 0i-TF")
    ip_address: Mapped[str | None] = mapped_column(String(64))
    focas_port: Mapped[int] = mapped_column(Integer, default=8193)
    status: Mapped[str] = mapped_column(String(32), default=MachineState.IN_SERVICE.value)
    bridge_id: Mapped[str | None] = mapped_column(String(64))
    # Safety rule 9: remote start / feed hold / stop OFF unless explicitly enabled.
    remote_control_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    limits: Mapped[dict[str, Any]] = mapped_column(JSON, default=empty_limits)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    tools: Mapped[list["Tool"]] = relationship(
        back_populates="machine",
        cascade="all, delete-orphan",
        order_by="Tool.station",
        lazy="selectin",
    )


class Tool(Base):
    __tablename__ = "tools"
    __table_args__ = (UniqueConstraint("machine_id", "tool_code", name="uq_tool_machine_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    machine_id: Mapped[int] = mapped_column(ForeignKey("machines.id", ondelete="CASCADE"))
    station: Mapped[int] = mapped_column(Integer)
    tool_code: Mapped[str] = mapped_column(String(8))  # e.g. "T0101" (tool 01, offset 01)
    description: Mapped[str] = mapped_column(String(128), default="")
    insert_type: Mapped[str] = mapped_column(String(64), default="")
    nose_radius: Mapped[float | None] = mapped_column(Float)
    tool_type: Mapped[str] = mapped_column(String(32))

    machine: Mapped[Machine] = relationship(back_populates="tools")


def grade_key(grade: str) -> str:
    """Normalised grade used to detect duplicates: 'en 8 ' == 'EN8'."""
    return "".join(grade.split()).upper()


class Material(Base):
    __tablename__ = "materials"
    __table_args__ = (UniqueConstraint("grade_key", "bar_diameter", name="uq_material_grade_dia"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    grade: Mapped[str] = mapped_column(String(64))
    grade_key: Mapped[str] = mapped_column(String(64), index=True)
    bar_diameter: Mapped[float] = mapped_column(Float, index=True)  # mm
    available_length: Mapped[float | None] = mapped_column(Float)  # mm per bar
    stock_quantity: Mapped[float | None] = mapped_column(Float)
    quantity_unit: Mapped[str] = mapped_column(String(16), default="bars")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)
