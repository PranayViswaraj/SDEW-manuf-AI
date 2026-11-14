"""Production readiness: settings, login lock-out, request IDs, headers, errors, ready, CLI."""

from pathlib import Path

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.login_guard import LoginGuard
from app.cli import run as cli
from app.config import Settings, production_problems
from app.db.models import AuditLog, Bridge, Role, User
from app.main import create_app
from tests.conftest import UserFactory, sqlite_url

PROD_OK = {
    "env": "production",
    "jwt_secret": "x" * 40,
    "database_url": "postgresql+psycopg://u:p@db/manufai",
    "cors_origins": "https://manufai.example.com",
}


# ---------------------------------------------------------------- settings


def test_safe_production_settings_accepted() -> None:
    s = Settings(**PROD_OK)
    assert s.is_production and production_problems(s) == []


@pytest.mark.parametrize(
    ("override", "fragment"),
    [
        ({"jwt_secret": "dev-only-insecure-secret-change-me-in-prod"}, "MANUFAI_JWT_SECRET"),
        ({"seed_dev_data": True}, "MANUFAI_SEED_DEV_DATA=false"),
        ({"cors_origins": "*"}, "not '*'"),
        ({"database_url": "sqlite:///./x.db"}, "PostgreSQL"),
    ],
)
def test_unsafe_production_settings_refused(override: dict[str, object], fragment: str) -> None:
    with pytest.raises(ValidationError, match=fragment.replace("*", r"\*")):
        Settings(**{**PROD_OK, **override})


def test_dev_settings_allowed() -> None:
    assert Settings(env="dev", seed_dev_data=True).env == "dev"


# ---------------------------------------------------------------- login lock-out


def test_login_guard_locks_and_expires() -> None:
    now = [0.0]
    g = LoginGuard(max_failures=3, lockout_s=60, clock=lambda: now[0])
    for _ in range(3):
        assert g.seconds_locked("Bob", "1.2.3.4") == 0
        g.failed("bob", "1.2.3.4")
    assert g.seconds_locked("BOB", "1.2.3.4") > 0  # usernames compared case-insensitively
    assert g.seconds_locked("bob", "5.6.7.8") == 0  # other address unaffected
    now[0] = 61
    assert g.seconds_locked("bob", "1.2.3.4") == 0
    g.failed("bob", "1.2.3.4")
    g.succeeded("bob", "1.2.3.4")
    assert g.seconds_locked("bob", "1.2.3.4") == 0


def test_login_endpoint_locks_out_after_failures(
    settings: Settings, make_user: UserFactory, db: Session
) -> None:
    app = create_app(settings.model_copy(update={"login_max_failures": 3}))
    make_user(Role.OPERATOR, username="carl", password="right-password")
    with TestClient(app) as c:
        for _ in range(3):
            assert (
                c.post("/api/auth/login", json={"username": "carl", "password": "nope"}).status_code
                == 401
            )
        r = c.post("/api/auth/login", json={"username": "carl", "password": "right-password"})
        assert r.status_code == 429  # even the right password is refused while locked
        assert "Too many wrong passwords" in r.json()["detail"] and r.headers["Retry-After"]
    reasons = [
        a.payload.get("reason")
        for a in db.scalars(select(AuditLog).where(AuditLog.action == "login"))
    ]
    assert "locked out" in reasons


# ---------------------------------------------------------------- request plumbing


def test_request_id_and_security_headers(client: TestClient) -> None:
    r = client.get("/api/health")
    assert len(r.headers["x-request-id"]) == 32
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "strict-transport-security" not in r.headers  # only when HSTS is enabled
    r = client.get("/api/health", headers={"X-Request-ID": "abc-123"})
    assert r.headers["x-request-id"] == "abc-123"  # kept for tracing across services


def test_hsts_when_enabled(settings: Settings) -> None:
    with TestClient(create_app(settings.model_copy(update={"hsts": True}))) as c:
        assert "max-age" in c.get("/api/health").headers["strict-transport-security"]


def test_unhandled_error_is_clean_json_with_reference(settings: Settings) -> None:
    app = create_app(settings)
    boom = APIRouter()

    @boom.get("/api/boom")
    def _boom() -> None:
        raise RuntimeError("secret internal detail")

    app.include_router(boom)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/boom", headers={"X-Request-ID": "ref-42"})
    assert r.status_code == 500
    assert "secret internal detail" not in r.text  # nothing internal leaks out
    assert r.json()["request_id"] == "ref-42" and "ref-42" in r.json()["detail"]


