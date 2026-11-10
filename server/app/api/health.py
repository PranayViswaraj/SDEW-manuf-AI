"""GET /api/health - liveness plus a database round-trip."""

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import __version__
from app.db.session import get_db

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    database: Literal["ok", "error"]
    time: datetime


@router.get("/health", response_model=HealthResponse)
def health(db: Session = Depends(get_db)) -> HealthResponse:
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
    )
