"""Cutting data read from the company's PROVEN programs (fixed rules, no AI, nothing invented).

Every value returned here was typed by the company's programmers into a program that is approved
and proven on the machine. Each suggestion carries its source (program and line) so a programmer
can check it before using it in a generated program.

The turret is set up differently for every part (T0101 is a U-drill in O0001 but a stopper in
O0002), so values are grouped by the KIND of tool named in the block comment, e.g.
N2(WNMG 0.8 RG) is an OD roughing tool, never by T-code.
"""

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

_N_COMMENT = re.compile(r"^N\d+\s*\((.*?)\)")
_N_ALONE = re.compile(r"^N\d+\s*$")  # a tool block with no comment, e.g. O0009 "N4"
_OP_COMMENT = re.compile(r"^\((.*?)\)\s*$")
_T = re.compile(r"T(\d{4})")
_S97 = re.compile(r"G97\s*S(\d+)")
_F = re.compile(r"F(-?\d*\.?\d+)")
_WORD = re.compile(r"([A-Z])(-?\d*\.?\d+)")
_WIDTH = re.compile(r"(\d+(?:\.\d+)?)\s*MM")
_NOSE = re.compile(r"[A-Z]{4}\s*-?\s*(\d\.\d)")


def _kind(comment: str, body: str) -> str | None:
    """Tool kind from the block comment (and whether the block runs a roughing cycle)."""
    c = comment.upper()
    if "PART" in c:
        return "parting"
    if "GROOV" in c:
        return "groove"
    if "THREAD" in c or "THRD" in c:
        return "thread"
    if "DRILL" in c or re.search(r"\bU\s?D\b", c):
        return "drill"
    if "BORE" in c or "BOREING" in c or re.search(r"\bBB\b", c):  # "12.0MM BB" = boring bar
        return "bore"
    if "STOP" in c:
        return "stopper"
    if "CSK" in c:
        return None
    # A plain facing block (even one using G72, as O0003_3227C07701 N2) is not OD roughing: its
    # step is a facing allowance, not a turning depth of cut.
    if "FAC" in c and not re.search(r"\bRG\b|ROUGH", c):
        return None
    if re.search(r"G7[12]", body) or re.search(r"\bRG\b|ROUGH", c):
        return "od_rough"
    if "FIN" in c or "TNMG" in c:
        return "od_finish"
    return None


@dataclass
class ToolBlock:
    program: str  # "O0001"
    program_id: int | None
    comment: str
    kind: str | None
    tool_code: str | None
    lines: list[tuple[int, str]] = field(default_factory=list)  # (1-based line no, text)
    op: int = 1  # 1 = first clamping, 2 = after "(2ND OPN)"

    def where(self, line: int) -> str:
        return f"{self.program} line {line} ({self.comment})"


def split_blocks(program: str, text: str, program_id: int | None = None) -> list[ToolBlock]:
    """Split a program into tool blocks at each N-block comment such as N2(WNMG 0.8 RG)."""
    blocks: list[ToolBlock] = []
    cur: ToolBlock | None = None
    op = 1
    for no, raw in enumerate(text.replace("\r", "").split("\n"), start=1):
        line = raw.strip().upper()
        m = _N_COMMENT.match(line)
        if m or _N_ALONE.match(line):
            comment = m.group(1).strip() if m else ""
            cur = ToolBlock(program, program_id, comment, None, None, op=op)
            blocks.append(cur)
        elif _OP_COMMENT.match(line):
            if re.search(r"2ND|SECOND", line):
                op = 2
            cur = None  # "(2ND OPN)" ends the previous tool block
            continue
        if cur is None or not line:
            continue  # blank lines (some exports have them between blocks) carry nothing
        cur.lines.append((no, line))
        if cur.tool_code is None and (t := _T.search(line)) and not t.group(1).endswith("00"):
            cur.tool_code = "T" + t.group(1)
    drilled: float | None = None
    for b in blocks:
        b.kind = _kind(b.comment, "\n".join(t for _, t in b.lines))
        if b.kind == "drill" and (m := re.match(r"\s*(\d+(?:\.\d+)?)", b.comment)):
            drilled = float(m.group(1))
        elif b.kind is None and not b.comment and drilled is not None and _bores_in(b, drilled):
            b.kind = "bore"  # e.g. O0009 N4: no comment, cuts just outside the 19 drill
    return blocks


