"""The ONE function through which every machine action goes (coding rule + safety rules 4, 7, 9).

    execute_machine_action(...)
      1. checks: allowed action, role / allowed-to-start list, remote-control flag, extra gates
      2. writes the audit log entry ("requested") BEFORE acting
      3. sends the signed command through the bridge hub and waits for the ack
      4. writes the result to the audit log

Program approval (rule 3) and the start checklist (rule 4) are passed in as `gates` by the run
service (Milestone 11); this function refuses to act if any gate fails.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Final

from app.config import Settings
from app.db.models import Machine, Role, User
from app.services.audit_log import AuditLogger, AuditResult
from app.services.bridge_hub import BridgeHub, BridgeUnavailable, CommandTimeout

ALLOWED_ACTIONS: Final[frozenset[str]] = frozenset(
    {"send_program", "start", "feed_hold", "stop", "read_status"}
)
REMOTE_CONTROL_ACTIONS: Final[frozenset[str]] = frozenset({"start", "feed_hold", "stop"})
REMOTE_OFF_MESSAGE = "Remote control is off for this machine. Press Cycle Start at the machine."

# A gate returns None when OK, or a plain-English reason to refuse.
Gate = Callable[[], str | None]


@dataclass
class ProgramRef:
    id: int
    number: int
    sha256: str
    text: str


@dataclass
class ActionResult:
    action: str
    result: str  # ok | rejected | failed
    error: str | None = None
    details: dict[str, Any] = field(default_factory=dict)
    command_id: str | None = None

    @property
    def ok(self) -> bool:
        return self.result == "ok"


def permission_problem(user: User, action: str) -> str | None:
    if action == "read_status":
        return None
    if not user.has_role(Role.OPERATOR):
        return "Only an operator can do this."
    if action == "start" and not user.can_start_machine:
        return "You are not on the list of people allowed to press Start."
    return None


async def execute_machine_action(
    *,
    hub: BridgeHub,
    audit: AuditLogger,
    settings: Settings,
    user: User,
    machine: Machine,
    action: str,
    program: ProgramRef | None = None,
    gates: list[Gate] | None = None,
    payload: dict[str, Any] | None = None,
) -> ActionResult:
    info = dict(payload or {}, machine_key=machine.key)

    def record(result: str, error: str | None = None, more: dict[str, Any] | None = None) -> None:
        audit.record(
            action,
            result,
            user=user,
            machine_id=machine.id,
            program_id=program.id if program else None,
            program_hash=program.sha256 if program else None,
            payload=info | (more or {}),
            error=error,
        )

    def refuse(reason: str) -> ActionResult:
        record(AuditResult.REJECTED, reason)
        return ActionResult(action, "rejected", reason)

    if action not in ALLOWED_ACTIONS:
        return refuse(f"Action '{action}' is not allowed.")
    if problem := permission_problem(user, action):
        return refuse(problem)
    if action in REMOTE_CONTROL_ACTIONS and not machine.remote_control_enabled:
        return refuse(REMOTE_OFF_MESSAGE)
    if action == "send_program" and program is None:
        return refuse("No program selected.")
    for gate in gates or []:
        if reason := gate():
            return refuse(reason)

    extra: dict[str, Any] = {}
    if action == "send_program" and program is not None:
        extra = {"program_text": program.text, "program_number": program.number}
    elif action == "start" and program is not None:
        extra = {"program_number": program.number}
    command = hub.build_command(
        action=action,
        machine_key=machine.key,
        user_id=user.id,
        program_id=program.id if program else None,
        program_hash=program.sha256 if program else None,
        extra=extra,
    )
    info["command_id"] = command["id"]

    # Audit BEFORE acting.
    record(AuditResult.REQUESTED)

    timeout = settings.bridge_send_timeout_s if action == "send_program" else 15.0
    try:
        ack = await hub.send_command(machine.bridge_id, command, timeout)
    except (BridgeUnavailable, CommandTimeout) as e:
        record(AuditResult.FAILED, str(e))
        return ActionResult(action, "failed", str(e), command_id=command["id"])

    result = str(ack.get("result", "failed"))
    if result not in ("ok", "rejected", "failed"):
        result = "failed"
    error = ack.get("error")
    details = dict(ack.get("details") or {})
    record(result, error, {"bridge_details": details})
    return ActionResult(action, result, error, details, command["id"])
