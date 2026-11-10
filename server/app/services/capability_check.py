"""Capability check (rules only, no AI): can this machine make this part?

Never assumes capable: any machine limit or tool information that is missing makes the answer
"unknown", and the machine is not offered.
"""

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from app.db.models import Machine, MachineState
from app.services.feature_tables import FEATURE_TYPES

Verdict = Literal["capable", "not_capable", "unknown"]
UNKNOWN_LIMITS = "Unknown – machine limits not entered"

TURNING = {"od_rough", "od_finish"}
# Tool types a feature needs: each inner set = "at least one of these".
REQUIRED_TOOLS: dict[str, list[set[str]]] = {
    "od": [TURNING],
    "face": [TURNING],
    "chamfer": [TURNING | {"bore"}],
    "radius": [TURNING | {"bore"}],
    "bore": [{"bore"}, {"drill"}],  # a bore needs a hole first
    "drill": [{"drill"}],
    "groove": [{"groove"}],
    "thread": [{"thread"}],
}
TOOL_NAMES = {
    "od_rough": "OD roughing",
    "od_finish": "OD finishing",
    "bore": "boring bar",
    "drill": "drill",
    "groove": "grooving",
    "thread": "threading",
}


@dataclass
class Reason:
    check: str
    status: Literal["pass", "fail", "unknown"]
    message: str


@dataclass
class CapabilityResult:
    verdict: Verdict
    reasons: list[Reason] = field(default_factory=list)

    @property
    def capable(self) -> bool:
        return self.verdict == "capable"

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "capable": self.capable,
            "summary": summary(self),
            "reasons": [asdict(r) for r in self.reasons],
        }


def summary(res: CapabilityResult) -> str:
    if res.verdict == "capable":
        return "Capable"
    fails = [r.message for r in res.reasons if r.status == "fail"]
    if fails:
        return "Not capable: " + fails[0]
    return UNKNOWN_LIMITS


def _value(cell: dict[str, Any] | None) -> Any:
    return None if cell is None else cell.get("value")


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def _limit_check(
    reasons: list[Reason], check: str, part_value: float | None, limit: Any, label: str
) -> None:
    lim = _num(limit)
    if part_value is None:
        reasons.append(Reason(check, "unknown", f"Part {label} is not entered."))
    elif lim is None:
        reasons.append(Reason(check, "unknown", f"{UNKNOWN_LIMITS} ({label} limit)."))
    elif part_value > lim + 1e-9:
        reasons.append(
            Reason(
                check,
                "fail",
                f"Part {label} {part_value:g} mm is more than the machine's {lim:g} mm.",
            )
        )
    else:
        reasons.append(
            Reason(check, "pass", f"Part {label} {part_value:g} mm ≤ machine {lim:g} mm.")
        )


def check_capability(feature_table: dict[str, Any], machine: Machine) -> CapabilityResult:
    reasons: list[Reason] = []
    header = feature_table.get("header", {})
    features = feature_table.get("features", [])
    limits = machine.limits or {}

    if machine.status != MachineState.IN_SERVICE.value:
        reasons.append(
            Reason(
                "state", "fail", f"Machine is {machine.status.replace('_', ' ')}, not in service."
            )
        )

    bar = _num(_value(header.get("bar_diameter")))
    length = _num(_value(header.get("overall_length")))
    diameters = [bar] if bar is not None else []
    for f in features:
        if f.get("type") in ("od", "groove"):
            d = _num(_value(f["fields"].get("diameter")))
            if d is not None:
                diameters.append(d)
    largest = max(diameters) if diameters else None

    _limit_check(reasons, "bar_diameter", bar, limits.get("max_bar_diameter"), "bar diameter")
    _limit_check(
        reasons, "turning_diameter", largest, limits.get("max_turning_diameter"), "largest diameter"
    )
    _limit_check(
        reasons, "turning_length", length, limits.get("max_turning_length"), "overall length"
    )

    tool_types = {t.tool_type for t in machine.tools}
    needed = {f.get("type") for f in features if f.get("type") in FEATURE_TYPES}
    if not machine.tools:
        reasons.append(
            Reason("tools", "unknown", "Unknown – the machine's tool list is not entered.")
        )
    else:
        for ftype in sorted(needed):
            for options in REQUIRED_TOOLS.get(ftype, []):
                label = FEATURE_TYPES[ftype][0]
                names = " or ".join(sorted(TOOL_NAMES[o] for o in options))
                if tool_types & options:
                    reasons.append(
                        Reason(f"tools_{ftype}", "pass", f"{label}: {names} tool present.")
                    )
                else:
                    reasons.append(
                        Reason(
                            f"tools_{ftype}", "fail", f"{label} needs a {names} tool on the turret."
                        )
                    )

    if any(r.status == "fail" for r in reasons):
        verdict: Verdict = "not_capable"
    elif any(r.status == "unknown" for r in reasons):
        verdict = "unknown"
    else:
        verdict = "capable"
    return CapabilityResult(verdict, reasons)


def availability(live_view: dict[str, Any]) -> tuple[bool, list[str]]:
    """Online and idle, from the bridge hub's live view. Returns (available, reasons_if_not)."""
    state = live_view.get("state")
    if state != "online":
        return False, [f"Machine is {str(state).replace('_', ' ')}."]
    status = live_view.get("status") or {}
    out = []
    if status.get("emergency"):
        out.append("Emergency stop is pressed.")
    if status.get("alarm"):
        out.append("Machine has an alarm.")
    if status.get("run_state") != "idle":
        out.append(f"Machine is busy ({status.get('run_state')}).")
    return (not out), out
