"""Seed data. Run with:  python -m app.seed

Dev users (with the published dev passwords from the README) are only created when
MANUFAI_SEED_DEV_DATA=true and MANUFAI_ENV is not 'production'. Idempotent.
"""

from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.security import hash_password
from app.config import Settings, get_settings
from app.db.guards import install_audit_guards
from app.db.models import Machine, Material, Role, User, empty_limits, grade_key
from app.db.session import make_engine, make_session_factory
from app.services.material_import import map_rows, parse_table, suggest_mapping

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


def seed_machines(db: Session) -> list[str]:
    """The one known real machine. Every unknown value stays empty (never invented)."""
    if db.scalar(select(Machine).where(Machine.key == "lmw-lathe-1")):
        return []
    db.add(
        Machine(
            key="lmw-lathe-1",
            name="LMW Lathe 1",
            make="LMW",
            model="",  # TODO(REAL-DATA): model from nameplate
            controller="FANUC 0i-TF",
            ip_address=None,  # TODO(REAL-DATA): machine IP on the factory LAN
            focas_port=8193,
            remote_control_enabled=False,  # safety rule 9
            limits=empty_limits(),  # TODO(REAL-DATA): all limits from nameplate
            notes="Limits, model, IP and tool layout not entered yet.",
        )
    )
    db.commit()
    return ["created machine LMW Lathe 1"]


def seed_sample_materials(db: Session, csv_path: str) -> list[str]:
    """DEV ONLY: load the sample register (rows are marked SAMPLE DATA) into an empty table."""
    if db.scalar(select(func.count()).select_from(Material)):
        return []
    path = Path(csv_path)
    if not path.is_file():
        return [f"sample materials CSV not found at {path} (skipped)"]
    table = parse_table(path.read_bytes(), path.name)
    rows = [r.data for r in map_rows(table, suggest_mapping(table.headers)) if r.data]
    for d in rows:
        db.add(Material(**d.__dict__, grade_key=grade_key(d.grade)))
    db.commit()
    return [f"loaded {len(rows)} SAMPLE materials from {path.name}"]


def run_seed(settings: Settings, db: Session) -> list[str]:
    """Run all seed steps that apply to these settings. Returns a log of what was done."""
    log: list[str] = []
    log += seed_machines(db)
    if settings.seed_dev_data:
        if settings.env == "production":
            raise SeedRefusedError("Refusing to seed dev users in production.")
        log += [f"created dev user {u}" for u in seed_dev_users(db)]
        log += seed_sample_materials(db, settings.sample_materials_csv)
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
