"""Two-agent AI drawing reader (Claude).

Agent 1 (Extractor) reads the drawing as an image into the feature table. Agent 2 (Verifier)
checks every value against the drawing and corrects it; if it found mistakes, or the two readers'
callout inventories do not agree, it looks once more (at most two verification rounds).

Precision: every page goes as the PDF plus a whole-sheet image and zoomed tiles at the model's
full resolution (drawing_images), so small tolerances are read, not guessed.
Completeness: both agents list every callout on the drawing (with inspection balloon numbers)
and where it went in the table. Code compares the two inventories, the balloon numbers 1..N and
the numbers in the PDF's text layer; anything not accounted for is sent back for a second look,
and whatever is still open is listed for the engineer to check on the drawing.

Only values the last Verifier round accepted or corrected become suggestions ("ai" cells).
"value"/"confirmed" are never set: an engineer ticks every value (safety rule 3).

Off unless MANUFAI_AI_READER=claude and an Anthropic credential (ANTHROPIC_API_KEY) is set.
"""

import base64
import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from app.ai.drawing_images import DrawingImages, render
from app.ai.drawing_reader import DrawingReader, DrawingReaderError, Progress, ReaderResult
from app.ai.prompts import (
    EXTRACTION_SCHEMA,
    VERIFICATION_SCHEMA,
    VERIFIER_SYSTEM,
    extractor_system,
)
from app.services.feature_tables import FEATURE_TYPES, HEADER_FIELDS, Kind, TableData

log = logging.getLogger(__name__)

MAX_VERIFY_ROUNDS = 2
LOW_CONFIDENCE = 0.7
FALLBACK_BETA = "server-side-fallback-2026-07-01"
_KEEP = {"ok", "wrong"}  # the verifier accepted the value, or supplied the correction
_PATH = re.compile(r"^(?:header\.(\w+)|features\[(\d+)\]\.fields\.(\w+))$")


def media_type(content: bytes) -> str | None:
    if content.startswith(b"%PDF-"):
        return "application/pdf"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return None


def drawing_block(content: bytes) -> dict[str, Any]:
    """The drawing as a document (PDF pages are read as images) or an image block."""
    mtype = media_type(content)
    if mtype is None:
        raise DrawingReaderError("The drawing must be a PDF or an image (PNG, JPG or WEBP).")
    data = base64.standard_b64encode(content).decode("ascii")
    kind = "document" if mtype == "application/pdf" else "image"
    return {"type": kind, "source": {"type": "base64", "media_type": mtype, "data": data}}


