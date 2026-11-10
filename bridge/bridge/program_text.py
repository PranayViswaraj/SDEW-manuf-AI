"""FANUC program text handling shared by all drivers.

FANUC exports use '%' start/end markers and often odd line endings (the trusted samples use
'\\n\\r\\r'). We send LF-only text and compare programs in a canonical form.
"""

import hashlib
import re

from bridge.drivers.base import ProgramFormatError, parse_o_number

_O_HEADER = re.compile(r"^\s*O(\d{1,4})(?=\D|$)", re.IGNORECASE)


def strip_cr(text: str) -> str:
    """Remove every carriage return (handles \\r\\n, \\n\\r\\r and lone \\r)."""
    return text.replace("\r", "")


def program_lines(text: str) -> list[str]:
    """Program body lines without '%' markers, trailing spaces or blank lines."""
    lines = [ln.rstrip() for ln in strip_cr(text).split("\n")]
    return [ln for ln in lines if ln.strip() and ln.strip() != "%"]


def program_number_from_text(text: str) -> int:
    lines = program_lines(text)
    if not lines:
        raise ProgramFormatError("The program is empty.")
    m = _O_HEADER.match(lines[0])
    if m is None:
        raise ProgramFormatError(
            "The first line must be the program number, for example O0001(PART NAME)."
        )
    return parse_o_number(int(m.group(1)))


def to_send_format(text: str) -> str:
    """LF line endings, '%' first and last, as FANUC expects for download."""
    lines = program_lines(text)
    program_number_from_text(text)  # validates header
    return "%\n" + "\n".join(lines) + "\n%"


def from_received(raw: str) -> str:
    """Normalise text read back from the CNC: drop \\r, keep '%' markers, LF endings."""
    return to_send_format(raw)


def canonical(text: str) -> str:
    """Form used to compare a sent program with the read-back copy."""
    return "\n".join(program_lines(text))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_hash(text: str) -> str:
    return sha256_text(canonical(text))


def program_comment(text: str) -> str:
    first = program_lines(text)[0] if program_lines(text) else ""
    m = re.search(r"\(([^)]*)\)", first)
    return m.group(1).strip() if m else ""
