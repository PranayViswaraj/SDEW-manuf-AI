"""Program approval rules (safety rule 3, program half).

`approval_problem` is checked again at the moment of sending, so an approval can never be used
for a different machine, a different version, or text that changed after approval.
"""

from sqlalchemy.orm import Session

from app.db.models import Machine, Program, ProgramStatus
from app.services.program_store import family, sha256_text, validate_for_machine


def controller_problem(machine: Machine) -> str | None:
    """Programs here are FANUC lathe code and are sent with FANUC FOCAS over Ethernet. A machine
    whose control has not been confirmed as FANUC can never receive one."""
    if not (machine.controller or "").strip().upper().startswith("FANUC"):
        return (
            f"The control of {machine.name} is not confirmed. Programs here are FANUC lathe code "
            "and are sent with FANUC FOCAS over Ethernet. Check the control at the machine and "
            "enter it on the Machines page."
        )
    return None


def approval_problem(db: Session, program: Program, machine: Machine) -> str | None:
    name = f"O{program.program_number:04d} v{program.version}"
    if problem := controller_problem(machine):
        return problem
    if program.machine_id != machine.id:
        return f"{name} is approved for a different machine, not {machine.name}."
    if program.status != ProgramStatus.APPROVED.value:
        return f"{name} is not approved (status: {program.status})."
    if not program.approved_hash or program.approved_hash != program.sha256:
        return f"{name}: approval does not match this version. Approve it again."
    if sha256_text(program.text) != program.sha256:
        return f"{name}: stored text does not match its hash. Do not send; contact the admin."
    newest = family(db, program)[0]
    if newest.id != program.id:
        return f"{name} is not the latest version (v{newest.version} exists)."
    result = validate_for_machine(program.text, machine)
    if result.errors:
        return f"{name} now fails validation on {machine.name}: {result.errors[0].message}"
    return None