class ClaudeDrawingReader(DrawingReader):
    def __init__(
        self,
        model: str,
        effort: str = "high",
        client: Any = None,
        tiles: bool = True,
        api_key: str | None = None,
    ) -> None:
        self.model = model
        self.effort = effort
        self.tiles = tiles
        if client is None:
            import anthropic  # optional dependency: pip install "manufai-server[ai]"

            # the key from the settings (.env), else the SDK's own lookup (environment)
            client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()
        self.client = client

    # ------------------------------------------------------------------ calls

    def _ask(
        self, system: str, content: list[dict[str, Any]], schema: dict[str, Any]
    ) -> dict[str, Any]:
        with self.client.beta.messages.stream(
            model=self.model,
            max_tokens=64000,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            thinking={"type": "adaptive"},
            output_config={
                "effort": self.effort,
                "format": {"type": "json_schema", "schema": schema},
            },
            system=system,
            messages=[{"role": "user", "content": content}],
        ) as stream:
            msg = stream.get_final_message()
        if msg.stop_reason == "refusal":
            raise DrawingReaderError(
                "The AI declined to read this drawing. Enter the values by hand."
            )
        if msg.stop_reason == "max_tokens":
            raise DrawingReaderError("The AI answer was cut off. Enter the values by hand.")
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            answer = json.loads(text)
        except json.JSONDecodeError as e:
            raise DrawingReaderError("The AI answer was not valid JSON.") from e
        if not isinstance(answer, dict):
            raise DrawingReaderError("The AI answer was not a JSON object.")
        return answer

    def extract(self, drawing: list[dict[str, Any]], part_number: str) -> dict[str, Any]:
        hint = f"Part number typed by the user: {part_number}." if part_number else ""
        return self._ask(
            extractor_system(),
            [
                *drawing,
                {"type": "text", "text": f"Read this drawing into the feature table. {hint}"},
            ],
            EXTRACTION_SCHEMA,
        )

    def verify(
        self, drawing: list[dict[str, Any]], claim: dict[str, Any], gaps: str = ""
    ) -> dict[str, Any]:
        text = "The first reader's JSON for the attached drawing (a claim to test):\n" + json.dumps(
            claim, ensure_ascii=False
        )
        if gaps:
            text += "\n\n" + gaps
        return self._ask(
            VERIFIER_SYSTEM, [*drawing, {"type": "text", "text": text}], VERIFICATION_SCHEMA
        )

    # ------------------------------------------------------------------ pipeline

    def read_report(
        self,
        file: bytes,
        filename: str = "",
        part_number: str = "",
        progress: Progress | None = None,
    ) -> ReaderResult:
        images = render(file) if self.tiles else DrawingImages()
        drawing = [drawing_block(file), *images.blocks]
        say = progress or (lambda stage, n: None)
        try:
            say("extract", 0)  # agent 1: features, 3D shape analysis, feature list, callouts
            first = self.extract(drawing, part_number)
            say("verify", 1)  # agent 2: checks every value, makes its own callout inventory
            gaps = completeness(first, None, images.text_numbers)
            rounds = [self.verify(drawing, first, gaps.message(first_round=True))]
            gaps = completeness(first, rounds[-1], images.text_numbers)
            if any(c["verdict"] == "wrong" for c in rounds[-1]["checks"]) or gaps.any():
                say("verify", 2)  # corrected something or left gaps: one more independent look
                rounds.append(
                    self.verify(drawing, rounds[-1]["corrected"], gaps.message(first_round=False))
                )
                gaps = completeness(first, rounds[-1], images.text_numbers)
        except DrawingReaderError:
            raise
        except Exception as e:  # network, auth, rate limit: the engineer enters values by hand
            log.warning("AI drawing reader failed: %s", e)
            raise DrawingReaderError(
                f"The AI drawing reader is not available ({type(e).__name__})."
            ) from e
        last = rounds[-1]
        table, notes = reconcile(last["corrected"], last["checks"])
        final = last.get("corrected") or first
        shape = (final.get("drawing") or {}).get("shape_3d") or (first.get("drawing") or {}).get(
            "shape_3d"
        )
        checks = last.get("checks", [])
        notes |= {
            "model": self.model,
            "verdict": last["verdict"],
            "verify_rounds": len(rounds),
            "shape_3d": shape,
            "feature_list": final.get("feature_list") or first.get("feature_list") or [],
            "check_counts": {
                v: sum(1 for c in checks if c.get("verdict") == v)
                for v in ("ok", "wrong", "unsupported", "unclear")
            },
            "callouts": len(last.get("callouts") or []),
            "balloons": gaps.highest_balloon,
            "unaccounted": gaps.for_engineer(),
            "questions": _unique(
                first.get("questions_for_engineer", [])
                + last["corrected"].get("questions_for_engineer", [])
                + last.get("questions_for_engineer", [])
            ),
        }
        audit = {
            "drawing_sha256": hashlib.sha256(file).hexdigest(),
            "filename": filename,
            "extractor": first,
            "verifier": rounds,
            "images_sent": images.described,
            "text_layer_numbers": images.text_numbers,
        }
        return ReaderResult(table=table, notes=notes, audit=audit)

    def read(self, file: bytes, filename: str = "") -> TableData:
        return self.read_report(file, filename).table


