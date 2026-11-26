"""Runs the real ManufAI server (server/app) inside the browser with Pyodide.

Used by the GitHub Pages build: there is no server to pay for, so every visitor's browser runs
its own copy. The database is SQLite in the browser's storage (IndexedDB), so each browser keeps
its own data. Requests from the web app are handed to the FastAPI app here, not sent over the
network.
"""

import os
import sys

import anyio.to_thread

# Pyodide has no threads: run "thread pool" work (sync endpoints, file reads) directly.


async def _run_sync(func, *args, **_kwargs):  # type: ignore[no-untyped-def]
    return func(*args)


anyio.to_thread.run_sync = _run_sync  # type: ignore[assignment]

SRV = "/srv"
os.environ.update(
    {
        "MANUFAI_ENV": "dev",
        "MANUFAI_DATABASE_URL": "sqlite:////data/manufai.db",
        "MANUFAI_SEED_DEV_DATA": "true",
        "MANUFAI_SAMPLES_DIR": f"{SRV}/samples/programs",
        "MANUFAI_SAMPLE_MATERIALS_CSV": f"{SRV}/samples/materials/raw-material-register.sample.csv",
        "MANUFAI_DOCS_ENABLED": "false",
        "MANUFAI_CORS_ORIGINS": "http://localhost",
        # Tokens live as long as the browser tab is likely to be open.
        "MANUFAI_JWT_EXPIRE_MINUTES": "720",
    }
)
os.chdir(SRV)
sys.path.insert(0, SRV)


def _migrate_and_seed() -> list[str]:
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config(f"{SRV}/alembic.ini"), "head")

    from app.config import get_settings
    from app.db.guards import install_audit_guards
    from app.db.session import make_engine, make_session_factory
    from app.seed import run_seed

    install_audit_guards()
    settings = get_settings()
    engine = make_engine(settings.database_url)
    try:
        with make_session_factory(engine)() as db:
            return run_seed(settings, db) + _seed_sample_user(db)
    finally:
        engine.dispose()


def _seed_sample_user(db) -> list[str]:  # type: ignore[no-untyped-def]
    """The login page's "Sample" button: one demo account with all four roles."""
    from sqlalchemy import select

    from app.auth.security import hash_password
    from app.db.models import Role, User
    from app.seed import DEV_PASSWORD

    if db.scalar(select(User).where(User.username == "sample")) is not None:
        return []
    user = User(
        username="sample",
        full_name="Sample (all roles)",
        password_hash=hash_password(DEV_PASSWORD),
        can_start_machine=True,
    )
    user.set_roles({Role.ADMIN, Role.ENGINEER, Role.PROGRAMMER, Role.OPERATOR})
    db.add(user)
    db.commit()
    return ["created demo user sample"]


SEED_LOG = _migrate_and_seed()

import asyncio  # noqa: E402

from app.main import create_app  # noqa: E402

APP = create_app()
APP.state.loop = asyncio.get_event_loop()


# ---- AI drawing reader in the browser: on only when the user entered an API key in THIS browser.
# The key stays in JavaScript (worker.ts); the agents' calls are made with the browser's fetch.
import app.api.drawings as _drawings  # noqa: E402
from app.ai.browser_reader import BrowserClaudeReader, key_set  # noqa: E402
from app.config import get_settings  # noqa: E402


def _browser_reader() -> BrowserClaudeReader:
    s = get_settings()
    return BrowserClaudeReader(model=s.ai_model, effort=s.ai_effort)


_drawings.ai_reader_enabled = key_set
_drawings.get_drawing_reader = _browser_reader


async def _run_then_save(job) -> None:  # type: ignore[no-untyped-def]
    """An AI read runs beside the requests; when it has written the table, save the database."""
    import js  # type: ignore[import-not-found]

    try:
        await job
    finally:
        await js.manufaiPersist()


APP.state.ai_scheduler = lambda job: asyncio.ensure_future(_run_then_save(job))


async def handle(method: str, path: str, query: str, headers: list, body: bytes) -> tuple:
    """One HTTP request through the ASGI app. Returns (status, [[name, value]...], body)."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method.upper(),
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": query.encode(),
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers],
        "client": ("127.0.0.1", 0),
        "server": ("browser", 443),
    }
    sent = False

    async def receive() -> dict:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}
        await asyncio.sleep(3600)  # never disconnects
        return {"type": "http.disconnect"}

    status = 500
    out_headers: list = []
    chunks: list[bytes] = []

    async def send(message: dict) -> None:
        nonlocal status, out_headers
        if message["type"] == "http.response.start":
            status = message["status"]
            out_headers = [[k.decode("latin-1"), v.decode("latin-1")] for k, v in message["headers"]]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    await APP(scope, receive, send)
    return status, out_headers, b"".join(chunks)