def test_docs_can_be_turned_off(settings: Settings) -> None:
    with TestClient(create_app(settings.model_copy(update={"docs_enabled": False}))) as c:
        assert c.get("/docs").status_code == 404
        assert c.get("/openapi.json").status_code == 404
    with TestClient(create_app(settings)) as c:
        assert c.get("/openapi.json").json()["info"]["title"] == "ManufAI"


# ---------------------------------------------------------------- readiness


def test_ready_when_migrated(client: TestClient) -> None:
    r = client.get("/api/ready")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is True and body["schema_revision"] == body["expected_revision"]


def test_not_ready_without_migrations(tmp_path: Path) -> None:
    app = create_app(Settings(database_url=sqlite_url(tmp_path / "empty.db")))
    with TestClient(app) as c:
        r = c.get("/api/ready")
    assert r.status_code == 503
    assert "alembic upgrade head" in r.json()["problems"][0]


# ---------------------------------------------------------------- CLI


def test_cli_create_user_and_check(settings: Settings, db: Session) -> None:
    out: list[str] = []
    pw = iter(["a-long-password", "a-long-password"])
    code = cli(
        ["create-user", "chief", "--role", "admin", "--full-name", "Chief Admin"],
        settings=settings,
        out=out.append,
        ask=lambda _p: next(pw),
    )
    assert code == 0 and "Created user 'chief'" in out[-1]
    user = db.scalars(select(User).where(User.username == "chief")).one()
    assert Role.ADMIN in user.roles and user.password_hash.startswith("$argon2")
    out.clear()
    assert cli(["check"], settings=settings, out=out.append) == 0
    assert any("active admins: 1" in line for line in out) and out[-1] == "RESULT: OK"
    rows = db.scalars(select(AuditLog).where(AuditLog.action == "user_create")).all()
    assert rows and rows[-1].payload["via"] == "cli"


def test_cli_check_reports_missing_admin(settings: Settings) -> None:
    out: list[str] = []
    assert cli(["check"], settings=settings, out=out.append) == 1
    assert any("no active admin" in line for line in out)


def test_cli_check_reports_missing_drawing_data(settings: Settings, tmp_path: Path) -> None:
    """Production once mounted only samples/programs: uploads then silently did not autofill."""
    (tmp_path / "programs").mkdir()
    out: list[str] = []
    bare = settings.model_copy(update={"samples_dir": str(tmp_path / "programs")})
    assert cli(["check"], settings=bare, out=out.append) == 1
    assert any("no proven programs" in line for line in out)
    assert any("known_drawings.json missing" in line for line in out)


def test_cli_refuses_bad_passwords_and_duplicates(
    settings: Settings, make_user: UserFactory
) -> None:
    out: list[str] = []
    answers = iter(["short", "short"])
    assert (
        cli(
            ["create-user", "x1", "--role", "operator"],
            settings=settings,
            out=out.append,
            ask=lambda _p: next(answers),
        )
        == 1
    )
    assert "at least 10" in out[-1]
    answers = iter(["a-long-password", "different-one!"])
    assert (
        cli(["create-user", "x2"], settings=settings, out=out.append, ask=lambda _p: next(answers))
        == 1
    )
    assert "do not match" in out[-1]
    make_user(Role.OPERATOR, username="dup")
    answers = iter(["a-long-password", "a-long-password"])
    assert (
        cli(["create-user", "dup"], settings=settings, out=out.append, ask=lambda _p: next(answers))
        == 1
    )
    assert "already exists" in out[-1]


def test_cli_set_password_deactivate_and_bridge(
    settings: Settings, make_user: UserFactory, db: Session
) -> None:
    make_user(Role.OPERATOR, username="op9", password="old-password")
    out: list[str] = []
    answers = iter(["brand-new-password", "brand-new-password"])
    assert (
        cli(
            ["set-password", "op9"], settings=settings, out=out.append, ask=lambda _p: next(answers)
        )
        == 0
    )
    assert cli(["deactivate", "op9"], settings=settings, out=out.append) == 0
    db.expire_all()
    assert db.scalars(select(User).where(User.username == "op9")).one().is_active is False
    assert (
        cli(["set-password", "ghost"], settings=settings, out=out.append, ask=lambda _p: "x") == 1
    )
    out.clear()
    assert cli(["create-bridge", "factory-pc-1"], settings=settings, out=out.append) == 0
    assert out[1].startswith("bridge_token: ") and out[2].startswith("signing_key: ")
    assert db.scalars(select(Bridge).where(Bridge.name == "factory-pc-1")).one()
    out.clear()
    assert cli(["list-users"], settings=settings, out=out.append) == 0
    assert any(line.startswith("op9") and "INACTIVE" in line for line in out)


def test_app_object_is_importable_for_uvicorn() -> None:
    from app.main import app

    assert isinstance(app, FastAPI)
