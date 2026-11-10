"""FastAPI application factory."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import (
    audit,
    auth,
    bridge_ws,
    bridges,
    capability,
    feature_tables,
    health,
    machines,
    materials,
    programs,
    runs,
    users,
)
from app.auth.login_guard import LoginGuard
from app.config import Settings, get_settings
from app.db.guards import install_audit_guards
from app.db.session import make_engine, make_session_factory
from app.observability import RequestContextMiddleware, install_error_handlers, setup_logging
from app.services.bridge_hub import BridgeHub

log = logging.getLogger("manufai")

DESCRIPTION = """
ManufAI server API: from a confirmed drawing to a machined part, one piece at a time.

**Log in** with `POST /api/auth/login`, then send `Authorization: Bearer <token>`.
Every route checks the caller's role. Machine actions go through the run endpoints, are gated by
the safety rules (see `docs/safety-rules.md`) and are written to the append-only audit log.
"""

TAGS = [
    {"name": "health", "description": "Liveness and readiness checks (no login)."},
    {"name": "auth", "description": "Log in, current user."},
    {"name": "users", "description": "Users, roles and the allowed-to-start list (admin)."},
    {"name": "audit", "description": "Append-only audit log (read only, admin)."},
    {"name": "machines", "description": "Machine register, limits, turret tools, live status."},
    {"name": "materials", "description": "Raw material register and CSV/XLSX import."},
    {"name": "programs", "description": "CNC programs, versions, validation, tool path, approval."},
    {"name": "runs", "description": "Run screen: checklist, send, start, first piece."},
    {"name": "feature tables", "description": "Parts as values an engineer confirms."},
    {"name": "capability", "description": "Which machines can make a confirmed part."},
    {"name": "bridges", "description": "Factory bridge PCs (admin)."},
]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # The event loop that owns the bridge WebSockets (used by tests and background tasks).
    app.state.loop = asyncio.get_running_loop()
    log.info("ManufAI server %s starting (env=%s)", __version__, app.state.settings.env)
    yield
    # Graceful shutdown: tell bridges we are going away so they reconnect cleanly.
    hub: BridgeHub = app.state.hub
    for conn in list(hub.connections.values()):
        with contextlib.suppress(Exception):
            await conn.ws.close(code=1001, reason="server restarting")
    app.state.engine.dispose()
    log.info("ManufAI server stopped")


def create_app(settings: Settings | None = None, configure_logging: bool = False) -> FastAPI:
    settings = settings or get_settings()
    if configure_logging:
        setup_logging(settings.log_level, settings.log_json)
    install_audit_guards()
    docs = settings.docs_enabled
    app = FastAPI(
        title="ManufAI",
        version=__version__,
        description=DESCRIPTION,
        openapi_tags=TAGS,
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )
    app.state.settings = settings
    app.state.engine = make_engine(
        settings.database_url,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_recycle=settings.db_pool_recycle_s,
    )
    app.state.session_factory = make_session_factory(app.state.engine)
    app.state.hub = BridgeHub(stale_after_s=settings.status_stale_seconds)
    app.state.login_guard = LoginGuard(settings.login_max_failures, settings.login_lockout_s)

    install_error_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
    )
    app.add_middleware(RequestContextMiddleware, hsts=settings.hsts)
    for module in (
        health,
        auth,
        users,
        audit,
        machines,
        materials,
        programs,
        runs,
        feature_tables,
        capability,
        bridges,
        bridge_ws,
    ):
        app.include_router(module.router, prefix="/api")
    return app


app = create_app(configure_logging=True)
