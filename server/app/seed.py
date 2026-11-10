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
from app.db.models import (
    Bridge,
    FeatureTable,
    FeatureTableStatus,
    Machine,
    Material,
    Program,
    ProgramSource,
    Role,
    Tool,
    User,
    empty_limits,
    grade_key,
)
from app.db.session import make_engine, make_session_factory
from app.services.command_signing import hash_token
from app.services.feature_tables import data_hash, normalise
from app.services.material_import import map_rows, parse_table, suggest_mapping
from app.services.program_store import create_version, import_trusted_programs

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


DEV_BRIDGE = "dev-bridge"
SIM_MACHINE_KEY = "sim-lathe-dev"
# FICTIONAL machine for development only. These values describe no real machine.
SIM_LIMITS = {
    "max_turning_diameter": 200.0,
    "max_turning_length": 300.0,
    "max_bar_diameter": 52.0,
    "spindle_rpm_min": 50,
    "spindle_rpm_max": 4000,
    "chuck_size": "8 in (simulated)",
    "turret_stations": 8,
}
SIM_TOOLS = [
    (1, "T0101", "U-drill (simulated)", "", None, "drill"),
    (2, "T0202", "OD rough (simulated)", "WNMG", 0.8, "od_rough"),
    (3, "T0303", "OD finish (simulated)", "TNMG", 0.4, "od_finish"),
    (4, "T0404", "Parting 3 mm (simulated)", "", None, "parting"),
    (5, "T0505", "Groove (simulated)", "", None, "groove"),
    (6, "T0606", "Thread (simulated)", "", None, "thread"),
    (7, "T0707", "Bore (simulated)", "CCMT", 0.4, "bore"),
    (8, "T0808", "Stopper (simulated)", "", None, "stopper"),
]


def seed_dev_bridge(db: Session, settings: Settings) -> list[str]:
    """DEV ONLY: a bridge with published credentials and a fictional simulated lathe."""
    log: list[str] = []
    if not db.scalar(select(Bridge).where(Bridge.name == DEV_BRIDGE)):
        db.add(
            Bridge(
                name=DEV_BRIDGE,
                token_hash=hash_token(settings.dev_bridge_token),
                signing_key=settings.dev_bridge_signing_key,
            )
        )
        log.append("created dev bridge")
    lmw = db.scalar(select(Machine).where(Machine.key == "lmw-lathe-1"))
    if lmw is not None and lmw.bridge_id is None:
        lmw.bridge_id = DEV_BRIDGE
        log.append("assigned LMW Lathe 1 to dev bridge (simulated driver in dev)")
    if not db.scalar(select(Machine).where(Machine.key == SIM_MACHINE_KEY)):
        sim = Machine(
            key=SIM_MACHINE_KEY,
            name="SIM Lathe (dev - simulated)",
            make="Simulator",
            model="FANUC 0i-TF simulator",
            controller="FANUC 0i-TF",
            ip_address=None,
            bridge_id=DEV_BRIDGE,
            # Explicitly enabled for this FICTIONAL simulated machine only, to demo remote control.
            remote_control_enabled=True,
            limits=dict(SIM_LIMITS),
            notes="FICTIONAL SIMULATED MACHINE for development. Limits and tools are demo values.",
        )
        sim.tools = [
            Tool(station=st, tool_code=c, description=d, insert_type=i, nose_radius=r, tool_type=t)
            for st, c, d, i, r, t in SIM_TOOLS
        ]
        db.add(sim)
        log.append("created SIM Lathe (dev - simulated)")
    db.commit()
    return log


def seed_trusted_programs(db: Session, settings: Settings) -> list[str]:
    """The company's trusted O-files -> approved programs for LMW Lathe 1 (always, not dev-only)."""
    lmw = db.scalar(select(Machine).where(Machine.key == "lmw-lathe-1"))
    if lmw is None:
        return []
    return import_trusted_programs(db, lmw, Path(settings.samples_dir))


def seed_demo_program(db: Session, settings: Settings) -> list[str]:
    """DEV ONLY: synthetic O9000 as a DRAFT for the fictional SIM lathe (never for LMW)."""
    sim = db.scalar(select(Machine).where(Machine.key == SIM_MACHINE_KEY))
    path = Path(settings.samples_dir).parent / "demo" / "O9000"
    if sim is None or not path.is_file():
        return []
    if db.scalar(select(Program).where(Program.machine_id == sim.id)):
        return []
    create_version(
        db,
        machine=sim,
        text=path.read_bytes().decode("ascii"),
        source=ProgramSource.DEMO,
        user=None,
        part_number="DEMO-SIM-001",
        source_note="SIMULATOR DEMO - NOT FOR MACHINE USE",
    )
    db.commit()
    return ["created demo program O9000 (draft) for SIM Lathe"]


def _cell(v: float | str) -> dict[str, object]:
    return {"ai": None, "value": v, "confirmed": True}


def seed_demo_feature_table(db: Session) -> list[str]:
    """DEV ONLY: confirmed feature table for the synthetic demo part on the fictional SIM lathe."""
    if db.scalar(select(FeatureTable).where(FeatureTable.part_number == "DEMO-SIM-001")):
        return []
    data = normalise(
        {
            "header": {
                "material_grade": _cell("EN8"),
                "bar_diameter": _cell(45.0),
                "overall_length": _cell(20.0),
            },
            "features": [
                {
                    "type": "od",
                    "fields": {
                        "diameter": _cell(40.0),
                        "length": _cell(20.0),
                        "tol_plus": _cell(0.0),
                        "tol_minus": _cell(-0.05),
                    },
                },
                {
                    "type": "chamfer",
                    "fields": {
                        "size": _cell(2.0),
                        "angle": _cell(45.0),
                        "tol_plus": _cell(0.2),
                        "tol_minus": _cell(-0.2),
                    },
                },
            ],
        }
    )
    db.add(
        FeatureTable(
            part_number="DEMO-SIM-001",
            drawing_ref="SIMULATOR DEMO - NOT A REAL PART",
            source="manual",
            data=data,
            status=FeatureTableStatus.CONFIRMED.value,
            confirmed_by_name="Dev seed (demo part)",
            confirmed_hash=data_hash(data),
        )
    )
    db.commit()
    return ["created confirmed DEMO feature table for DEMO-SIM-001"]


def run_seed(settings: Settings, db: Session) -> list[str]:
    """Run all seed steps that apply to these settings. Returns a log of what was done."""
    log: list[str] = []
    log += seed_machines(db)
    log += seed_trusted_programs(db, settings)
    if settings.seed_dev_data:
        if settings.env == "production":
            raise SeedRefusedError("Refusing to seed dev users in production.")
        log += [f"created dev user {u}" for u in seed_dev_users(db)]
        log += seed_sample_materials(db, settings.sample_materials_csv)
        log += seed_dev_bridge(db, settings)
        log += seed_demo_program(db, settings)
        log += seed_demo_feature_table(db)
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
