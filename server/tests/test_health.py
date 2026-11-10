from pathlib import Path

from fastapi.testclient import TestClient

from app import __version__
from app.config import Settings
from app.main import create_app


def test_health_ok(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"
    assert body["version"] == __version__


def test_health_reports_db_error(tmp_path: Path) -> None:
    missing_dir = (tmp_path / "no" / "such" / "dir" / "x.db").as_posix()
    with TestClient(create_app(Settings(database_url=f"sqlite:///{missing_dir}"))) as c:
        r = c.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "degraded"
    assert r.json()["database"] == "error"


def test_safety_timing_defaults() -> None:
    s = Settings()
    assert s.status_stale_seconds == 5.0  # safety rule 8
    assert s.command_max_age_seconds == 10.0