# ---------------------------------------------------------------------- completeness

_NUM = re.compile(r"\d+(?:[.,]\d+)?")
_OPEN = re.compile(r"^\s*(|none|missed|not accounted.*|unaccounted.*|\?)\s*$", re.I)


def _zero_led(tok: str) -> bool:
    """011, 056: form and address numbers, not sizes."""
    return len(tok) > 1 and tok[0] == "0" and tok[1] != "."


def _nums(text: str) -> set[float]:
    out: set[float] = set()
    for m in _NUM.finditer(text or ""):
        tok = m.group(0).replace(",", ".")
        if not _zero_led(tok):
            out.add(round(float(tok), 4))
    return out


@dataclass
class Gaps:
    """What the readers have not accounted for yet."""

    unaccounted: list[str] = field(default_factory=list)  # callouts with no place in the table
    missing_balloons: list[int] = field(default_factory=list)
    first_only: list[str] = field(default_factory=list)  # callouts the checker lost
    text_only: list[str] = field(default_factory=list)  # text-layer numbers nobody accounted for
    highest_balloon: int | None = None

    def any(self) -> bool:
        return bool(self.unaccounted or self.missing_balloons or self.first_only or self.text_only)

    def message(self, *, first_round: bool) -> str:
        lines: list[str] = []
        if self.unaccounted:
            lines.append("Callouts not accounted for in the table: " + "; ".join(self.unaccounted))
        if self.missing_balloons:
            lines.append(
                "Inspection balloon numbers not found yet: "
                + ", ".join(str(b) for b in self.missing_balloons)
            )
        if self.first_only:
            lines.append(
                "Callouts the first reader listed that your answer does not contain: "
                + "; ".join(self.first_only)
            )
        if self.text_only:
            lines.append(
                ("Numbers in the PDF text layer" if first_round else "Text-layer numbers still")
                + " not accounted for by any reader (the text layer is unreliable, but each "
                "number IS printed on the sheet): " + ", ".join(self.text_only)
            )
        if not lines:
            return ""
        head = "COMPLETENESS CHECK by the program. Account for EACH item below on the drawing."
        return head + "\n- " + "\n- ".join(lines)

    def for_engineer(self) -> list[str]:
        out = [f"Callout not placed in the table: {u}" for u in self.unaccounted]
        out += [f"Balloon {b} not found on the drawing by the AI" for b in self.missing_balloons]
        out += [f"Seen by the first reader only: {x}" for x in self.first_only]
        out += [f"Number printed on the drawing, not accounted for: {x}" for x in self.text_only]
        return out[:40]


def _balloons(answer: dict[str, Any]) -> set[int]:
    return {
        int(c["balloon"])
        for c in answer.get("callouts") or []
        if isinstance(c.get("balloon"), int) and 0 < c["balloon"] < 500
    }


def completeness(
    first: dict[str, Any], check: dict[str, Any] | None, text_numbers: list[str]
) -> Gaps:
    """Compare the inventories: the latest answer (the checker's, else the first reader's)
    against the balloon numbers 1..N, the first reader's callouts and the PDF text layer."""
    latest = check or first
    g = Gaps()
    for c in latest.get("callouts") or []:
        if _OPEN.match(str(c.get("accounted_for", ""))):
            g.unaccounted.append(str(c.get("text", "")).strip() or "(blank)")
    every = _balloons(first) | _balloons(latest)
    if every:
        g.highest_balloon = max(every)
        found = _balloons(latest)
        g.missing_balloons = [b for b in range(1, g.highest_balloon + 1) if b not in found]
    have = _nums(json.dumps(latest, ensure_ascii=False))
    if check is not None:
        # inventory against inventory: each first-reader callout must be in the checker's list
        listed = [_nums(str(c.get("text", ""))) for c in check.get("callouts") or []]
        for c in first.get("callouts") or []:
            text = str(c.get("text", "")).strip()
            nums = _nums(text)
            if nums and not any(nums <= other for other in listed):
                g.first_only.append(text)
    for tok in text_numbers:
        if _zero_led(tok):
            continue
        v = round(float(tok), 4)
        if v not in have:
            g.text_only.append(f"{v:g}")
    return g


