"""Lathe tool-path backplot (deterministic, no AI).

Coordinates returned are (z, r): Z along the spindle axis, r = X/2 (radius). Units: mm.
Diameter programming on X/U. Blocks are drawn in file order: M99 jumps are NOT followed
(the validator warns about them); every operation is drawn.

Supported: G0/G1/G2/G3 (R or I/K), X/Z absolute, U/W incremental, A-angle moves, G28/G30
(position becomes unknown: reference point coordinates are not known), G70/G71/G72 (P/Q profile),
G74/G83 peck drilling, G76 thread passes, G90/G92/G94 single cycles, G32 threading.
Anything that cannot be drawn is skipped with a warning; it never guesses positions.
"""

import math
from dataclasses import dataclass, field
from typing import Any, Literal

from app.gcode.parser import Block, ParsedProgram, parse_program

Kind = Literal["rapid", "feed"]
Point = tuple[float, float]  # (z, r)
EPS = 1e-6
ARC_STEP_DEG = 6.0


@dataclass
class Segment:
    block: int  # index into result.blocks
    line: int
    tool: int | None
    kind: Kind
    points: list[Point]
    cycle: bool = False
    op: int = 1  # operation number (a new one starts after each M30 / M02)
    label: str = ""  # tool name from the program comments, e.g. "32.0 UDRILL"

    def to_dict(self) -> dict[str, Any]:
        return {
            "block": self.block,
            "line": self.line,
            "tool": self.tool,
            "op": self.op,
            "label": self.label,
            "kind": self.kind,
            "cycle": self.cycle,
            "points": [[round(z, 4), round(r, 4)] for z, r in self.points],
        }


@dataclass
class Backplot:
    segments: list[Segment] = field(default_factory=list)
    blocks: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)
    tools: list[int] = field(default_factory=list)

    def warn(self, line: int | None, message: str) -> None:
        if not any(w["message"] == message and w["line"] == line for w in self.warnings):
            self.warnings.append({"line": line, "message": message})

    def bounds(self) -> dict[str, float] | None:
        pts = [p for s in self.segments for p in s.points]
        if not pts:
            return None
        zs, rs = [p[0] for p in pts], [p[1] for p in pts]
        return {"z_min": min(zs), "z_max": max(zs), "r_min": min(rs), "r_max": max(rs)}

    def to_dict(self, stock: dict[str, float] | None = None) -> dict[str, Any]:
        return {
            "segments": [s.to_dict() for s in self.segments],
            "blocks": self.blocks,
            "warnings": self.warnings,
            "tools": self.tools,
            "bounds": self.bounds(),
            "stock": stock,
        }


class _State:
    def __init__(self) -> None:
        self.x: float | None = None  # diameter
        self.z: float | None = None
        self.motion: float = 0.0  # modal G group 01 (0,1,2,3,32,90,92,94)
        self.drill: float | None = None  # 83 when G83 mode is active
        self.tool: int | None = None

    @property
    def known(self) -> bool:
        return self.x is not None and self.z is not None

    def point(self) -> Point:
        assert self.x is not None and self.z is not None
        return (self.z, self.x / 2.0)


def _micro(block: Block, letter: str) -> float | None:
    """FANUC cycle words (Q/P depths) without a decimal point are in microns."""
    w = block.get(letter)
    if w is None:
        return None
    return w.value if w.has_decimal else w.value / 1000.0


