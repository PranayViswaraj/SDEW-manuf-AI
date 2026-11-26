"""Shared fixtures.

The schema is built ONCE per test session by running the real Alembic migrations (so DB
triggers exist exactly as in production), then each test gets its own copy of that file.
"""

import os
import shutil
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

# Tests never call the real AI: a developer's .env may hold an API key and MANUFAI_AI_READER=claude.
# Environment variables win over .env files.
os.environ["MANUFAI_AI_READER"] = "off"
os.environ["ANTHROPIC_API_KEY"] = ""

from app.auth.security import create_access_token, hash_password  # noqa: E402
from app.config import Settings
from app.db.models import Role, User
from app.main import create_app

# End-to-end fixtures (live server + bridge): server, bridge, e2e_settings.
pytest_plugins = ["tests.e2e_support"]

SERVER_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = SERVER_DIR.parent
JWT_SECRET = "test-secret-that-is-at-least-32-characters"


def sqlite_url(path: Path) -> str:
    return f"sqlite:///{path.as_posix()}"


@pytest.fixture(scope="session", autouse=True)
def _fast_password_hashing() -> Iterator[None]:
    """Argon2 at production cost makes every test slow; tests use a cheap setting."""
    from argon2 import PasswordHasher

    from app.auth import security

    original = security._hasher
    security._hasher = PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)
    yield
    security._hasher = original


@pytest.fixture(scope="session")
def template_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("template") / "template.db"
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "app" / "db" / "migrations"))
    cfg.set_main_option("sqlalchemy.url", sqlite_url(path))
    command.upgrade(cfg, "head")
    return path


@pytest.fixture
def db_path(template_db: Path, tmp_path: Path) -> Path:
    path = tmp_path / "test.db"
    shutil.copy(template_db, path)
    return path


@pytest.fixture
def settings(db_path: Path) -> Settings:
    return Settings(
        database_url=sqlite_url(db_path),
        jwt_secret=JWT_SECRET,
        samples_dir=str(REPO_DIR / "samples" / "programs"),
        sample_materials_csv=str(
            REPO_DIR / "samples" / "materials" / "raw-material-register.sample.csv"
        ),
    )


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db(app: FastAPI) -> Iterator[Session]:
    with app.state.session_factory() as s:
        yield s


UserFactory = Callable[..., User]


@pytest.fixture
def make_user(db: Session) -> UserFactory:
    counter = {"n": 0}

    def _make(
        *roles: Role,
        username: str | None = None,
        can_start_machine: bool = False,
        password: str = "password123",
    ) -> User:
        counter["n"] += 1
        u = User(
            username=username or f"user{counter['n']}",
            full_name="Test User",
            password_hash=hash_password(password),
            can_start_machine=can_start_machine,
        )
        u.set_roles(set(roles))
        db.add(u)
        db.commit()
        return u

    return _make


def token_for(user: User) -> str:
    return create_access_token(user.id, JWT_SECRET, 60)


def headers_for(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {token_for(user)}"}


@pytest.fixture
def role_headers(make_user: UserFactory) -> dict[str, dict[str, str]]:
    """Auth headers for one user per role, plus 'none' (logged in, no roles)."""
    out = {r.value: headers_for(make_user(r, username=f"only_{r.value}")) for r in Role}
    out["none"] = headers_for(make_user(username="no_roles"))
    return out
