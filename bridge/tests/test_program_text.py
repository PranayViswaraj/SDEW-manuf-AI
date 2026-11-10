from pathlib import Path

import pytest

from bridge.drivers.base import ProgramFormatError, format_o_number, parse_o_number
from bridge.program_text import (
    canonical,
    canonical_hash,
    from_received,
    program_comment,
    program_number_from_text,
    to_send_format,
)

SAMPLES = Path(__file__).resolve().parents[2] / "samples" / "programs"


@pytest.mark.parametrize("name", ["O0001", "O0002", "O0003", "O0004", "O0009"])
def test_trusted_samples_normalise(name: str) -> None:
    raw = (SAMPLES / name).read_bytes().decode("ascii")
    assert "\r" in raw  # the samples really do contain CRs
    sent = to_send_format(raw)
    assert "\r" not in sent
    assert sent.startswith("%\n") and sent.endswith("\n%")
    assert program_number_from_text(raw) == parse_o_number(name)
    # A CNC echo with CRLF line endings compares equal.
    assert canonical(from_received(sent.replace("\n", "\r\n"))) == canonical(raw)
    assert canonical_hash(sent) == canonical_hash(raw)


def test_comment_and_number_helpers() -> None:
    assert program_comment("%\nO0001(3773480M01 SLEEVE 4WD) \nG0X0\n%") == "3773480M01 SLEEVE 4WD"
    assert parse_o_number("o12") == 12 and format_o_number(12) == "O0012"
    for bad in ("O0", "O10000", "P0001", "Oabc"):
        with pytest.raises(ProgramFormatError):
            parse_o_number(bad)


@pytest.mark.parametrize("text", ["", "%\n%", "%\nG0X0\nM30\n%", "%\n(NO NUMBER)\n%"])
def test_missing_header_rejected(text: str) -> None:
    with pytest.raises(ProgramFormatError):
        program_number_from_text(text)


def test_canonical_detects_real_changes() -> None:
    a = "%\nO0001\nG0X10.0\nM30\n%"
    assert canonical_hash(a) != canonical_hash(a.replace("X10.0", "X1.0"))
    assert canonical_hash(a) == canonical_hash(a.replace("\n", "\r\n") + "\n\n")
