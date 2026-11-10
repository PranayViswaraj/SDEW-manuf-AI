"""WebSocket endpoint the bridges dial OUT to.

Safety rule 5: the server never dials the factory; bridges connect here.
"""

import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.db.models import Bridge, Machine
from app.services.audit_log import AuditLogger, AuditResult
from app.services.bridge_hub import BridgeHub
from app.services.command_signing import hash_token

router = APIRouter(tags=["bridge"])
log = logging.getLogger("manufai.bridge_ws")


def _token_from(ws: WebSocket) -> str:
    auth = ws.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ws.query_params.get("token", "")


def _allowed_machines(factory: sessionmaker[Session], bridge_name: str) -> dict[str, int]:
    with factory() as db:
        rows = db.scalars(select(Machine).where(Machine.bridge_id == bridge_name))
        return {m.key: m.id for m in rows}


@router.websocket("/bridge/ws")
async def bridge_ws(ws: WebSocket) -> None:
    factory: sessionmaker[Session] = ws.app.state.session_factory
    hub: BridgeHub = ws.app.state.hub
    audit = AuditLogger(factory)

    token = _token_from(ws)
    with factory() as db:
        bridge = db.scalar(select(Bridge).where(Bridge.token_hash == hash_token(token)))
        name, key = (bridge.name, bridge.signing_key) if bridge else (None, None)
    if name is None or key is None:
        audit.record("bridge_auth", AuditResult.REJECTED, payload={"reason": "bad token"})
        await ws.close(code=4401, reason="invalid bridge token")
        return

    await ws.accept()
    conn = await hub.register(name, ws, key)
    allowed = _allowed_machines(factory, name)
    audit.record("bridge_connected", AuditResult.OK, payload={"bridge": name})
    try:
        while True:
            msg: Any = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            kind = msg.get("type")
            if kind == "heartbeat":
                hub.heartbeat(conn)
            elif kind == "status":
                if msg.get("machine_id") in allowed:
                    hub.update_status(name, msg)
                    hub.heartbeat(conn)
                else:
                    await ws.send_json(
                        {
                            "type": "error",
                            "message": f"Machine '{msg.get('machine_id')}' is not assigned to "
                            f"bridge '{name}' in ManufAI. Status ignored.",
                        }
                    )
            elif kind == "ack":
                hub.resolve_ack(msg)
            elif kind == "hello":
                conn.machines = list(msg.get("machines") or [])
                conn.bridge_version = msg.get("bridge_version")
                allowed = _allowed_machines(factory, name)
    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - log unexpected errors, keep the server up
        log.exception("bridge %s connection error", name)
    finally:
        hub.unregister(conn)
        audit.record("bridge_disconnected", AuditResult.OK, payload={"bridge": name})
