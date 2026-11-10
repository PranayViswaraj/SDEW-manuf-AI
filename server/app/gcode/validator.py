"""Fixed-rule validator for FANUC 0i-TF lathe programs (no AI).

errors   -> block approval and sending
warnings -> shown to the programmer, must be read before approving
info     -> context (e.g. checks skipped because machine data is not entered yet)
"""

import re
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from app.gcode.parser import Block, ParsedProgram, parse_program

Severity = Literal["error", "warning", "info"]

# G codes of the 0i-TF lathe (G code system A). Values compared as floats ("G01" == G1).
KNOWN_G: frozenset[float] = frozenset(
    [0, 1, 2, 3, 4, 7.1, 10, 11, 12.1, 13.1, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30]
    + [31, 32, 34, 36, 37, 40, 41, 42, 50, 50.3, 52, 53, 54, 55, 56, 57, 58, 59, 65, 66, 67]
    + [68, 69, 70, 71, 72, 73, 74, 75, 76, 80, 83, 84, 85, 87, 88, 89, 90, 92, 94, 96, 97, 98, 99]
)
# Standard FANUC M codes. Everything else is machine-builder specific.
# TODO(REAL-DATA): LMW machine-specific M code list (e.g. M10/M11 chuck) from the machine manual.
STANDARD_M: dict[int, str] = {
    0: "program stop",
    1: "optional stop",
    2: "end of program",
    3: "spindle forward",
    4: "spindle reverse",
    5: "spindle stop",
    8: "coolant on",
    9: "coolant off",
    30: "end of program and rewind",
    98: "call sub-program",
    99: "end of sub-program / jump",
}
_OP_PATTERN = re.compile(
    r"\b(1ST|2ND|3RD|[4-9]TH)\s*(OPN|OPR|OP|SIDE|OPERATION|SETUP)\b", re.IGNORECASE
)
_TOOL_COMMENT = re.compile(r"\(([^)]*)\)")


@dataclass
class Issue:
    code: str
    severity: Severity
    message: str
    line: int | None = None


@dataclass
class ValidationResult:
    issues: list[Issue] = field(default_factory=list)

    def add(self, code: str, severity: Severity, message: str, line: int | None = None) -> None:
        self.issues.append(Issue(code, severity, message, line))

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "warning"]

    @property
    def infos(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "info"]

    @property
    def ok(self) -> bool:
        return not self.errors

    def codes(self, severity: Severity | None = None) -> set[str]:
        return {i.code for i in self.issues if severity is None or i.severity == severity}

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "errors": [asdict(i) for i in self.errors],
            "warnings": [asdict(i) for i in self.warnings],
            "infos": [asdict(i) for i in self.infos],
        }


@dataclass
class MachineContext:
    """What the validator knows about the target machine. None = not entered yet."""

    tool_codes: set[str] | None = None  # e.g. {"T0101", "T0202"}; empty set = list is empty
    spindle_rpm_min: int | None = None
    spindle_rpm_max: int | None = None


def _fmt_g(v: float) -> str:
    return f"G{int(v):02d}" if float(v).is_integer() else f"G{v:g}"


def _tool_code(block: Block) -> str | None:
    w = block.get("T")
    if w is None:
        return None
    digits = w.text.lstrip("+").split(".")[0]
    return f"T{int(digits):04d}" if digits.isdigit() else None


def validate(text: str, machine: MachineContext | None = None) -> ValidationResult:
    m = machine or MachineContext()
    res = ValidationResult()
    prog = parse_program(text)
    _check_structure(prog, res)
    _check_words(prog, res)
    _check_flow(prog, res)
    _check_tools(prog, m, res)
    _check_spindle(prog, m, res)
    return res


# ---------------------------------------------------------------- structure