class _Plotter:
    def __init__(self, prog: ParsedProgram) -> None:
        self.prog = prog
        self.blocks = prog.blocks
        self.res = Backplot()
        self.s = _State()
        self.cur: Block | None = None
        self._corner_warned = False
        self.op = 1
        self.label = ""
        self.pending_label = ""

    # ------------------------------------------------------------ output helpers

    def _emit(self, kind: Kind, pts: list[Point], cycle: bool = False) -> None:
        if len(pts) < 2 or self.cur is None:
            return
        self.res.segments.append(
            Segment(
                self.cur.index,
                self.cur.line_no,
                self.s.tool,
                kind,
                pts,
                cycle,
                op=self.op,
                label=self.label,
            )
        )

    def _move_to(self, x: float | None, z: float | None, kind: Kind, cycle: bool = False) -> None:
        """Straight move to absolute (x diameter, z). Unknown start -> position only."""
        start = self.s.point() if self.s.known else None
        if x is not None:
            self.s.x = x
        if z is not None:
            self.s.z = z
        if start is not None and self.s.known:
            self._emit(kind, [start, self.s.point()], cycle)

    # ------------------------------------------------------------ targets

    def _target(self, b: Block) -> tuple[float | None, float | None]:
        x = b.num("X")
        z = b.num("Z")
        u = b.num("U")
        w = b.num("W")
        if u is not None:
            if self.s.x is None:
                self.res.warn(b.line_no, "U move from an unknown X position was not drawn.")
                return None, z
            x = self.s.x + u
        if w is not None:
            if self.s.z is None:
                self.res.warn(b.line_no, "W move from an unknown Z position was not drawn.")
                return x, None
            z = self.s.z + w
        return x, z

    def _apply_angle(
        self, b: Block, x: float | None, z: float | None
    ) -> tuple[float | None, float | None]:
        a = b.num("A")
        if a is None or not self.s.known:
            return x, z
        assert self.s.x is not None and self.s.z is not None
        rad = math.radians(a)
        dz_dir, dr_dir = math.cos(rad), math.sin(rad)
        if x is not None and z is None:
            dr = (x - self.s.x) / 2.0
            if abs(dr_dir) < EPS:
                self.res.warn(b.line_no, f"A{a:g} is parallel to Z but an X end point was given.")
                return x, z
            t = dr / dr_dir
            if t < -EPS:
                self.res.warn(b.line_no, f"A{a:g} points away from the given X end point.")
            return x, self.s.z + t * dz_dir
        if z is not None and x is None:
            dz = z - self.s.z
            if abs(dz_dir) < EPS:
                self.res.warn(b.line_no, f"A{a:g} is parallel to X but a Z end point was given.")
                return x, z
            t = dz / dz_dir
            if t < -EPS:
                self.res.warn(b.line_no, f"A{a:g} points away from the given Z end point.")
            return self.s.x + 2.0 * t * dr_dir, z
        return x, z

    # ------------------------------------------------------------ main loop

    def run(self) -> Backplot:
        for b in self.blocks:
            self.res.blocks.append({"index": b.index, "line": b.line_no, "text": b.raw.strip()})
        i = 1 if self.prog.o_number is not None else 0
        while i < len(self.blocks):
            i = self._step(i)
        self.res.tools = sorted({s.tool for s in self.res.segments if s.tool is not None})
        return self.res

    def _step(self, i: int) -> int:
        b = self.blocks[i]
        self.cur = b
        if not b.words:
            return i + 1
        gs = b.g_codes()
        # Tool names live in comments on N blocks, e.g. N1(32.0 UDRILL) before T0101.
        if b.seq is not None:
            self.pending_label = b.comments[0].strip() if b.comments else ""
        if b.get("T") is not None:
            self.label = b.comments[0].strip() if b.comments else self.pending_label
            digits = b.get("T").text.split(".")[0]  # type: ignore[union-attr]
            if digits.isdigit() and len(digits) >= 3:
                self.s.tool = int(digits[:-2])
            elif digits.isdigit():
                self.s.tool = int(digits)
        mcs = b.m_codes()

        # Two-block canned cycles and finishing cycle.
        for g in (71.0, 72.0):
            if g in gs:
                return self._rough_cycle(i, int(g))
        if 70.0 in gs:
            return self._finish_cycle(i)
        if 74.0 in gs:
            self._g74(b)
            return i + 1
        if 76.0 in gs:
            self._g76(b)
            return i + 1
        if 28.0 in gs or 30.0 in gs:
            self.s.x = self.s.z = None  # reference point position is not known
            self.s.drill = None
            return i + 1
        if 50.0 in gs and (b.get("X") or b.get("Z")):
            self.res.warn(b.line_no, "G50 coordinate setting is not drawn; positions reset.")
            self.s.x = self.s.z = None
            return i + 1
        if 80.0 in gs:
            self.s.drill = None
        if 83.0 in gs:
            self.s.drill = 83.0
        for g in gs:
            if g in (0.0, 1.0, 2.0, 3.0, 32.0, 90.0, 92.0, 94.0):
                self.s.motion = g
                self.s.drill = None if g in (0.0, 1.0, 2.0, 3.0) else self.s.drill

        if self.s.drill == 83.0 and (b.get("Z") or b.get("W")):
            self._g83(b)
        elif b.get("X") or b.get("Z") or b.get("U") or b.get("W"):
            self._motion(b)
        if 30 in mcs or 2 in mcs:
            self.s.x = self.s.z = None  # end of operation: part re-clamped next
            self.op += 1
        return i + 1

    def _motion(self, b: Block) -> None:
        x, z = self._target(b)
        corner_words = (b.get("R") is not None and self.s.motion == 1.0) or bool(
            b.get(",R") or b.get(",C")
        )
        if corner_words and not self._corner_warned:
            self.res.warn(None, "Corner R / chamfer words on G1 lines are drawn as sharp corners.")
            self._corner_warned = True
        m = self.s.motion
        if m in (0.0, 1.0, 32.0):
            if m == 1.0:
                x, z = self._apply_angle(b, x, z)
            self._move_to(x, z, "rapid" if m == 0.0 else "feed")
        elif m in (2.0, 3.0):
            self._arc(b, x, z, clockwise=(m == 2.0))
        elif m in (90.0, 92.0):
            self._box(b, x, z, face=False)
        elif m == 94.0:
            self._box(b, x, z, face=True)

    # ------------------------------------------------------------ arcs

    def _arc(self, b: Block, x: float | None, z: float | None, clockwise: bool) -> None:
        if not self.s.known:
            self._move_to(x, z, "feed")
            return
        sz, sr = self.s.point()
        ex = x if x is not None else self.s.x
        ez = z if z is not None else self.s.z
        assert ex is not None and ez is not None
        er = ex / 2.0
        r_word, i_word, k_word = b.num("R"), b.num("I"), b.num("K")
        if i_word is not None or k_word is not None:
            cz = sz + (k_word or 0.0)
            cr = sr + (i_word or 0.0)  # I is a radius value on a FANUC lathe
        elif r_word is not None:
            centre = _arc_centre((sz, sr), (ez, er), r_word, clockwise)
            if centre is None:
                self.res.warn(b.line_no, f"Arc radius R{r_word:g} is too small for its end point.")
                self._move_to(ex, ez, "feed")
                return
            cz, cr = centre
        else:
            self.res.warn(b.line_no, "Arc without R or I/K drawn as a straight line.")
            self._move_to(ex, ez, "feed")
            return
        pts = _arc_points((sz, sr), (ez, er), (cz, cr), clockwise)
        self.s.x, self.s.z = ex, ez
        self._emit("feed", pts)

    # ------------------------------------------------------------ single cycles

    def _box(self, b: Block, x: float | None, z: float | None, face: bool) -> None:
        if not self.s.known or x is None or z is None:
            self.res.warn(b.line_no, "G90/G92/G94 cycle from an unknown position was not drawn.")
            self._move_to(x, z, "feed")
            return
        x0, z0 = self.s.x, self.s.z
        assert x0 is not None and z0 is not None
        if face:  # G94: Z first
            self._move_to(None, z, "rapid", True)
            self._move_to(x, None, "feed", True)
            self._move_to(None, z0, "feed", True)
            self._move_to(x0, None, "rapid", True)
        else:  # G90 / G92
            self._move_to(x, None, "rapid", True)
            self._move_to(None, z, "feed", True)
            self._move_to(x0, None, "feed", True)
            self._move_to(None, z0, "rapid", True)

    # ------------------------------------------------------------ drilling

    def _peck(self, z_target: float, peck: float | None, retract: float) -> None:
        assert self.s.z is not None
        z0 = self.s.z
        if peck is None or peck <= EPS:
            self._move_to(None, z_target, "feed", True)
        else:
            depth = z0
            while depth - peck > z_target + EPS:
                depth -= peck
                self._move_to(None, depth, "feed", True)
                self._move_to(None, depth + retract, "rapid", True)
                self._move_to(None, depth, "rapid", True)
            self._move_to(None, z_target, "feed", True)
        self._move_to(None, z0, "rapid", True)

    def _g74(self, b: Block) -> None:
        if b.get("Z") is None and b.get("W") is None:
            self._g74_retract = b.num("R") or 0.0  # first block: G74 R(e)
            return
        if not self.s.known:
            self.res.warn(b.line_no, "G74 from an unknown position was not drawn.")
            return
        x, z = self._target(b)
        if x is not None and abs(x - (self.s.x or 0.0)) > EPS:
            self.res.warn(b.line_no, "G74 with an X shift is drawn at the start X only.")
        assert z is not None
        self._peck(z, _micro(b, "Q"), getattr(self, "_g74_retract", 0.5))

    def _g83(self, b: Block) -> None:
        if not self.s.known:
            self.res.warn(b.line_no, "G83 from an unknown position was not drawn.")
            return
        x, z = self._target(b)
        if x is not None:
            self._move_to(x, None, "rapid", True)
        self.res.warn(
            b.line_no,
            "G83: drawn from the start point; the R-point meaning depends on machine "
            "parameters (VERIFY ON MACHINE).",
        )
        assert z is not None
        self._peck(z, _micro(b, "Q"), 1.0)

    # ------------------------------------------------------------ threading G76

    def _g76(self, b: Block) -> None:
        if b.get("X") is None and b.get("U") is None:
            return  # first block: G76 P(m)(r)(a) Q R
        if not self.s.known:
            self.res.warn(b.line_no, "G76 from an unknown position was not drawn.")
            return
        x, z = self._target(b)
        k = _micro(b, "P")  # thread height
        dd = _micro(b, "Q")  # first cut depth
        if x is None or z is None or not k or not dd:
            self.res.warn(b.line_no, "G76 thread without X, Z, P and Q was not drawn.")
            return
        x0, z0 = self.s.x, self.s.z
        assert x0 is not None and z0 is not None
        outside = x0 > x
        n, depth = 1, dd
        passes = 0
        while passes < 200:
            depth = min(k, dd * math.sqrt(n))
            dia = x + (2 * (k - depth) if outside else -2 * (k - depth))
            self._move_to(dia, None, "rapid", True)
            self._move_to(None, z, "feed", True)
            self._move_to(x0, None, "rapid", True)
            self._move_to(None, z0, "rapid", True)
            passes += 1
            if depth >= k - EPS:
                break
            n += 1

    # ------------------------------------------------------------ G70 / G71 / G72

    def _find_seq(self, start: int, seq: int) -> int | None:
        for j in range(start, len(self.blocks)):
            if self.blocks[j].seq == seq:
                return j
        return None

    def _profile(self, i_ns: int, i_nf: int, start: Point) -> list[Point]:
        """Run the P..Q blocks on a scratch state to get the finish profile."""
        saved = (self.s.x, self.s.z, self.s.motion, self.cur, len(self.res.segments))
        self.s.x, self.s.z = start[1] * 2.0, start[0]
        pts = [start]
        for j in range(i_ns, i_nf + 1):
            blk = self.blocks[j]
            self.cur = blk
            for g in blk.g_codes():
                if g in (0.0, 1.0, 2.0, 3.0):
                    self.s.motion = g
            if blk.get("X") or blk.get("Z") or blk.get("U") or blk.get("W"):
                self._motion(blk)
        new = self.res.segments[saved[4] :]
        for seg in new:
            pts.extend(seg.points[1:])
        del self.res.segments[saved[4] :]
        self.s.x, self.s.z, self.s.motion, self.cur = saved[0], saved[1], saved[2], saved[3]
        return pts

    def _finish_cycle(self, i: int) -> int:
        b = self.blocks[i]
        p, q = b.num("P"), b.num("Q")
        if p is None or q is None or not self.s.known:
            self.res.warn(b.line_no, "G70 could not be drawn (needs P, Q and a known start).")
            return i + 1
        i_ns, i_nf = self._find_seq(0, int(p)), self._find_seq(0, int(q))
        if i_ns is None or i_nf is None or i_nf < i_ns:
            self.res.warn(b.line_no, f"G70 profile N{int(p)}..N{int(q)} not found.")
            return i + 1
        start = self.s.point()
        prof = self._profile(i_ns, i_nf, start)
        self.cur = b
        self._emit("feed", prof, cycle=True)
        self._move_to(start[1] * 2.0, start[0], "rapid", True)
        return i + 1

    def _rough_cycle(self, i: int, g: int) -> int:
        b = self.blocks[i]
        if b.get("P") is None:  # first block: G71 U(d) R(e) / G72 W(d) R(e)
            depth = b.num("U") if g == 71 else b.num("W")
            self._rough = (depth or 1.0, b.num("R") or 0.5)
            if g == 71 and b.get("W") is not None and b.get("R") is None:
                self.res.warn(b.line_no, "W in the first G71 block is not used by the backplot.")
            return i + 1
        p, q = int(b.num("P") or 0), int(b.num("Q") or 0)
        i_ns, i_nf = self._find_seq(i + 1, p), self._find_seq(i + 1, q)
        if i_ns is None or i_nf is None or i_nf < i_ns:
            self.res.warn(b.line_no, f"G{g} profile N{p}..N{q} not found after the cycle block.")
            return i + 1
        if not self.s.known:
            self.res.warn(b.line_no, f"G{g} from an unknown start position was not drawn.")
            return i_nf + 1
        depth, retract = getattr(self, "_rough", (1.0, 0.5))
        du, dw = b.num("U") or 0.0, b.num("W") or 0.0
        start = self.s.point()
        prof = self._profile(i_ns, i_nf, start)
        shifted = [(z + dw, r + du / 2.0) for z, r in prof]
        self.cur = b
        try:
            if g == 71:
                self._rough_passes(start, shifted, abs(depth), retract, along_z=True)
            else:
                self._rough_passes(start, shifted, abs(depth), retract, along_z=False)
            self._emit("feed", [start, *shifted[1:]], cycle=True)  # contour pass with allowance
        except ValueError as e:
            self.res.warn(b.line_no, f"G{g} rough passes not drawn ({e}); finish profile shown.")
            self._emit("feed", prof, cycle=True)
        self.s.z, self.s.x = start[0], start[1] * 2.0
        return i_nf + 1  # the P..Q blocks are part of the cycle, not run again

    def _rough_passes(
        self, start: Point, prof: list[Point], depth: float, retract: float, along_z: bool
    ) -> None:
        """G71 (along_z): horizontal passes at radius levels. G72: vertical passes at Z levels."""
        if depth <= EPS:
            raise ValueError("depth of cut is zero")
        sz, sr = start
        a = 1 if along_z else 0  # index of the level coordinate in (z, r)
        level0 = start[a]
        body = prof[1:]  # profile without the cycle start point
        if len(body) < 2:
            raise ValueError("profile has fewer than two points")
        # Direction comes from the first profile block (ns): OD/face cuts towards it.
        first = body[0][a] - level0
        if abs(first) < EPS:
            raise ValueError("first profile block does not move away from the start point")
        direction = -1.0 if first < 0 else 1.0
        values = [pt[a] for pt in body]
        limit = min(values) if direction < 0 else max(values)
        level = level0 + direction * depth
        count = 0
        while (level - limit) * direction < -EPS and count < 500:
            end = _first_crossing(body, level, a)
            other_start = start[1 - a]
            other_end = end if end is not None else body[-1][1 - a]
            if along_z:
                p1, p2 = (other_start, level), (other_end, level)
                back = (other_end + retract, level - direction * retract)
            else:
                p1, p2 = (level, other_start), (level, other_end)
                back = (level - direction * retract, other_end + retract)
            self._emit("rapid", [(self.s.z or sz, (self.s.x or sr * 2) / 2.0), p1], True)
            self._emit("feed", [p1, p2], True)
            self._emit("rapid", [p2, back], True)
            ret = (other_start, back[1]) if along_z else (back[0], other_start)
            self._emit("rapid", [back, ret], True)
            self.s.z, self.s.x = ret[0], ret[1] * 2.0
            level += direction * depth
            count += 1