def _bores_in(b: ToolBlock, hole: float) -> bool:
    """Every cutting X sits just outside a hole drilled before, and it cuts along -Z."""
    xs = [w["X"] for _, t in b.lines if t.startswith("G1") and "X" in (w := _words(t))]
    deep = any(t.startswith("G1") and "Z" in (w := _words(t)) and w["Z"] < -1.0 for _, t in b.lines)
    return bool(xs) and deep and all(hole <= x <= hole + 3.0 for x in xs)


def _words(line: str) -> dict[str, float]:
    line = re.sub(r"\(.*?\)", "", line)
    return {k: float(v) for k, v in _WORD.findall(line)}


@dataclass
class Found:
    value: float | str
    source: str


def _first_rpm(b: ToolBlock) -> Found | None:
    for no, t in b.lines:
        if m := _S97.search(t):
            return Found(float(m.group(1)), b.where(no))
    return None


def _cycle_lines(b: ToolBlock, g: str) -> list[tuple[int, dict[str, float]]]:
    return [(no, _words(t)) for no, t in b.lines if re.search(rf"\b{g}(?!\d)", t)]


def extract(b: ToolBlock) -> dict[str, Found]:
    """Values a programmer used in this block, keyed like the generator's setup parameters."""
    out: dict[str, Found] = {}
    if r := _first_rpm(b):
        out["rpm"] = r
    if b.kind in ("od_rough", "bore"):
        g71 = _cycle_lines(b, "G71") or _cycle_lines(b, "G72")
        first = next(((no, w) for no, w in g71 if "P" not in w), None)
        second = next(((no, w) for no, w in g71 if "P" in w), None)
        if first and "U" in first[1]:
            out["depth_of_cut"] = Found(first[1]["U"], b.where(first[0]))
        if first and "W" in first[1] and "U" not in first[1]:
            out["depth_of_cut"] = Found(first[1]["W"], b.where(first[0]))
        # G71 U..W.. (W instead of R) is unclear on this control (open item 19): skip retract.
        if first and "R" in first[1]:
            out["retract"] = Found(first[1]["R"], b.where(first[0]))
        if second:
            no, w = second
            if "F" in w:
                out["feed"] = Found(w["F"], b.where(no))
            if "U" in w:
                out["finish_allow_x"] = Found(abs(w["U"]), b.where(no))
            if "W" in w:
                out["finish_allow_z"] = Found(abs(w["W"]), b.where(no))
    if b.kind == "drill":
        for no, t in b.lines:
            w = _words(t)
            if re.search(r"G74", t) and "R" in w and "Z" not in w:
                out.setdefault("retract", Found(w["R"], b.where(no)))
            if re.search(r"G74|G83", t) and "Z" in w:
                if "Q" in w:
                    out.setdefault("peck", Found(w["Q"] / 1000.0, b.where(no)))
                if "F" in w:
                    out.setdefault("feed", Found(w["F"], b.where(no)))
    if b.kind in ("groove", "parting"):
        if m := _WIDTH.search(b.comment):
            out["width"] = Found(float(m.group(1)), b.where(b.lines[0][0]))
        for no, t in b.lines:
            w = _words(t)
            if t.startswith("G1") and "X" in w and "Z" not in w and "F" in w:
                out["feed"] = Found(w["F"], b.where(no))
                break
    if b.kind in ("od_finish", "bore") or (b.kind == "od_rough" and "feed" not in out):
        feeds: Counter[float] = Counter()
        first_at: dict[float, int] = {}
        for no, t in b.lines:
            if re.search(r"G7[0-6]|G8[0-9]", t):
                continue
            w = _words(t)
            if "F" in w and ("Z" in w or "X" in w) and w["F"] < 1.0:
                feeds[w["F"]] += 1
                first_at.setdefault(w["F"], no)
        if feeds:
            f = sorted(feeds.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
            key = "finish_feed" if b.kind == "bore" else "feed"
            out[key] = Found(f, b.where(first_at[f]))
    if b.kind in ("od_rough", "od_finish") and (m := _NOSE.search(b.comment)):
        out["nose_radius"] = Found(float(m.group(1)), b.where(b.lines[0][0]))
    return out


def clearance(blocks: list[ToolBlock]) -> Found | None:
    """The most common positive Z the programmers rapid to before cutting (e.g. Z2.0)."""
    seen: Counter[float] = Counter()
    first: dict[float, str] = {}
    for b in blocks:
        for no, t in b.lines:
            w = _words(t)
            rapid = t.startswith("G0") or (t.startswith("Z") and set(w) == {"Z"})
            if rapid and "Z" in w and 0 < w["Z"] < 50:
                seen[w["Z"]] += 1
                first.setdefault(w["Z"], b.where(no))
    if not seen:
        return None
    z = seen.most_common(1)[0][0]
    return Found(z, first[z])


def spindle_direction(blocks: list[ToolBlock]) -> Found | None:
    seen: Counter[str] = Counter()
    first: dict[str, str] = {}
    for b in blocks:
        for no, t in b.lines:
            if _S97.search(t) and (m := re.search(r"M0?([34])(?!\d)", t)):
                code = f"M{m.group(1)}"
                seen[code] += 1
                first.setdefault(code, b.where(no))
    if not seen:
        return None
    d = seen.most_common(1)[0][0]
    return Found(d, first[d])


@dataclass
class ProvenData:
    blocks: list[ToolBlock]
    programs: list[str]

    def suggest(self, kinds: tuple[str, ...], key: str) -> dict[str, Any] | None:
        """Most common value used for this kind of tool, with where it came from."""
        found = [
            (f, b)
            for b in self.blocks
            if b.kind in kinds
            for k, f in extract(b).items()
            if k == key
        ]
        if not found:
            return None
        counts = Counter(f.value for f, _ in found)
        value, n = sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[0]
        src = next(f.source for f, _ in found if f.value == value)
        seen = sorted({f.value for f, _ in found}, key=str)
        note = f"{src}; used {n}x" + (
            f"; also seen: {', '.join(str(v) for v in seen if v != value)}" if len(seen) > 1 else ""
        )
        return {"value": value, "source": "proven program", "note": note}


def proven_data(programs: list[tuple[str, int | None, str]]) -> ProvenData:
    """programs: (name like "O0001", id, text) of approved, proven programs on one machine."""
    blocks: list[ToolBlock] = []
    for name, pid, text in programs:
        blocks.extend(split_blocks(name, text, pid))
    return ProvenData(blocks, [n for n, _, _ in programs])


# ------------------------------------------------------------------ one part's own program


@dataclass
class PartContext:
    """What the proven program for THIS part tells us (first clamping only)."""

    program: str
    blocks: list[ToolBlock]
    tools: list[dict[str, Any]]  # tool_code, tool_type, description, nose_radius, source
    drill: tuple[float | None, float] | None  # (diameter or None if not in the comment, depth)
    drill_source: str
    face_end_x: float | None  # X the facing cut ends at: inside the drilled hole
    approach_x: float | None  # a rapid X the program uses outside the bar
    approach_source: str
    max_turn_z: float | None  # deepest OD Z the first clamping turns to (chuck limit for blanks)
    max_turn_source: str
    face_stock: float | None
    face_source: str
    part_off: bool
    part_off_end_x: float | None
    part_source: str
    back_face_stock: float | None = None  # how far the 2nd side faces down (cut blanks)
    back_face_source: str = ""

    def suggest(self, kinds: tuple[str, ...], key: str) -> dict[str, Any] | None:
        for b in self.blocks:
            if b.kind in kinds and (f := extract(b).get(key)) is not None:
                return {
                    "value": f.value,
                    "source": "proven program for this part",
                    "note": f.source,
                }
        return None


def part_context(name: str, text: str) -> PartContext:
    every = split_blocks(name, text)
    blocks = [b for b in every if b.op == 1]
    tools: list[dict[str, Any]] = []
    # tools of the first clamping first; the second clamping only adds tools not used before
    for b in blocks + [b for b in every if b.op != 1]:
        if b.tool_code and b.kind and b.tool_code not in {t["tool_code"] for t in tools}:
            nose = _NOSE.search(b.comment)
            tools.append(
                {
                    "tool_code": b.tool_code,
                    "tool_type": b.kind,
                    "description": b.comment,
                    "nose_radius": float(nose.group(1)) if nose else None,
                    "source": b.where(b.lines[0][0]),
                }
            )
    drill: tuple[float | None, float] | None = None
    drill_src = ""
    for b in blocks:
        if b.kind != "drill":
            continue
        dia = re.match(r"\s*(\d+(?:\.\d+)?)", b.comment)
        for no, t in b.lines:
            w = _words(t)
            if re.search(r"G74|G83", t) and "Z" in w:
                drill = (float(dia.group(1)) if dia else None, abs(w["Z"]))
                drill_src = b.where(no)
                break
        if drill:
            break
    approach_x: float | None = None
    approach_src = ""
    face_stock: float | None = None
    face_src = ""
    face_end_x: float | None = None
    for b in blocks:
        if b.kind not in ("od_rough", "od_finish"):
            continue
        for _, t in b.lines:
            w = _words(t)
            if t.startswith("G1") and set(w) - {"G", "F"} == {"X"} and w["X"] > 0:
                face_end_x = w["X"] if face_end_x is None else min(face_end_x, w["X"])
        lines = b.lines
        for i, (no, t) in enumerate(lines):
            w = _words(t)
            if (
                t.startswith("G0")
                and "X" in w
                and w["X"] > 0
                and (approach_x is None or w["X"] > approach_x)
            ):
                approach_x, approach_src = w["X"], b.where(no)
            nxt = lines[i + 1][1] if i + 1 < len(lines) else ""
            faces = (
                set(w) == {"Z"}
                and 0 < w["Z"] <= 2.5
                and nxt.startswith("G1")
                and "X" in _words(nxt)
            )
            if faces and (face_stock is None or w["Z"] > face_stock):
                face_stock, face_src = w["Z"], b.where(no)
    max_turn: float | None = None
    max_turn_src = ""
    for b in blocks:
        if b.kind not in ("od_rough", "od_finish"):
            continue
        for no, t in b.lines:
            w = _words(t)
            cut = (t.startswith("G1") or set(w) == {"Z"}) and "Z" in w and w["Z"] < 0
            if cut and (max_turn is None or -w["Z"] > max_turn):
                max_turn, max_turn_src = -w["Z"], b.where(no)
    part = next((b for b in blocks if b.kind == "parting"), None)
    end_x: float | None = None
    if part:
        xs = [_words(t)["X"] for _, t in part.lines if "X" in _words(t) and not t.startswith("G0")]
        end_x = min(xs) if xs else None
    back_stock, back_src = _facing_stock([b for b in every if b.op != 1])
    return PartContext(
        program=name,
        blocks=blocks,
        tools=tools,
        drill=drill,
        drill_source=drill_src,
        face_end_x=face_end_x,
        approach_x=approach_x,
        approach_source=approach_src,
        max_turn_z=max_turn,
        max_turn_source=max_turn_src,
        face_stock=face_stock,
        face_source=face_src,
        part_off=part is not None,
        part_off_end_x=end_x,
        part_source=part.where(part.lines[0][0]) if part else "",
        back_face_stock=back_stock,
        back_face_source=back_src,
    )


def _facing_stock(blocks: list[ToolBlock]) -> tuple[float | None, str]:
    """Highest Z an OD tool faces from (a lone Z move followed by a G1 X cut)."""
    best: float | None = None
    src = ""
    for b in blocks:
        if b.kind not in ("od_rough", "od_finish"):
            continue
        for i, (no, t) in enumerate(b.lines):
            w = _words(t)
            nxt = b.lines[i + 1][1] if i + 1 < len(b.lines) else ""
            if (
                set(w) == {"Z"}
                and 0 < w["Z"] <= 2.5
                and nxt.startswith("G1")
                and "X" in _words(nxt)
                and (best is None or w["Z"] > best)
            ):
                best, src = w["Z"], b.where(no)
    return best, src


def company_face_stock(programs: list[tuple[str, str]]) -> dict[str, Any] | None:
    """The largest face stock any proven program allows for (more air passes, never too deep)."""
    best: tuple[float, str] | None = None
    for name, text in programs:
        ctx = part_context(name, text)
        if ctx.face_stock is not None and (best is None or ctx.face_stock > best[0]):
            best = (ctx.face_stock, ctx.face_source)
    if best is None:
        return None
    return {"value": best[0], "source": "proven program", "note": f"{best[1]} (largest face stock)"}