def _check_structure(prog: ParsedProgram, res: ValidationResult) -> None:
    if not prog.percent_start:
        res.add("E_PERCENT_START", "error", "Program must start with a '%' line.", 1)
    if not prog.percent_end:
        res.add("E_PERCENT_END", "error", "Program must end with a '%' line.", len(prog.lines))
    if prog.o_number is None:
        line = prog.blocks[0].line_no if prog.blocks else 1
        res.add(
            "E_HEADER",
            "error",
            "First line after '%' must be the program number, e.g. O0001(PART NAME).",
            line,
        )
    elif not prog.header_comment:
        res.add(
            "W_NO_PART_NUMBER",
            "warning",
            "Header has no comment with the part number, e.g. O0001(3773480M01 SLEEVE).",
            prog.blocks[0].line_no,
        )
    for ln in prog.paren_errors:
        res.add("E_PARENS", "error", "Unbalanced or nested brackets in a comment.", ln)
    executable = [b for b in prog.body if b.words]
    if not executable:
        res.add("E_EMPTY", "error", "The program has no blocks to run.")
        return
    last = executable[-1]
    if not ({30, 2, 99} & set(last.m_codes())):
        res.add(
            "E_END",
            "error",
            "Program must end with M30 (or M99). The last block is: " + last.raw.strip(),
            last.line_no,
        )


# ---------------------------------------------------------------- words


def _check_words(prog: ParsedProgram, res: ValidationResult) -> None:
    unknown_m_seen: set[int] = set()
    for b in prog.body:
        if b.junk:
            res.add("E_SYNTAX", "error", f"Cannot read '{b.junk}' in this block.", b.line_no)
        for g in b.g_codes():
            if g not in KNOWN_G:
                res.add(
                    "E_UNKNOWN_G",
                    "error",
                    f"{_fmt_g(g)} is not a known FANUC 0i-TF lathe G code.",
                    b.line_no,
                )
        for mc in b.m_codes():
            if mc not in STANDARD_M and mc not in unknown_m_seen:
                unknown_m_seen.add(mc)
                res.add(
                    "W_MACHINE_M_CODE",
                    "warning",
                    f"M{mc:02d} is a machine-specific M code (not standard FANUC). "
                    "Check what it does on this machine.",
                    b.line_no,
                )
        gs = set(b.g_codes())
        cycle_block = bool(gs & {70, 71, 72, 73, 74, 75, 76, 83, 84, 85, 87, 88, 89})
        for w in b.words:
            if w.letter in ("X", "Z", "U", "W", "I", "K") and not w.has_decimal and w.value != 0:
                if cycle_block and w.letter in ("U", "W"):
                    continue
                res.add(
                    "W_NO_DECIMAL",
                    "warning",
                    f"{w.letter}{w.text} has no decimal point. Depending on parameter 3401 the "
                    f"control may read it as {w.value / 1000:g} mm instead of {w.value:g} mm.",
                    b.line_no,
                )


# ---------------------------------------------------------------- flow


def _check_flow(prog: ParsedProgram, res: ValidationResult) -> None:
    body = prog.body
    seqs = {b.seq for b in body if b.seq is not None}
    first_exec = next((b for b in body if b.words), None)

    # operations
    ops: list[tuple[str, int]] = []
    for b in body:
        for c in b.comments:
            m = _OP_PATTERN.search(c)
            if m:
                ops.append((c.strip(), b.line_no))
    first_unlabelled = bool(ops) and not any(o[0].upper().startswith("1") for o in ops)
    count = len(ops) + (1 if first_unlabelled else 0)
    if count >= 2:
        names = ", ".join(f"'{o[0]}' (line {o[1]})" for o in ops)
        if first_unlabelled:
            names = "1st operation (no label), " + names
        res.add(
            "W_MULTIPLE_OPERATIONS",
            "warning",
            f"Program has {count} operations: {names}. The part is re-clamped between them; "
            "the operator must know which operation is being run.",
            ops[0][1],
        )

    m30_seen_at: int | None = None
    for b in body:
        mcs = b.m_codes()
        if 0 in mcs:
            res.add(
                "W_M00_STOP",
                "warning",
                "M00 program stop: the machine stops here until Cycle Start is pressed again.",
                b.line_no,
            )
        if 99 in mcs and b.get("P") is not None:
            target = int(b.num("P") or 0)
            if target not in seqs:
                res.add(
                    "E_JUMP_TARGET",
                    "error",
                    f"M99 P{target} jumps to N{target}, but there is no N{target} block.",
                    b.line_no,
                )
            elif b is first_exec:
                res.add(
                    "W_M99P_START",
                    "warning",
                    f"Program starts with M99 P{target}: it jumps straight to N{target} and "
                    "skips everything before it. Check which operation will run.",
                    b.line_no,
                )
            else:
                res.add(
                    "W_M99P_JUMP",
                    "warning",
                    f"M99 P{target} jumps back/forward to N{target}; blocks in between are "
                    "skipped and the program may repeat until reset.",
                    b.line_no,
                )
        if m30_seen_at is not None and b.words and not (30 in mcs or 2 in mcs):
            res.add(
                "W_CODE_AFTER_M30",
                "warning",
                f"Blocks after M30 (line {m30_seen_at}) only run when reached by an M99 P jump "
                "or a sequence search.",
                b.line_no,
            )
            m30_seen_at = None  # report once per M30
        if 30 in mcs or 2 in mcs:
            m30_seen_at = b.line_no


