"""Program storage and versioning. Programs are only ever created from a known source
(company import, upload by a person, demo, or the deterministic generator) — never by AI."""

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Machine, Program, ProgramSource, ProgramStatus, Tool, User
from app.gcode.parser import parse_program, part_number_and_title
from app.gcode.validator import MachineContext, ValidationResult, validate

MAX_PROGRAM_BYTES = 1_000_000


class ProgramError(ValueError):
    """Plain-English problem with a program request."""


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def machine_context(machine: Machine) -> MachineContext:
    limits = machine.limits or {}
    tools: list[Tool] = list(machine.tools)
    return MachineContext(
        tool_codes={t.tool_code for t in tools},
        spindle_rpm_min=limits.get("spindle_rpm_min"),
        spindle_rpm_max=limits.get("spindle_rpm_max"),
    )


def validate_for_machine(program_text: str, machine: Machine) -> ValidationResult:
    return validate(program_text, machine_context(machine))


@dataclass
class HeaderInfo:
    program_number: int
    part_number: str
    title: str


def read_header(text: str) -> HeaderInfo:
    prog = parse_program(text)
    if prog.o_number is None:
        raise ProgramError("The first line after '%' must be the program number, e.g. O0001(...).")
    part, title = part_number_and_title(prog.header_comment)
    return HeaderInfo(prog.o_number, part, title)


def family(db: Session, p: Program) -> list[Program]:
    stmt = (
        select(Program)
        .where(
            Program.machine_id == p.machine_id,
            Program.part_number == p.part_number,
            Program.program_number == p.program_number,
        )
        .order_by(Program.version.desc())
    )
    return list(db.scalars(stmt))


def _next_version(db: Session, machine_id: int, part: str, number: int) -> int:
    current = db.scalar(
        select(func.max(Program.version)).where(
            Program.machine_id == machine_id,
            Program.part_number == part,
            Program.program_number == number,
        )
    )
    return int(current or 0) + 1


def create_version(
    db: Session,
    *,
    machine: Machine,
    text: str,
    source: ProgramSource,
    user: User | None,
    part_number: str | None = None,
    source_note: str = "",
) -> Program:
    """Store a new program version (draft). Any approved version of the same family is retired:
    a text change always clears approval."""
    if not isinstance(source, ProgramSource):
        raise ProgramError("Unknown program source.")
    if len(text.encode("utf-8")) > MAX_PROGRAM_BYTES:
        raise ProgramError("Program is larger than 1 MB.")
    try:
        text.encode("ascii")
    except UnicodeEncodeError as e:
        raise ProgramError(
            "Program contains non-ASCII characters. FANUC accepts ASCII only."
        ) from e
    header = read_header(text)
    part = (part_number or header.part_number).strip()
    if not part:
        raise ProgramError("Give a part number (the program header comment has none).")
    version = _next_version(db, machine.id, part, header.program_number)
    p = Program(
        machine_id=machine.id,
        part_number=part[:64],
        program_number=header.program_number,
        title=header.title[:128],
        version=version,
        text=text,
        sha256=sha256_text(text),
        status=ProgramStatus.DRAFT.value,
        source=source.value,
        source_note=source_note,
        created_by=user.id if user else None,
    )
    for older in family_by_key(db, machine.id, part, header.program_number):
        if older.status == ProgramStatus.APPROVED.value:
            older.status = ProgramStatus.RETIRED.value
            older.status_note = f"Superseded by version {version} (text changed)."
    db.add(p)
    db.flush()
    return p


def family_by_key(db: Session, machine_id: int, part: str, number: int) -> list[Program]:
    return list(
        db.scalars(
            select(Program).where(
                Program.machine_id == machine_id,
                Program.part_number == part,
                Program.program_number == number,
            )
        )
    )


def mark_approved(p: Program, approver: User | None, approver_name: str) -> None:
    p.status = ProgramStatus.APPROVED.value
    p.approved_by = approver.id if approver else None
    p.approved_by_name = approver_name
    p.approved_at = datetime.now(UTC)
    p.approved_hash = p.sha256
    p.status_note = ""


def import_trusted_programs(db: Session, machine: Machine, folder: Path) -> list[str]:
    """Import O-files supplied by the company as APPROVED + proven for `machine`. Idempotent:
    a file whose exact hash is already stored for this machine is skipped."""
    log: list[str] = []
    if not folder.is_dir():
        return [f"trusted programs folder not found: {folder} (skipped)"]
    for path in sorted(folder.glob("O[0-9][0-9][0-9][0-9]")):
        text = path.read_bytes().decode("ascii")  # exact bytes, \r kept
        digest = sha256_text(text)
        exists = db.scalar(
            select(Program).where(Program.machine_id == machine.id, Program.sha256 == digest)
        )
        if exists:
            continue
        p = create_version(
            db,
            machine=machine,
            text=text,
            source=ProgramSource.TRUSTED_IMPORT,
            user=None,
            source_note="trusted, supplied by company",
        )
        mark_approved(p, None, "Company (trusted import)")
        p.proven = True
        p.proven_at = datetime.now(UTC)
        p.proven_note = f"Supplied by the company as proven on {machine.name}."
        log.append(f"imported trusted program {path.name} for {machine.name}")
    db.commit()
    return log
