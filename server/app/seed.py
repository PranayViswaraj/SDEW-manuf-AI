"""Seed data. Run with:  python -m app.seed

Dev users (with the published dev passwords from the README) are only created when
MANUFAI_SEED_DEV_DATA=true and MANUFAI_ENV is not 'production'. Idempotent.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.security import hash_password
from app.config import Settings, get_settings
from app.db.guards import install_audit_guards
from app.db.models import Role, User
from app.db.session import make_engine, make_session_factory

# username -> (full name, password, roles, can_start_machine). DEV ONLY - see README.
DEV_USERS: dict[str, tuple[str, str, set[Role], bool]] = {
    "admin": ("Dev Admin", "admin-dev-pass", {Role.ADMIN}, False),
    "engineer": ("Dev Engineer", "engineer-dev-pass", {Role.ENGINEER}, False),
    "programmer": ("Dev Programmer", "programmer-dev-pass", {Role.PROGRAMMER}, False),
    "operator": ("Dev Operator", "operator-dev-pass", {Role.OPERATOR}, True),
}


class SeedRefusedError(RuntimeError):
    pass


def seed_dev_users(db: Session) -> list[str]:
    created: list[str] = []
    for username, (full_name, password, roles, can_start) in DEV_USERS.items():
        if db.scalar(select(User).where(User.username == username)):
            continue
        user = User(
            username=username,
            full_name=full_name,
            password_hash=hash_password(password),
            can_start_machine=can_start,
        )
        user.set_roles(roles)
        db.add(user)
        created.append(username)
    db.commit()
    return created


def run_seed(settings: Settings, db: Session) -> list[str]:
    """Run all seed steps that apply to these settings. Returns a log of what was done."""
    log: list[str] = []
    if settings.seed_dev_data:
        if settings.env == "production":
            raise SeedRefusedError("Refusing to seed dev users in production.")
        log += [f"created dev user {u}" for u in seed_dev_users(db)]
    return log


def main() -> None:
    settings = get_settings()
    install_audit_guards()
    factory = make_session_factory(make_engine(settings.database_url))
    with factory() as db:
        for line in run_seed(settings, db) or ["nothing to seed"]:
            print(f"seed: {line}")


if __name__ == "__main__":
    main()
