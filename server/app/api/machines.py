"""Machine register and per-machine turret tool list (Milestone 3)."""

import ipaddress
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.deps import any_user, get_audit, require_roles
from app.db.models import LIMIT_KEYS, Machine, MachineState, Role, Tool, ToolType, User
from app.db.session import get_db
from app.services.audit_log import AuditLogger, AuditResult

router = APIRouter(prefix="/machines", tags=["machines"])
admin_only = require_roles(Role.ADMIN)
tool_editors = require_roles(Role.ADMIN, Role.PROGRAMMER)


# ---------- schemas ----------


class MachineLimits(BaseModel):
    """All limits are unknown (null) until read from the machine nameplate.

    TODO(REAL-DATA): from nameplate / machine manual.
    """

    model_config = ConfigDict(extra="forbid")

    max_turning_diameter: float | None = Field(default=None, gt=0, description="mm")
    max_turning_length: float | None = Field(default=None, gt=0, description="mm")
    max_bar_diameter: float | None = Field(default=None, gt=0, description="mm")
    spindle_rpm_min: int | None = Field(default=None, ge=0)
    spindle_rpm_max: int | None = Field(default=None, gt=0)
    chuck_size: str | None = Field(default=None, max_length=64, description='e.g. 8" / 210 mm')
    turret_stations: int | None = Field(default=None, ge=1, le=64)

    @model_validator(mode="after")
    def _rpm_order(self) -> "MachineLimits":
        lo, hi = self.spindle_rpm_min, self.spindle_rpm_max
        if lo is not None and hi is not None and lo > hi:
            raise ValueError("Minimum spindle speed cannot be higher than the maximum.")
        return self


def _check_ip(v: str | None) -> str | None:
    if v is None or v.strip() == "":
        return None
    try:
        return str(ipaddress.ip_address(v.strip()))
    except ValueError as e:
        raise ValueError(f"'{v}' is not a valid IP address (example: 192.168.1.50).") from e


class MachineBase(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    make: str = Field(default="", max_length=64)
    model: str = Field(default="", max_length=64)
    controller: str = Field(default="FANUC 0i-TF", max_length=64)
    ip_address: str | None = None
    focas_port: int = Field(default=8193, ge=1, le=65535)
    status: MachineState = MachineState.IN_SERVICE
    bridge_id: str | None = Field(default=None, max_length=64)
    remote_control_enabled: bool = False
    limits: MachineLimits = Field(default_factory=MachineLimits)
    notes: str = Field(default="", max_length=4000)

    _ip = field_validator("ip_address")(_check_ip)


class MachineCreate(MachineBase):
    key: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")


class MachineUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    make: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=64)
    controller: str | None = Field(default=None, max_length=64)
    ip_address: str | None = None
    focas_port: int | None = Field(default=None, ge=1, le=65535)
    status: MachineState | None = None
    bridge_id: str | None = Field(default=None, max_length=64)
    remote_control_enabled: bool | None = None
    limits: MachineLimits | None = None
    notes: str | None = Field(default=None, max_length=4000)

    _ip = field_validator("ip_address")(_check_ip)


class ToolIn(BaseModel):
    station: int = Field(ge=1, le=64)
    tool_code: str = Field(pattern=r"^T\d{4}$", description="FANUC tool + offset, e.g. T0101")
    description: str = Field(default="", max_length=128)
    insert_type: str = Field(default="", max_length=64)
    nose_radius: float | None = Field(default=None, ge=0, le=10)
    tool_type: ToolType


