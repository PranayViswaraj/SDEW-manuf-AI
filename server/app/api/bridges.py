"""Bridge administration (admin only). Secrets are shown once, at creation."""

import secrets
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import get_audit, require_roles
from app.db.models import Bridge, Machine, Role, User
from app.db.session import get_db
from app.services.audit_log import AuditLogger, AuditResult
from app.services.bridge_hub import BridgeHub
from app.services.command_signing import hash_token

router = APIRouter(prefix="/bridges", tags=["bridges"])
admin_only = require_roles(Role.ADMIN)


class BridgeOut(BaseModel):
    id: int
    name: str
    created_at: datetime
    connected: bool
    connected_at: datetime | None
    bridge_version: str | None
    reported_machines: list[dict[str, Any]]
    assigned_machines: list[str]


class BridgeCreate(BaseModel):
    name: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")


class BridgeSecrets(BaseModel):
    name: str
    bridge_token: str
    signing_key: str
    note: str = "Copy both into the bridge config.yaml now. They are not shown again."


def _hub(request: Request) -> BridgeHub:
    hub: BridgeHub = request.app.state.hub
    return hub


@router.get("", response_model=list[BridgeOut])
def list_bridges(
    request: Request, db: Session = Depends(get_db), _: User = Depends(admin_only)
) -> list[BridgeOut]:
    hub = _hub(request)
    out = []
    for b in db.scalars(select(Bridge).order_by(Bridge.name)):
        conn = hub.connections.get(b.name)
        assigned = [m.key for m in db.scalars(select(Machine).where(Machine.bridge_id == b.name))]
        out.append(
            BridgeOut(
                id=b.id,
                name=b.name,
                created_at=b.created_at,
                connected=conn is not None,
                connected_at=conn.connected_at if conn else None,
                bridge_version=conn.bridge_version if conn else None,
                reported_machines=conn.machines if conn else [],
                assigned_machines=assigned,
            )
        )
    return out


@router.post("", response_model=BridgeSecrets, status_code=status.HTTP_201_CREATED)
def create_bridge(
    body: BridgeCreate,
    db: Session = Depends(get_db),
    user: User = Depends(admin_only),
    audit: AuditLogger = Depends(get_audit),
) -> BridgeSecrets:
    if db.scalar(select(Bridge).where(Bridge.name == body.name)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Bridge '{body.name}' already exists.")
    token = secrets.token_urlsafe(32)
    key = secrets.token_urlsafe(32)
    db.add(Bridge(name=body.name, token_hash=hash_token(token), signing_key=key))
    db.commit()
    audit.record("bridge_create", AuditResult.OK, user=user, payload={"bridge": body.name})
    return BridgeSecrets(name=body.name, bridge_token=token, signing_key=key)
