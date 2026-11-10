"""FastAPI application factory."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import audit, auth, health, machines, materials, users
from app.config import Settings, get_settings
from app.db.guards import install_audit_guards
from app.db.session import make_engine, make_session_factory


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    install_audit_guards()
    app = FastAPI(title="ManufAI", version=__version__)
    app.state.settings = settings
    app.state.engine = make_engine(settings.database_url)
    app.state.session_factory = make_session_factory(app.state.engine)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for module in (health, auth, users, audit, machines, materials):
        app.include_router(module.router, prefix="/api")
    return app


app = create_app()
