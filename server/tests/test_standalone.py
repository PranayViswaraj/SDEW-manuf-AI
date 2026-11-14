"""Single-PC install: one server process serves the API and the built web app."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text

from app.config import Settings, production_problems
from app.db.session import make_engine
from app.main import create_app
from tests.test_production import PROD_OK


@pytest.fixture
def web(tmp_path: Path) -> Path:
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>ManufAI</title>", encoding="utf-8")
    (d / "assets" / "app-123.js").write_text("console.log(1)", encoding="utf-8")
    (d / "manifest.webmanifest").write_text("{}", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("nope", encoding="utf-8")
    return d


def test_one_port_serves_pages_assets_and_api(settings: Settings, web: Path) -> None:
    app = create_app(settings.model_copy(update={"web_dir": str(web)}))
    with TestClient(app) as c:
        r = c.get("/")
        assert r.status_code == 200 and "<title>ManufAI</title>" in r.text
        assert r.headers["cache-control"] == "no-cache"
        # the browser's router opens deep links: the server answers with the app
        assert "<title>ManufAI</title>" in c.get("/make?table=3").text
        a = c.get("/assets/app-123.js")
        assert a.status_code == 200 and "immutable" in a.headers["cache-control"]
        assert c.get("/manifest.webmanifest").status_code == 200
        # the API keeps its own answers, including JSON 404s
        assert c.get("/api/health").json()["status"] in ("ok", "degraded")
        nf = c.get("/api/does-not-exist")
        assert nf.status_code == 404 and "detail" in nf.json()
        # nothing outside the web folder is ever served
        assert "nope" not in c.get("/..%2Fsecret.txt").text
        assert "nope" not in c.get("/assets/../../secret.txt").text
        assert c.get("/").headers["x-frame-options"] == "DENY"


def test_missing_build_is_a_clear_error(settings: Settings, tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="npm run build"):
        create_app(settings.model_copy(update={"web_dir": str(tmp_path / "nothing")}))


def test_standalone_allows_sqlite_but_not_in_onedrive() -> None:
    sqlite = {"database_url": "sqlite:///C:/Users/x/AppData/Local/ManufAI/manufai.db"}
    s = Settings(**{**PROD_OK, **sqlite, "standalone": True})
    assert production_problems(s) == []
    with pytest.raises(ValidationError, match="PostgreSQL"):
        Settings(**{**PROD_OK, **sqlite})  # SQLite without saying it is a one-PC install
    with pytest.raises(ValidationError, match="outside OneDrive"):
        Settings(
            **{
                **PROD_OK,
                "standalone": True,
                "database_url": "sqlite:///C:/Users/x/OneDrive/Desktop/manufai.db",
            }
        )


def test_sqlite_file_uses_wal(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'wal.db'}")
    with engine.connect() as c:
        assert c.execute(text("PRAGMA journal_mode")).scalar() == "wal"
        assert c.execute(text("PRAGMA busy_timeout")).scalar() == 5000
    engine.dispose()


def test_cli_backup_copies_the_live_database(settings: Settings, tmp_path: Path) -> None:
    import os
    import sqlite3
    import time

    from app.cli import run as cli

    folder = tmp_path / "backups"
    folder.mkdir()
    stale = folder / "manufai-20200101-000000.db"
    stale.write_bytes(b"old")
    old = time.time() - 40 * 86400
    os.utime(stale, (old, old))
    out: list[str] = []
    assert cli(["backup", "--to", str(folder)], settings=settings, out=out.append) == 0
    made = [f for f in folder.glob("manufai-*.db") if f != stale]
    assert len(made) == 1 and not stale.exists()
    with sqlite3.connect(made[0]) as d:
        assert d.execute("SELECT count(*) FROM alembic_version").fetchone()[0] == 1
    assert "Old backups removed: 1" in out[-1]


def test_one_port_install_compresses(settings: Settings, web: Path) -> None:
    (web / "assets" / "big.js").write_text("x" * 50_000, encoding="utf-8")
    app = create_app(settings.model_copy(update={"web_dir": str(web)}))
    with TestClient(app) as c:
        r = c.get("/assets/big.js", headers={"Accept-Encoding": "gzip"})
        assert r.headers.get("content-encoding") == "gzip" and len(r.text) == 50_000


def test_file_types_do_not_depend_on_the_windows_registry(settings: Settings, web: Path) -> None:
    app = create_app(settings.model_copy(update={"web_dir": str(web)}))
    with TestClient(app) as c:
        assert c.get("/assets/app-123.js").headers["content-type"].startswith("text/javascript")
        assert (
            c.get("/manifest.webmanifest")
            .headers["content-type"]
            .startswith("application/manifest+json")
        )
