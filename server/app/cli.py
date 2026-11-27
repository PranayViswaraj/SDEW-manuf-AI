"""Admin command-line tool for the server (run where the server runs).

    python -m app.cli check                          # settings, database, migrations, admins
    python -m app.cli create-user alice --role admin  # asks for the password twice
    python -m app.cli create-user op1 --role operator --can-start --full-name "A. Operator"
    python -m app.cli set-password alice
    python -m app.cli deactivate bob
    python -m app.cli list-users
    python -m app.cli create-bridge factory-pc-1      # prints token + signing key ONCE

In Docker:  docker compose exec server python -m app.cli create-user alice --role admin
Every change is written to the audit log (via "cli").
"""

import argparse
import getpass
import secrets
import sys
from collections.abc import Callable, Sequence

from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.security import hash_password
from app.config import Settings, get_settings, production_problems
from app.db.guards import install_audit_guards
from app.db.models import Bridge, Role, User
from app.db.session import make_engine, make_session_factory
from app.services.audit_log import AuditLogger, AuditResult
from app.services.command_signing import hash_token

Out = Callable[[str], None]
MIN_PASSWORD = 10


class CliError(Exception):
    pass


def _password(args: argparse.Namespace, ask: Callable[[str], str]) -> str:
    if args.password_stdin:
        pw = sys.stdin.readline().rstrip("\n")
    else:
        pw = ask("Password: ")
        if ask("Repeat password: ") != pw:
            raise CliError("The passwords do not match.")
    if len(pw) < MIN_PASSWORD:
        raise CliError(f"Password must be at least {MIN_PASSWORD} characters.")
    return pw


def _get_user(db: Session, username: str) -> User:
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        raise CliError(f"No user called '{username}'.")
    return user


def _check_data_files(settings: Settings, out: Out) -> bool:
    """The proven programs are reference only (company-wide cutting values, code style): every
    part is read from its drawing by the AI, so missing programs are a note, never an error."""
    from pathlib import Path

    from app.services.program_library import load_library

    programs = Path(settings.samples_dir)
    count = len(load_library(str(programs))) if programs.is_dir() else 0
    out(f"Reference programs: {count} in {programs}")
    if count == 0:
        out("  note: no reference programs; standard cutting values are used")
    return True


def cmd_check(settings: Settings, factory: sessionmaker[Session], out: Out) -> int:
    ok = True
    out(f"Environment: {settings.env}")
    problems = production_problems(settings)
    if problems:
        tag = "ERROR" if settings.is_production else "note (fine for dev)"
        for p in problems:
            out(f"  {tag}: {p}")
        ok = ok and not settings.is_production
    else:
        out("  Settings: OK for production")
    try:
        with factory() as db:
            db.execute(text("SELECT 1"))
            from alembic.runtime.migration import MigrationContext

            from app.api.health import head_revision  # local import: needs alembic files

            current = MigrationContext.configure(db.connection()).get_current_revision()
            head = head_revision()
            out(f"Database: reachable, schema {current or 'empty'} (latest {head})")
            if current != head:
                out("  ERROR: run 'alembic upgrade head'")
                ok = False
            admins = sum(
                1 for u in db.scalars(select(User).where(User.is_active)) if Role.ADMIN in u.roles
            )
            users = db.scalar(select(func.count()).select_from(User)) or 0
            out(f"Users: {users} (active admins: {admins})")
            if admins == 0:
                out(
                    "  ERROR: no active admin. Run: python -m app.cli create-user NAME --role admin"
                )
                ok = False
    except SQLAlchemyError as e:
        out(f"Database: NOT reachable ({e.__class__.__name__})")
        ok = False
    ok = _check_data_files(settings, out) and ok
    out("RESULT: " + ("OK" if ok else "PROBLEMS FOUND"))
    return 0 if ok else 1


def cmd_backup(settings: Settings, folder: str, keep_days: int, out: Out) -> int:
    """Online copy of the SQLite database (safe while the server runs), plus clean-up."""
    import sqlite3
    import time
    from datetime import datetime
    from pathlib import Path

    url = settings.database_url
    if not url.startswith("sqlite:///"):
        raise CliError("backup is for the single-PC SQLite install; use scripts/backup.sh.")
    src = Path(url.removeprefix("sqlite:///"))
    if not src.is_file():
        raise CliError(f"Database not found: {src}")
    dest_dir = Path(folder)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"manufai-{datetime.now():%Y%m%d-%H%M%S}.db"
    with sqlite3.connect(src) as s, sqlite3.connect(dest) as d:
        s.backup(d)
    with sqlite3.connect(dest) as d:
        if d.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise CliError(f"Backup {dest} failed its integrity check.")
    cutoff = time.time() - keep_days * 86400
    removed = 0
    for old in dest_dir.glob("manufai-*.db"):
        if old != dest and old.stat().st_mtime < cutoff:
            old.unlink()
            removed += 1
    size_kb = dest.stat().st_size // 1024
    out(f"Backup written: {dest} ({size_kb} KB). Old backups removed: {removed}.")
    return 0