# ---------------------------------------------------------------------- reconciliation


def _unique(items: list[str]) -> list[str]:
    seen: list[str] = []
    for x in items:
        if x and x not in seen:
            seen.append(x)
    return seen


def _cell_value(kind: Kind, v: Any) -> float | str | None:
    """A value the feature table accepts for this kind, or None (dropped, never forced)."""
    if v is None or v == "":
        return None
    if kind == "text":
        return str(v).strip()[:64] or None
    if isinstance(v, str):
        try:
            v = float(v.strip().replace("Ø", "").replace("°", ""))
        except ValueError:
            return None
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    if kind in ("mm", "deg") and v < 0:
        return None
    if kind == "deg" and v > 180:
        return None
    return float(v)


def reconcile(
    table: dict[str, Any], checks: list[dict[str, Any]]
) -> tuple[TableData, dict[str, Any]]:
    """Keep only values the last verifier round marked ok or corrected; map to the table."""
    verdicts: dict[tuple[str, int, str], dict[str, Any]] = {}
    for c in checks:
        m = _PATH.match(c.get("path", "").strip())
        if m:
            vkey = ("h", -1, m.group(1)) if m.group(1) else ("f", int(m.group(2)), m.group(3))
            verdicts[vkey] = c

    drawing = table.get("drawing", {})
    notes: dict[str, Any] = {
        "classification": drawing.get("classification"),
        "not_lathe": drawing.get("not_lathe") or "",
        "drawing_number": drawing.get("number"),
        "issue": drawing.get("issue"),
        "title": drawing.get("title"),
        "not_in_table": list(table.get("not_in_table", [])),
        "general_tolerances": list(table.get("general_tolerances", [])),
        "evidence": {},
        "low_confidence": [],
        "dropped": [],
    }
    if drawing.get("classification") != "turned part" and not notes["not_lathe"]:
        notes["not_lathe"] = f"The drawing looks like: {drawing.get('classification')}."

    def take(key: tuple[str, int, str], label: str, kind: Kind, val: dict[str, Any]) -> Any:
        v = _cell_value(kind, val.get("v"))
        if v is None:
            return None
        check = verdicts.get(key)
        if check is None or check.get("verdict") not in _KEEP:
            why = check.get("verdict") if check else "not checked"
            notes["dropped"].append(f"{label}: {val.get('v')} ({why})")
            return None
        notes["evidence"][label] = val.get("evidence", "")
        if float(val.get("confidence") or 0) < LOW_CONFIDENCE:
            notes["low_confidence"].append(label)
        return v

    header: dict[str, Any] = {}
    for key, label, kind in HEADER_FIELDS:
        val = table.get("header", {}).get(key) or {}
        header[key] = {
            "ai": take(("h", -1, key), label, kind, val),
            "value": None,
            "confirmed": False,
        }

    features: list[dict[str, Any]] = []
    if not notes["not_lathe"]:
        for i, f in enumerate(table.get("features", [])):
            ftype = f.get("type")
            if ftype not in FEATURE_TYPES:
                continue
            flabel, fdefs = FEATURE_TYPES[ftype]
            given = {x.get("name"): x for x in f.get("fields", [])}
            cells = {}
            for key, label, kind in fdefs:
                where = f"Feature {len(features) + 1} ({flabel}) {label}"
                ai = take(("f", i, key), where, kind, given.get(key) or {})
                cells[key] = {"ai": ai, "value": None, "confirmed": False}
            features.append({"type": ftype, "fields": cells})

    return TableData.model_validate({"header": header, "features": features[:200]}), notes