class ToolOut(ToolIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    machine_id: int


class MachineOut(MachineBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    key: str
    created_at: datetime
    updated_at: datetime
    tools: list[ToolOut]
    limits_missing: list[str]

    @classmethod
    def from_machine(cls, m: Machine) -> "MachineOut":
        limits = {k: (m.limits or {}).get(k) for k in LIMIT_KEYS}
        return cls(
            id=m.id,
            key=m.key,
            name=m.name,
            make=m.make,
            model=m.model,
            controller=m.controller,
            ip_address=m.ip_address,
            focas_port=m.focas_port,
            status=MachineState(m.status),
            bridge_id=m.bridge_id,
            remote_control_enabled=m.remote_control_enabled,
            limits=MachineLimits(**limits),
            notes=m.notes,
            created_at=m.created_at,
            updated_at=m.updated_at,
            tools=[ToolOut.model_validate(t) for t in m.tools],
            limits_missing=[k for k, v in limits.items() if v is None],
        )


# ---------- helpers ----------


def _get_machine(db: Session, machine_id: int) -> Machine:
    m = db.get(Machine, machine_id)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Machine not found.")
    return m


def _check_station(machine: Machine, station: int) -> None:
    stations = (machine.limits or {}).get("turret_stations")
    if stations is not None and station > stations:
        raise HTTPException(
            422,
            f"Station {station} does not exist: this turret has {stations} stations.",
        )


# ---------- machines ----------


@router.get("", response_model=list[MachineOut])
def list_machines(db: Session = Depends(get_db), _: User = Depends(any_user)) -> list[MachineOut]:
    return [MachineOut.from_machine(m) for m in db.scalars(select(Machine).order_by(Machine.name))]


@router.get("/{machine_id}", response_model=MachineOut)
def get_machine(
    machine_id: int, db: Session = Depends(get_db), _: User = Depends(any_user)
) -> MachineOut:
    return MachineOut.from_machine(_get_machine(db, machine_id))


class LiveOut(BaseModel):
    machine_id: int
    state: str  # online | machine_unreachable | stale | offline
    bridge_id: str | None
    bridge_connected: bool
    machine_connected: bool
    driver: str | None
    age_s: float | None
    received_at: str | None
    status: dict[str, Any] | None
    loaded_program: int | None
    error: str | None
    remote_control_enabled: bool
    stale_after_s: float


@router.get("/{machine_id}/live", response_model=LiveOut)
def machine_live(
    machine_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _: User = Depends(any_user),
) -> LiveOut:
    m = _get_machine(db, machine_id)
    view = request.app.state.hub.live_view(m.key, m.bridge_id)
    return LiveOut(
        machine_id=m.id,
        bridge_id=m.bridge_id,
        remote_control_enabled=m.remote_control_enabled,
        stale_after_s=request.app.state.settings.status_stale_seconds,
        **view,
    )


@router.post("", response_model=MachineOut, status_code=status.HTTP_201_CREATED)
def create_machine(
    body: MachineCreate,
    db: Session = Depends(get_db),
    user: User = Depends(admin_only),
    audit: AuditLogger = Depends(get_audit),
) -> MachineOut:
    if db.scalar(select(Machine).where(Machine.key == body.key)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"A machine with key '{body.key}' exists.")
    data = body.model_dump()
    data["limits"] = body.limits.model_dump()
    data["status"] = body.status.value
    m = Machine(**data)
    db.add(m)
    db.commit()
    audit.record(
        "machine_create", AuditResult.OK, user=user, machine_id=m.id, payload=body.model_dump()
    )
    return MachineOut.from_machine(m)


@router.patch("/{machine_id}", response_model=MachineOut)
def update_machine(
    machine_id: int,
    body: MachineUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(admin_only),
    audit: AuditLogger = Depends(get_audit),
) -> MachineOut:
    m = _get_machine(db, machine_id)
    changes: dict[str, Any] = body.model_dump(exclude_unset=True, mode="json")
    for field, value in changes.items():
        setattr(m, field, value)
    if body.limits is not None:
        stations = body.limits.turret_stations
        too_high = [t.tool_code for t in m.tools if stations is not None and t.station > stations]
        if too_high:
            db.rollback()
            raise HTTPException(
                422,
                f"Tools {', '.join(too_high)} sit on stations above {stations}. Move them first.",
            )
    db.commit()
    audit.record("machine_update", AuditResult.OK, user=user, machine_id=m.id, payload=changes)
    if "remote_control_enabled" in changes:
        # Logged separately so it stands out in the audit log.
        audit.record(
            "remote_control_changed",
            AuditResult.OK,
            user=user,
            machine_id=m.id,
            payload={"remote_control_enabled": changes["remote_control_enabled"]},
        )
    return MachineOut.from_machine(m)


@router.delete("/{machine_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_machine(
    machine_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(admin_only),
    audit: AuditLogger = Depends(get_audit),
) -> None:
    m = _get_machine(db, machine_id)
    name = m.name
    db.delete(m)
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This machine has programs or runs recorded against it. Set it to 'retired' instead.",
        ) from e
    audit.record(
        "machine_delete", AuditResult.OK, user=user, machine_id=machine_id, payload={"name": name}
    )


# ---------- tools ----------


@router.get("/{machine_id}/tools", response_model=list[ToolOut])
def list_tools(
    machine_id: int, db: Session = Depends(get_db), _: User = Depends(any_user)
) -> list[ToolOut]:
    return [ToolOut.model_validate(t) for t in _get_machine(db, machine_id).tools]


def _save_tool(db: Session, tool: Tool) -> None:
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Tool {tool.tool_code} is already on this machine."
        ) from e


@router.post("/{machine_id}/tools", response_model=ToolOut, status_code=status.HTTP_201_CREATED)
def add_tool(
    machine_id: int,
    body: ToolIn,
    db: Session = Depends(get_db),
    user: User = Depends(tool_editors),
    audit: AuditLogger = Depends(get_audit),
) -> ToolOut:
    m = _get_machine(db, machine_id)
    _check_station(m, body.station)
    tool = Tool(machine_id=m.id, **body.model_dump(mode="json"))
    db.add(tool)
    _save_tool(db, tool)
    audit.record(
        "tool_add", AuditResult.OK, user=user, machine_id=m.id, payload=body.model_dump(mode="json")
    )
    return ToolOut.model_validate(tool)


def _get_tool(db: Session, machine_id: int, tool_id: int) -> Tool:
    tool = db.get(Tool, tool_id)
    if tool is None or tool.machine_id != machine_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tool not found on this machine.")
    return tool


@router.put("/{machine_id}/tools/{tool_id}", response_model=ToolOut)
def update_tool(
    machine_id: int,
    tool_id: int,
    body: ToolIn,
    db: Session = Depends(get_db),
    user: User = Depends(tool_editors),
    audit: AuditLogger = Depends(get_audit),
) -> ToolOut:
    tool = _get_tool(db, machine_id, tool_id)
    _check_station(tool.machine, body.station)
    for k, v in body.model_dump(mode="json").items():
        setattr(tool, k, v)
    _save_tool(db, tool)
    audit.record(
        "tool_update",
        AuditResult.OK,
        user=user,
        machine_id=machine_id,
        payload={"tool_id": tool_id, **body.model_dump(mode="json")},
    )
    return ToolOut.model_validate(tool)


@router.delete("/{machine_id}/tools/{tool_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tool(
    machine_id: int,
    tool_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(tool_editors),
    audit: AuditLogger = Depends(get_audit),
) -> None:
    tool = _get_tool(db, machine_id, tool_id)
    code = tool.tool_code
    db.delete(tool)
    db.commit()
    audit.record(
        "tool_delete",
        AuditResult.OK,
        user=user,
        machine_id=machine_id,
        payload={"tool_id": tool_id, "tool_code": code},
    )
