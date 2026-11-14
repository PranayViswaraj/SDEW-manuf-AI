"""Known drawings: values already read from a drawing and written down (no AI at run time).

samples/drawings/known_drawings.json lists drawings whose values were read once and recorded.
When one of them is uploaded (same file fingerprint, or same part number), its values are
offered pre-filled. They are NOT confirmed: an engineer still checks every value against the
drawing, ticks it and confirms the table (safety rule 3).
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class KnownDrawing:
    part_number: str
    title: str
    sha256: tuple[str, ...]
    read_by: str
    header: dict[str, Any]
    features: list[dict[str, Any]]
    not_on_drawing: tuple[str, ...] = ()
    not_in_table: tuple[str, ...] = field(default_factory=tuple)
    aliases: tuple[str, ...] = ()  # other part numbers for the same part (e.g. in a program header)
    not_lathe: str = ""  # set when the drawing is not a lathe part (assembly, plate, ...)
    # The bar size is never on a drawing: estimated from the part's proven program, with the reason.
    bar_estimate: dict[str, Any] | None = None

    def names(self) -> set[str]:
        return {_norm(self.part_number), *(_norm(a) for a in self.aliases)}

    def table_data(self) -> dict[str, Any]:
        """Feature-table data: each recorded value in both "ai" and "value", never confirmed."""

        def cell(v: Any) -> dict[str, Any]:
            return {"ai": v, "value": v, "confirmed": False}

        header = dict(self.header)
        if header.get("bar_diameter") is None and self.bar_estimate:
            header["bar_diameter"] = self.bar_estimate["value"]
        return {
            "header": {k: cell(v) for k, v in header.items()},
            "features": [
                {"type": f["type"], "fields": {k: cell(v) for k, v in f["fields"].items()}}
                for f in self.features
            ],
        }


def _norm(part: str) -> str:
    return "".join(part.split()).upper()


def load_known(path: str | Path) -> list[KnownDrawing]:
    p = Path(path)
    if not p.is_file():
        return []
    raw = json.loads(p.read_text(encoding="utf-8"))
    return [
        KnownDrawing(
            part_number=d["part_number"],
            title=d.get("title", ""),
            sha256=tuple(h.lower() for h in d.get("sha256", [])),
            read_by=d.get("read_by", ""),
            header=d["header"],
            features=d["features"],
            not_on_drawing=tuple(d.get("not_on_drawing", [])),
            not_in_table=tuple(d.get("not_in_table", [])),
            aliases=tuple(d.get("aliases", [])),
            not_lathe=d.get("not_lathe", ""),
            bar_estimate=d.get("bar_estimate"),
        )
        for d in raw.get("drawings", [])
    ]


def find_known(
    known: list[KnownDrawing], *, sha256: str | None = None, part_number: str | None = None
) -> KnownDrawing | None:
    """Match by exact file fingerprint first, then by part number."""
    if sha256:
        for k in known:
            if sha256.lower() in k.sha256:
                return k
    if part_number:
        for k in known:
            if _norm(part_number) in k.names():
                return k
    return None
