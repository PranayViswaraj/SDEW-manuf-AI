"""The company's proven programs as supplied (samples/programs), NOT tied to a machine.

The programs were proven on the company's machines, but which program belongs to which machine
is not recorded. So they are a library: they can be matched to a drawing by part number and
copied to a chosen machine as a DRAFT, which a programmer must approve for that machine.
"""

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from app.services.program_store import read_header

_NAME = re.compile(r"^O\d{4}$")


@dataclass(frozen=True)
class LibraryProgram:
    name: str  # "O0001"
    program_number: int
    part_numbers: tuple[str, ...]
    title: str
    sha256: str
    text: str


def _parts(header_part: str) -> tuple[str, ...]:
    return tuple(p.strip().upper() for p in header_part.split("&") if p.strip())


def load_library(folder: str | Path) -> list[LibraryProgram]:
    out: list[LibraryProgram] = []
    path = Path(folder)
    if not path.is_dir():
        return out
    for f in sorted(path.iterdir()):
        if not f.is_file() or not _NAME.match(f.name):
            continue
        raw = f.read_bytes()
        text = raw.decode("ascii")
        h = read_header(text)
        out.append(
            LibraryProgram(
                name=f.name,
                program_number=h.program_number,
                part_numbers=_parts(h.part_number),
                title=h.title,
                sha256=hashlib.sha256(raw).hexdigest(),
                text=text,
            )
        )
    return out


def normalise_part(part: str) -> str:
    return re.sub(r"\s+", "", part).upper()


def match_part(library: list[LibraryProgram], part_number: str) -> list[LibraryProgram]:
    """Library programs whose header names this exact part number."""
    key = normalise_part(part_number)
    return [p for p in library if any(normalise_part(x) == key for x in p.part_numbers)]
