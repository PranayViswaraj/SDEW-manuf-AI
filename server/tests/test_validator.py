"""Validator: the 5 trusted programs pass with only expected warnings; bad programs are caught."""

import pytest

from app.gcode.parser import parse_program, part_number_and_title
from app.gcode.validator import MachineContext, validate
from tests.conftest import REPO_DIR

SAMPLES = REPO_DIR / "samples" / "programs"
EMPTY_TOOLS = MachineContext(tool_codes=set())

# The warnings each trusted program is EXPECTED to produce (and nothing else).
EXPECTED_WARNINGS = {
    "O0001": {
        "W_MACHINE_M_CODE",
        "W_MULTIPLE_OPERATIONS",
        "W_M00_STOP",
        "W_CODE_AFTER_M30",
        "W_TOOL_LIST_EMPTY",
        "W_TOOL_CONFLICT",
    },
    "O0002": {
        "W_MULTIPLE_OPERATIONS",
        "W_M99P_START",
        "W_M00_STOP",
        "W_CODE_AFTER_M30",
        "W_TOOL_LIST_EMPTY",
        "W_TOOL_CONFLICT",
    },
    "O0003": {
        "W_MULTIPLE_OPERATIONS",
        "W_M99P_START",
        "W_M00_STOP",
        "W_CODE_AFTER_M30",
        "W_M99P_JUMP",
        "W_TOOL_LIST_EMPTY",
        "W_TOOL_CONFLICT",
    },
    "O0004": {
        "W_MACHINE_M_CODE",
        "W_MULTIPLE_OPERATIONS",
        "W_CODE_AFTER_M30",
        "W_M99P_JUMP",
        "W_TOOL_LIST_EMPTY",
        "W_TOOL_CONFLICT",
    },
    "O0009": {
        "W_MULTIPLE_OPERATIONS",
        "W_M99P_START",
        "W_CODE_AFTER_M30",
        "W_TOOL_LIST_EMPTY",
    },
}


def sample(name: str) -> str:
    return (SAMPLES / name).read_bytes().decode("ascii")


@pytest.mark.parametrize("name", sorted(EXPECTED_WARNINGS))
def test_trusted_samples_have_no_errors_and_only_expected_warnings(name: str) -> None:
    r = validate(sample(name), EMPTY_TOOLS)
    assert r.errors == [], [e.message for e in r.errors]
    assert r.codes("warning") == EXPECTED_WARNINGS[name]
    assert r.codes("info") == {"I_SPINDLE_LIMITS_UNKNOWN"}


def test_sample_headers_parse() -> None:
    prog = parse_program(sample("O0001"))
    assert prog.o_number == 1 and prog.percent_start and prog.percent_end
    assert part_number_and_title(prog.header_comment) == ("3773480M01", "SLEEVE 4WD")
    assert part_number_and_title(parse_program(sample("O0002")).header_comment)[0] == (
        "1816C01001&1527A02301"
    )


def test_tool_conflict_names_both_uses() -> None:
    r = validate(sample("O0001"), EMPTY_TOOLS)
    msg = next(i.message for i in r.warnings if i.code == "W_TOOL_CONFLICT")
    assert "T0404" in msg and "3MM PARTING" in msg and "TNMG 0.4 FIN" in msg


def test_m99p_start_message() -> None:
    r = validate(sample("O0009"), EMPTY_TOOLS)
    msg = next(i.message for i in r.warnings if i.code == "W_M99P_START")
    assert "jumps straight to N2" in msg


def test_tools_checked_when_list_known() -> None:
    tools = {"T0101", "T0202", "T0303", "T0404", "T0606", "T0707"}  # T0808 missing
    r = validate(sample("O0001"), MachineContext(tool_codes=tools))
    assert [e.code for e in r.errors] == ["E_TOOL_UNKNOWN"]
    assert "T0808" in r.errors[0].message
    assert "W_TOOL_LIST_EMPTY" not in r.codes()


def test_spindle_limits_checked_when_known() -> None:
    ctx = MachineContext(tool_codes=set(), spindle_rpm_min=100, spindle_rpm_max=2000)
    r = validate(sample("O0001"), ctx)  # uses S2500
    assert "E_SPINDLE_MAX" in r.codes("error")
    assert "I_SPINDLE_LIMITS_UNKNOWN" not in r.codes()
    ok = validate(sample("O0001"), MachineContext(tool_codes=set(), spindle_rpm_max=4000))
    assert ok.ok


GOOD = "%\nO1234(TEST PART)\nG28U0W0\nG97S1000M4\nT0101\nG0X20.0Z2.0\nG1Z-10.0F0.2\nM30\n%"


@pytest.mark.parametrize(
    ("text", "code"),
    [
        (GOOD.replace("%\nO1234", "O1234"), "E_PERCENT_START"),
        (GOOD[:-2], "E_PERCENT_END"),
        (GOOD.replace("O1234(TEST PART)", "(TEST PART)"), "E_HEADER"),
        (GOOD.replace("T0101", "T0101(TOOL"), "E_PARENS"),
        (GOOD.replace("G1Z", "G13Z"), "E_UNKNOWN_G"),
        (GOOD.replace("M30\n", ""), "E_END"),
        (GOOD.replace("G0X20.0", "G0X20.0 ?"), "E_SYNTAX"),
        (GOOD.replace("G28U0W0", "M99P7"), "E_JUMP_TARGET"),
    ],
)
def test_errors_detected(text: str, code: str) -> None:
    r = validate(text, EMPTY_TOOLS)
    assert code in r.codes("error"), [i.code for i in r.issues]


@pytest.mark.parametrize(
    ("text", "code"),
    [
        (GOOD.replace("G1Z-10.0", "G1Z-10"), "W_NO_DECIMAL"),
        (GOOD.replace("G97S1000M4", "G96S180M4"), "W_G96_NO_CLAMP"),
        (GOOD.replace("O1234(TEST PART)", "O1234"), "W_NO_PART_NUMBER"),
        (GOOD.replace("T0101", "T0101\nM00"), "W_M00_STOP"),
    ],
)
def test_warnings_detected(text: str, code: str) -> None:
    r = validate(text, EMPTY_TOOLS)
    assert code in r.codes("warning"), [i.code for i in r.issues]
    assert r.ok


def test_clean_program_is_clean_with_known_tools() -> None:
    r = validate(GOOD, MachineContext(tool_codes={"T0101"}, spindle_rpm_max=3000))
    assert r.issues == []