def _first_crossing(prof: list[Point], level: float, axis: int) -> float | None:
    """Coordinate (other axis) where the profile first reaches `level` on `axis`."""
    other = 1 - axis
    for p, q in zip(prof, prof[1:], strict=False):
        a0, a1 = p[axis], q[axis]
        if (a0 - level) * (a1 - level) <= 0 and abs(a1 - a0) > EPS:
            t = (level - a0) / (a1 - a0)
            return p[other] + t * (q[other] - p[other])
        if abs(a0 - level) < EPS:
            return p[other]
    return None


def _arc_centre(s: Point, e: Point, radius: float, clockwise: bool) -> Point | None:
    (z1, r1), (z2, r2) = s, e
    dz, dr = z2 - z1, r2 - r1
    chord = math.hypot(dz, dr)
    rad = abs(radius)
    if chord < EPS or chord > 2 * rad + 1e-4:
        return None
    h = math.sqrt(max(rad * rad - (chord / 2) ** 2, 0.0))
    mz, mr = (z1 + z2) / 2, (r1 + r2) / 2
    # unit normal to the chord (left of s->e)
    nz, nr = -dr / chord, dz / chord
    # In (z right, r up) view: G2 = clockwise -> centre to the right of travel for minor arcs.
    sign = -1.0 if clockwise else 1.0
    if radius < 0:  # negative R = arc greater than 180 degrees
        sign = -sign
    return (mz + sign * h * nz, mr + sign * h * nr)


