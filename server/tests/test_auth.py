from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import AuditLog, Role
from app.seed import DEV_USERS, SeedRefusedError, run_seed
from tests.conftest import UserFactory, headers_for


def test_login_success_and_me(client: TestClient, make_user: UserFactory) -> None:
    make_user(Role.ENGINEER, Role.PROGRAMMER, username="alice", password="s3cret-pass")
    r = client.post("/api/auth/login", json={"username": "alice", "password": "s3cret-pass"})
    assert r.status_code == 200
    body = r.json()
    assert sorted(body["user"]["roles"]) == ["engineer", "programmer"]  # several roles
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200
    assert me.json()["username"] == "alice"


def test_login_wrong_password_is_rejected_and_audited(
    client: TestClient, make_user: UserFactory, db: Session
) -> None:
    make_user(Role.OPERATOR, username="bob", password="right-pass")
    r = client.post("/api/auth/login", json={"username": "bob", "password": "wrong"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Wrong username or password."
    row = db.scalars(select(AuditLog).where(AuditLog.action == "login")).one()
    assert row.result == "rejected"


def test_inactive_user_cannot_log_in(
    client: TestClient, make_user: UserFactory, db: Session
) -> None:
    u = make_user(Role.OPERATOR, username="carol", password="password123")
    u.is_active = False
    db.commit()
    r = client.post("/api/auth/login", json={"username": "carol", "password": "password123"})
    assert r.status_code == 401
    assert client.get("/api/auth/me", headers=headers_for(u)).status_code == 401


def test_garbage_token_rejected(client: TestClient) -> None:
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-token"})
    assert r.status_code == 401
    assert "log in again" in r.json()["detail"]


def test_passwords_are_hashed_with_argon2(make_user: UserFactory) -> None:
    u = make_user(Role.OPERATOR, password="plain-text-pw")
    assert u.password_hash.startswith("$argon2")
    assert "plain-text-pw" not in u.password_hash


def test_admin_manages_users_and_start_list(
    client: TestClient, role_headers: dict[str, dict[str, str]], db: Session
) -> None:
    admin = role_headers["admin"]
    r = client.post(
        "/api/users",
        headers=admin,
        json={"username": "dave", "password": "password123", "roles": ["operator"]},
    )
    assert r.status_code == 201
    assert r.json()["can_start_machine"] is False  # off unless admin turns it on
    uid = r.json()["id"]
    r = client.patch(f"/api/users/{uid}", headers=admin, json={"can_start_machine": True})
    assert r.status_code == 200 and r.json()["can_start_machine"] is True
    actions = [a.action for a in db.scalars(select(AuditLog))]
    assert "user_create" in actions and "user_update" in actions


def test_duplicate_username_rejected(
    client: TestClient, role_headers: dict[str, dict[str, str]]
) -> None:
    body = {"username": "erin", "password": "password123", "roles": []}
    assert client.post("/api/users", headers=role_headers["admin"], json=body).status_code == 201
    assert client.post("/api/users", headers=role_headers["admin"], json=body).status_code == 409


def test_cannot_remove_last_admin(client: TestClient, make_user: UserFactory) -> None:
    admin = make_user(Role.ADMIN, username="sole_admin")
    r = client.patch(f"/api/users/{admin.id}", headers=headers_for(admin), json={"roles": []})
    assert r.status_code == 409
    assert "last active admin" in r.json()["detail"]


def test_dev_seed_creates_role_users_once(settings: Settings, db: Session) -> None:
    s = settings.model_copy(update={"seed_dev_data": True})
    first = run_seed(s, db)
    assert len(first) == len(DEV_USERS)
    assert run_seed(s, db) == [] or all("dev user" not in x for x in run_seed(s, db))


def test_dev_seed_refused_in_production(settings: Settings, db: Session) -> None:
    s = settings.model_copy(update={"seed_dev_data": True, "env": "production"})
    try:
        run_seed(s, db)
    except SeedRefusedError:
        return
    raise AssertionError("seed should refuse in production")
