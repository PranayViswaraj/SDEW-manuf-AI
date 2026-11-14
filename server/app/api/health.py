"""Liveness (/api/health) and readiness (/api/ready) checks. No login needed.

- health: the process answers and can reach the database (for load balancers / Docker).
- ready:  the database is reachable AND its schema is at the latest migration (for deployments:
          do not send traffic to a server whose database has not been migrated).
"""

from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import __version__
from app.db.session import get_db

router = APIRouter(tags=["health"])
SERVER_DIR = Path(__file__).resolve().parents[2]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    database: Literal["ok", "error"]
    time: datetime
    # production hides the shared test accounts on the login page
    mode: Literal["dev", "test", "production"] = "dev"


class ReadyResponse(BaseModel):
    ready: bool
    version: str
    database: Literal["ok", "error"]
    schema_revision: str | None
    expected_revision: str | None
    bridges_connected: int
    problems: list[str]


def head_revision() -> str | None:
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "app" / "db" / "migrations"))
    return ScriptDirectory.from_config(cfg).get_current_head()


@router.get("/health", response_model=HealthResponse, summary="Liveness check")
def health(request: Request, db: Session = Depends(get_db)) -> HealthResponse:
    db_state: Literal["ok", "error"]
    try:
        db.execute(text("SELECT 1"))
        db_state = "ok"
    except SQLAlchemyError:
        db_state = "error"
    return HealthResponse(
        status="ok" if db_state == "ok" else "degraded",
        version=__version__,
        database=db_state,
        time=datetime.now(UTC),
        mode=request.app.state.settings.env,
    )


@router.get(
    "/ready",
    response_model=ReadyResponse,
    summary="Readiness check",
    responses={503: {"model": ReadyResponse, "description": "Not ready"}},
)
def ready(request: Request, db: Session = Depends(get_db)) -> JSONResponse:
    problems: list[str] = []
    current: str | None = None
    db_state: Literal["ok", "error"] = "ok"
    try:
        with db.connection() as conn:
            current = MigrationContext.configure(conn).get_current_revision()
    except SQLAlchemyError:
        db_state = "error"
        problems.append("Database is not reachable.")
    expected = head_revision()
    if db_state == "ok" and current != expected:
        problems.append(
            f"Database schema is at {current or 'nothing'}, expected {expected}. "
            "Run: alembic upgrade head"
        )
    body = ReadyResponse(
        ready=not problems,
        version=__version__,
        database=db_state,
        schema_revision=current,
        expected_revision=expected,
        bridges_connected=len(request.app.state.hub.connections),
        problems=problems,
    )
    return JSONResponse(body.model_dump(mode="json"), status_code=200 if body.ready else 503)