def _arc_points(s: Point, e: Point, c: Point, clockwise: bool) -> list[Point]:
    a0 = math.atan2(s[1] - c[1], s[0] - c[0])
    a1 = math.atan2(e[1] - c[1], e[0] - c[0])
    rad = math.hypot(s[0] - c[0], s[1] - c[1])
    if clockwise:
        while a1 > a0 - EPS:
            a1 -= 2 * math.pi
    else:
        while a1 < a0 + EPS:
            a1 += 2 * math.pi
    if abs(a1 - a0) >= 2 * math.pi - 1e-9:
        a1 = a0 + (-1 if clockwise else 1) * (2 * math.pi - 1e-9)
    steps = max(2, int(abs(math.degrees(a1 - a0)) / ARC_STEP_DEG) + 1)
    pts = [
        (
            c[0] + rad * math.cos(a0 + (a1 - a0) * k / steps),
            c[1] + rad * math.sin(a0 + (a1 - a0) * k / steps),
        )
        for k in range(steps + 1)
    ]
    pts[-1] = e
    return pts


def backplot(text: str) -> Backplot:
    return _Plotter(parse_program(text)).run()


def stock_outline(bar_diameter: float | None, plot: Backplot) -> dict[str, float] | None:
    """Bar stock rectangle (radius 0..D/2), from the face (Z = 0) to just past the deepest cut."""
    if not bar_diameter or bar_diameter <= 0:
        return None
    feed_z = [p[0] for s in plot.segments if s.kind == "feed" for p in s.points]
    deepest = min(feed_z) if feed_z else -10.0
    return {"r": bar_diameter / 2.0, "z_front": 0.0, "z_back": min(deepest - 5.0, -5.0)}