# ---------------------------------------------------------------- tools


def _check_tools(prog: ParsedProgram, m: MachineContext, res: ValidationResult) -> None:
    used: dict[str, list[tuple[int, str]]] = {}
    last_label = ""
    for b in prog.body:
        # A comment on an N block usually names the next tool, e.g. N2(WNMG 0.8 RG).
        if b.seq is not None and b.comments:
            last_label = b.comments[0]
        code = _tool_code(b)
        if code is None:
            continue
        if code[3:] == "00":
            continue  # T0100 style: offset cancel
        label = b.comments[0] if b.comments else last_label
        used.setdefault(code, []).append((b.line_no, label))

    if not used:
        return
    if m.tool_codes is None or len(m.tool_codes) == 0:
        res.add(
            "W_TOOL_LIST_EMPTY",
            "warning",
            "The machine tool list is empty, so tool calls were not checked: "
            + ", ".join(sorted(used))
            + ". Enter the turret layout on the Machines page.",
        )
    else:
        for code, uses in sorted(used.items()):
            if code not in m.tool_codes:
                res.add(
                    "E_TOOL_UNKNOWN",
                    "error",
                    f"{code} is not in this machine's tool list.",
                    uses[0][0],
                )
    for code, uses in sorted(used.items()):
        labels = {lbl.strip().upper() for _, lbl in uses if lbl.strip()}
        if len(labels) > 1:
            listing = "; ".join(f"line {ln}: {lbl}" for ln, lbl in uses if lbl.strip())
            res.add(
                "W_TOOL_CONFLICT",
                "warning",
                f"{code} is used for different tools ({listing}). Check the turret setup for "
                "each operation.",
                uses[0][0],
            )


# ---------------------------------------------------------------- spindle


def _check_spindle(prog: ParsedProgram, m: MachineContext, res: ValidationResult) -> None:
    css = False  # G96 constant surface speed active
    clamp: float | None = None
    have_limits = m.spindle_rpm_max is not None or m.spindle_rpm_min is not None
    any_s = False
    for b in prog.body:
        gs = set(b.g_codes())
        s = b.num("S")
        if 50 in gs and s is not None:
            clamp = s
            if m.spindle_rpm_max is not None and s > m.spindle_rpm_max:
                res.add(
                    "E_SPINDLE_CLAMP",
                    "error",
                    f"G50 S{s:g} clamp is above the machine maximum ({m.spindle_rpm_max} rpm).",
                    b.line_no,
                )
            continue
        if 96 in gs:
            css = True
            if clamp is None:
                res.add(
                    "W_G96_NO_CLAMP",
                    "warning",
                    "G96 constant surface speed without a G50 S speed clamp before it. At small "
                    "diameters the spindle can over-speed.",
                    b.line_no,
                )
        if 97 in gs:
            css = False
        if s is None or css:
            continue
        any_s = True
        if m.spindle_rpm_max is not None and s > m.spindle_rpm_max:
            res.add(
                "E_SPINDLE_MAX",
                "error",
                f"S{s:g} rpm is above the machine maximum ({m.spindle_rpm_max} rpm).",
                b.line_no,
            )
        if m.spindle_rpm_min is not None and 0 < s < m.spindle_rpm_min:
            res.add(
                "W_SPINDLE_MIN",
                "warning",
                f"S{s:g} rpm is below the machine minimum ({m.spindle_rpm_min} rpm).",
                b.line_no,
            )
    if any_s and not have_limits:
        res.add(
            "I_SPINDLE_LIMITS_UNKNOWN",
            "info",
            "Spindle speed limits are not entered for this machine, so speeds were not checked.",
        )
