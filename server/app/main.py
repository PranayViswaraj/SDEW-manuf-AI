"""FastAPI application factory."""

import asyncio
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
    health,
    machines,
    materials,
    programs,
    runs,
    users,
)
from app.config import Settings, get_settings
from app.db.guards import install_audit_guards
from app.db.session import make_engine, make_session_factory
from app.services.bridge_hub import BridgeHub


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # The event loop that owns the bridge WebSockets (used by tests and background tasks).
    app.state.loop = asyncio.get_running_loop()
    yield


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    install_audit_guards()
    app = FastAPI(title="ManufAI", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.engine = make_engine(settings.database_url)
    app.state.session_factory = make_session_factory(app.state.engine)
    app.state.hub = BridgeHub(stale_after_s=settings.status_stale_seconds)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for module in (
        health,
        auth,
        users,
        audit,
        machines,
        materials,
        programs,
        runs,
        bridges,
        bridge_ws,
    ):
        app.include_router(module.router, prefix="/api")
    return app


app = create_app()