def run(
    argv: Sequence[str] | None = None,
    settings: Settings | None = None,
    out: Out = print,
    ask: Callable[[str], str] = getpass.getpass,
) -> int:
    p = argparse.ArgumentParser(prog="python -m app.cli", description="ManufAI admin tool")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="check settings, database, migrations and admins")
    cu = sub.add_parser("create-user", help="create a user")
    cu.add_argument("username")
    cu.add_argument("--role", action="append", choices=[r.value for r in Role], default=[])
    cu.add_argument("--full-name", default="")
    cu.add_argument("--can-start", action="store_true", help="add to the allowed-to-start list")
    cu.add_argument("--password-stdin", action="store_true", help="read the password from stdin")
    sp = sub.add_parser("set-password", help="set a new password for a user")
    sp.add_argument("username")
    sp.add_argument("--password-stdin", action="store_true")
    de = sub.add_parser("deactivate", help="stop a user from logging in")
    de.add_argument("username")
    sub.add_parser("list-users", help="list users and roles")
    cb = sub.add_parser("create-bridge", help="create a bridge and print its secrets once")
    cb.add_argument("name")
    bk = sub.add_parser("backup", help="copy the SQLite database safely (single-PC install)")
    bk.add_argument("--to", required=True, help="backup folder")
    bk.add_argument("--keep-days", type=int, default=30)
    args = p.parse_args(argv)

    settings = settings or get_settings()
    install_audit_guards()
    factory = make_session_factory(make_engine(settings.database_url))
    audit = AuditLogger(factory)

    try:
        if args.cmd == "check":
            return cmd_check(settings, factory, out)
        if args.cmd == "backup":
            return cmd_backup(settings, args.to, args.keep_days, out)
        with factory() as db:
            if args.cmd == "create-user":
                if db.scalar(select(User).where(User.username == args.username)):
                    raise CliError(f"User '{args.username}' already exists.")
                user = User(
                    username=args.username,
                    full_name=args.full_name,
                    password_hash=hash_password(_password(args, ask)),
                    can_start_machine=args.can_start,
                )
                user.set_roles({Role(r) for r in args.role})
                db.add(user)
                db.commit()
                audit.record(
                    "user_create",
                    AuditResult.OK,
                    payload={"username": user.username, "roles": sorted(args.role), "via": "cli"},
                )
                roles = ", ".join(sorted(args.role)) or "none"
                out(f"Created user '{user.username}' with roles: {roles}.")
            elif args.cmd == "set-password":
                user = _get_user(db, args.username)
                user.password_hash = hash_password(_password(args, ask))
                db.commit()
                audit.record(
                    "user_update",
                    AuditResult.OK,
                    payload={
                        "username": user.username,
                        "changes": {"password": "changed"},
                        "via": "cli",
                    },
                )
                out(f"Password changed for '{user.username}'.")
            elif args.cmd == "deactivate":
                user = _get_user(db, args.username)
                user.is_active = False
                db.commit()
                audit.record(
                    "user_update",
                    AuditResult.OK,
                    payload={
                        "username": user.username,
                        "changes": {"is_active": False},
                        "via": "cli",
                    },
                )
                out(f"User '{user.username}' can no longer log in.")
            elif args.cmd == "list-users":
                for u in db.scalars(select(User).order_by(User.username)):
                    flags = ("active" if u.is_active else "INACTIVE") + (
                        ", can start" if u.can_start_machine else ""
                    )
                    out(f"{u.username:20} {', '.join(sorted(u.roles)) or '-':35} {flags}")
            elif args.cmd == "create-bridge":
                if db.scalar(select(Bridge).where(Bridge.name == args.name)):
                    raise CliError(f"Bridge '{args.name}' already exists.")
                token, key = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
                db.add(Bridge(name=args.name, token_hash=hash_token(token), signing_key=key))
                db.commit()
                audit.record(
                    "bridge_create", AuditResult.OK, payload={"bridge": args.name, "via": "cli"}
                )
                out("Put these two lines in the bridge config.yaml. They are not shown again:")
                out(f"bridge_token: {token}")
                out(f"signing_key: {key}")
    except CliError as e:
        out(f"Error: {e}")
        return 1
    return 0


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
