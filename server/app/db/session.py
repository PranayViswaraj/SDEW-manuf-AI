"""Engine and session factory. Built from settings; no module-level global engine."""

from collections.abc import Iterator
from typing import Any

from fastapi import Request
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker


def make_engine(
    database_url: str,
    pool_size: int = 10,
    max_overflow: int = 10,
    pool_recycle: int = 1800,
) -> Engine:
    is_sqlite = database_url.startswith("sqlite")
    connect_args: dict[str, Any] = {"check_same_thread": False} if is_sqlite else {}
    pool: dict[str, Any] = (
        {}
        if is_sqlite
        else {"pool_size": pool_size, "max_overflow": max_overflow, "pool_recycle": pool_recycle}
    )
    engine = create_engine(database_url, connect_args=connect_args, pool_pre_ping=True, **pool)
    if is_sqlite:

        @event.listens_for(engine, "connect")
        def _sqlite_fk_on(dbapi_conn: Any, _record: Any) -> None:
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

    return engine


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db(request: Request) -> Iterator[Session]:
    """FastAPI dependency: one session per request, from the app's session factory."""
    factory: sessionmaker[Session] = request.app.state.session_factory
    with factory() as session:
        yield session
