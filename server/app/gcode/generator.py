"""Program generator: feature table -> FANUC 0i-TF lathe program (fixed, deterministic code).

Safety rule 2: this is NOT AI. The same inputs always give the same program text. It only uses:
- the engineer's values from the feature table (taken from the drawing),
- the machine's tool list and limits (entered from the machine),
- the setup a programmer confirms on screen (tools, speeds, feeds, cycle values), which is
  pre-filled from the company's proven programs or from the last setup saved for that machine.
Nothing is guessed: any value missing stops generation and is reported as a problem.

Every generated program is stored as a DRAFT, validated, back-plotted and must be approved by a
programmer before it can be sent (safety rule 3).

How the table is read (shown on screen as well):
- Z0 is the finished front face, X is a diameter. One clamping, machined from the front.
- OD features are listed from the front face; each length is that step's own length. Diameters
  must grow towards the chuck.
- Bores are listed from the front, largest first; each depth is measured from the front face.
- A chamfer or radius applies to the front corner of the OD or bore listed right after it.
  Chamfer: size = length along the axis, angle measured from the axis.
- Groove: diameter = groove bottom, position = front face to the groove's front wall.
- Thread: metric (M..) on the OD step with the same diameter, from that step's front edge.
- Drill: centre drill depth from the front face, programmed as entered.
- Cone (countersink / flare): mouth diameter at the face, angle from the axis and an optional
  blend radius into the bore or OD listed right after it.
- Turn part around: every feature after it is machined in the SECOND clamping, measured from the
  finished back face (Z0 = back face). The part-off leaves the back-face stock; the second
  clamping is written after the first one's M30, as in the proven programs (sequence search).
  It uses the same turret tools and cutting values as the first clamping.
"""

import math
import re
from dataclasses import dataclass, field, replace
from typing import Any

# ------------------------------------------------------------------ operations and settings


@dataclass(frozen=True)
class Param:
    key: str
    label: str
    unit: str
    kind: str = "num"  # num | int | choice
    choices: tuple[str, ...] = ()
    hint: str = ""


@dataclass(frozen=True)
class OpSpec:
    key: str
    label: str
    tool_types: tuple[str, ...]  # allowed machine tool types; () = no tool
    proven_kinds: tuple[str, ...]  # proven-program tool kinds to learn values from
    params: tuple[Param, ...]


RPM = Param("rpm", "Spindle speed (G97)", "rpm", "int")
FEED = Param("feed", "Feed", "mm/rev")

OPS: tuple[OpSpec, ...] = (
    OpSpec(
        "general",
        "General",
        (),
        (),
        (
            Param(
                "clearance",
                "Clearance from the part",
                "mm",
                hint="Rapid moves stop this far from the stock (e.g. Z2.0).",
            ),
            Param("spindle_direction", "Spindle direction", "", "choice", ("M3", "M4")),
            Param(
                "part_off",
                "Part off from bar at the end",
                "",
                "choice",
                ("yes", "no"),
                hint="Bar stock: yes. Cut blanks: no.",
            ),
        ),
    ),
    OpSpec(
        "drill",
        "Drill (G74 peck)",
        ("drill",),
        ("drill",),
        (RPM, FEED, Param("peck", "Peck depth", "mm"), Param("retract", "Peck retract", "mm")),
    ),
    OpSpec(
        "rough",
        "Face and rough turn (G71)",
        ("od_rough", "od_finish"),
        ("od_rough",),
        (
            RPM,
            Param("feed", "Roughing feed", "mm/rev"),
            Param("depth_of_cut", "Depth of cut per side", "mm"),
            Param("retract", "Retract", "mm"),
            Param("finish_allow_x", "Finish allowance X (on diameter)", "mm"),
            Param("finish_allow_z", "Finish allowance Z", "mm"),
            Param(
                "face_stock",
                "Stock on the front face",
                "mm",
                hint="How far the bar sticks out past the finished face Z0.",
            ),
        ),
    ),
    OpSpec(
        "finish",
        "Finish turn (G70)",
        ("od_finish", "od_rough"),
        ("od_finish",),
        (RPM, Param("feed", "Finishing feed", "mm/rev")),
    ),
    OpSpec(
        "bore",
        "Rough and finish bore (G71/G70)",
        ("bore",),
        ("bore",),
        (
            RPM,
            Param("feed", "Roughing feed", "mm/rev"),
            Param("finish_feed", "Finishing feed", "mm/rev"),
            Param("depth_of_cut", "Depth of cut per side", "mm"),
            Param("retract", "Retract", "mm"),
            Param("finish_allow_x", "Finish allowance X (on diameter)", "mm"),
            Param("finish_allow_z", "Finish allowance Z", "mm"),
        ),
    ),
    OpSpec(
        "groove",
        "Grooves (plunge)",
        ("groove", "parting"),
        ("groove",),
        (
            RPM,
            Param("feed", "Plunge feed", "mm/rev"),
            Param("width", "Insert width", "mm"),
            Param(
                "ref_edge",
                "Tool Z offset set on",
                "",
                "choice",
                ("left", "right"),
                hint="Left = chuck-side edge of the insert, right = front-side edge.",
            ),
        ),
    ),
    OpSpec(
        "thread",
        "Thread (G76)",
        ("thread",),
        ("thread",),
        (
            RPM,
            Param("first_depth", "First cut depth", "mm"),
            Param("min_depth", "Minimum cut depth", "mm"),
            Param("finish_allowance", "Finish allowance", "mm"),
            Param("finish_passes", "Finishing passes", "", "int"),
        ),
    ),
    OpSpec(
        "back",
        "Second clamping (part turned around)",
        (),
        (),
        (
            Param(
                "face_stock",
                "Stock on the back face",
                "mm",
                hint="Left on the back by the part-off (or the blank), faced off after turning.",
            ),
        ),
    ),
    OpSpec(
        "part",
        "Part off",
        ("parting",),
        ("parting",),
        (
            RPM,
            Param("feed", "Parting feed", "mm/rev"),
            Param("width", "Blade width", "mm"),
            Param(
                "ref_edge",
                "Tool Z offset set on",
                "",
                "choice",
                ("left", "right"),
                hint="Left = chuck-side edge of the blade, right = front-side edge.",
            ),
        ),
    ),
)
OP_BY_KEY = {o.key: o for o in OPS}
ZERO_OK = frozenset({"finish_allow_x", "finish_allow_z", "face_stock", "finish_passes"})


# ------------------------------------------------------------------ geometry from the table


class GeometryError(ValueError):
    pass


@dataclass
class Corner:
    chamfer: tuple[float, float] | None = None  # (axial, radial)
    radius: float | None = None
    cone: tuple[float, float, float] | None = None  # (mouth diameter, angle deg, blend radius)

    def cone_points(self, dia: float, z: float) -> tuple[float, float, float, float]:
        """(x, z) where the cone line meets the blend arc, then where the arc meets the step."""
        assert self.cone is not None
        mouth, ang, r = self.cone
        a = math.radians(ang)
        arc_rad, arc_ax = r * (1 - math.cos(a)), r * math.sin(a)
        line_rad = abs(mouth - dia) / 2 - arc_rad
        line_ax = line_rad / math.tan(a)
        sign = 1 if dia > mouth else -1
        x1 = mouth + sign * 2 * line_rad
        return x1, z - line_ax, dia, z - line_ax - arc_ax


@dataclass
class Step:
    dia: float  # the diameter cut (middle of the tolerance); a taper's diameter at z_back
    z_front: float
    z_back: float
    corner: Corner = field(default_factory=Corner)
    nominal: float | None = None  # the drawing's nominal size
    front: float | None = None  # a taper's diameter at z_front (None: a plain cylinder)

    @property
    def d0(self) -> float:
        """Diameter at the front of the step (where its corner is)."""
        return self.dia if self.front is None else self.front

    def dia_at(self, z: float) -> float:
        """Diameter at Z on this step (straight line along a taper)."""
        if self.front is None or self.z_front == self.z_back:
            return self.dia
        t = (self.z_front - z) / (self.z_front - self.z_back)
        return self.front + (self.dia - self.front) * min(1.0, max(0.0, t))


@dataclass
class Groove:
    dia: float
    width: float
    position: float


@dataclass
class Thread:
    size: str
    major: float
    pitch: float
    length: float
    z_start: float


@dataclass
class BackSide:
    """The second clamping: Z0 = finished back face, Z negative towards the chuck."""

    od: list[Step]
    bores: list[Step]
    drill: tuple[float, float] | None


@dataclass
class Geometry:
    material: str
    bar: float
    length: float
    od: list[Step]
    bores: list[Step]
    drill: tuple[float, float] | None  # (diameter, depth)
    grooves: list[Groove]
    threads: list[Thread]
    notes: list[str] = field(default_factory=list)  # standard choices the drawing does not give
    start_x: float | None = None  # rapid X known to clear the bar (when the bar size is unknown)
    part_off_end_x: float | None = None
    hole_x: float | None = None
    max_turn_z: float | None = None
    max_turn_source: str = ""
    back: BackSide | None = None

    def needed_ops(self, part_off: bool | None) -> list[str]:
        ops = ["general"]
        b = self.back
        if self.drill or (b and b.drill):
            ops.append("drill")
        ops.append("rough")  # always faces the front
        if self.od or (b and b.od):
            ops.append("finish")
        if self.bores or (b and b.bores):
            ops.append("bore")
        if self.grooves:
            ops.append("groove")
        if self.threads:
            ops.append("thread")
        if b:
            ops.append("back")
        if part_off is not False:
            ops.append("part")
        return ops

    def through_hole(self) -> float | None:
        """Diameter of a hole that runs through the part after the first clamping."""
        if self.bores and -self.bores[-1].z_back >= self.length - 1e-9:
            return self.bores[-1].dia
        if self.drill and self.drill[1] >= self.length - 1e-9:
            return self.drill[0]
        return None


def _val(cell: dict[str, Any] | None) -> Any:
    v = None if cell is None else cell.get("value")
    return None if v == "" else v


def _num(cell: dict[str, Any] | None, what: str, problems: list[str]) -> float:
    v = _val(cell)
    if isinstance(v, bool) or not isinstance(v, int | float):
        problems.append(f"{what}: not entered.")
        return math.nan
    return float(v)


@dataclass
class Fallback:
    """Real values from the proven program for the same part, used where the drawing is silent."""

    program: str
    drill: tuple[float | None, float] | None = None
    drill_source: str = ""
    hole_x: float | None = None  # an X known to be inside the drilled hole (when its size is not)
    max_turn_z: float | None = None  # how deep the first clamping turns the OD (chuck limit)
    max_turn_source: str = ""
    approach_x: float | None = None
    approach_source: str = ""
    part_off_end_x: float | None = None


BORE_STOCK = 2.0  # mm on the diameter left by the drill for the boring bar
MIN_DRILL = 3.0


def standard_drill(
    smallest_bore: float, deepest_bore: float, length: float
) -> tuple[float, float] | None:
    """(diameter, depth) of a standard drill for a bore the drawing shows only finished: the
    largest 0.5 mm size leaving BORE_STOCK to bore; through the part when the bore goes through
    (plus the drill point), else as deep as the deepest bore plus the point."""
    dia = math.floor((smallest_bore - BORE_STOCK) * 2 + 1e-9) / 2
    if dia < MIN_DRILL:
        return None
    point = round(0.3 * dia, 1)  # 118 deg point length
    through = deepest_bore >= length - 1e-6
    depth = (length + point + 1.0) if through else (deepest_bore + point)
    return dia, round(depth, 1)


def _mid(cells: dict[str, Any], nominal: float) -> float:
    """Middle of the tolerance band (the proven programs cut there), else the nominal."""
    tp, tm = _val(cells.get("tol_plus")), _val(cells.get("tol_minus"))
    if isinstance(tp, int | float) and isinstance(tm, int | float) and not math.isnan(nominal):
        return round(nominal + (float(tp) + float(tm)) / 2, 3)
    return nominal


Side = tuple[
    list[Step],
    list[Step],
    tuple[float, float] | None,
    list[Groove],
    list[tuple[int, dict[str, Any]]],
]


def _parse_side(
    feats: list[dict[str, Any]],
    first_n: int,
    p: list[str],
    *,
    back: bool,
    notes: list[str] | None = None,
) -> Side:
    """One clamping's features, measured from its own finished face (Z0)."""
    face_word = "back" if back else "front"
    od: list[Step] = []
    bores: list[Step] = []
    drill: tuple[float, float] | None = None
    grooves: list[Groove] = []
    threads_raw: list[tuple[int, dict[str, Any]]] = []
    pending: Corner | None = None
    pending_n = 0
    z_od = 0.0
    bore_depth = 0.0
    for n, f in enumerate(feats, start=first_n):
        t, c = f["type"], f["fields"]
        name = f"Feature {n}"
        if t in ("chamfer", "radius", "cone"):
            if pending is not None:
                p.append(f"{name}: two corner features in a row (feature {pending_n} too).")
            pending_n = n
            if t == "chamfer":
                size = _num(c.get("size"), f"{name} chamfer size", p)
                ang = _num(c.get("angle"), f"{name} chamfer angle", p)
                if not math.isnan(ang) and not 0 < ang < 90:
                    p.append(f"{name}: chamfer angle must be between 0 and 90 degrees.")
                    ang = math.nan
                pending = Corner(chamfer=(size, size * math.tan(math.radians(ang))))
            elif t == "radius":
                pending = Corner(radius=_num(c.get("radius"), f"{name} radius", p))
            else:
                mouth = _mid(c, _num(c.get("diameter"), f"{name} cone mouth diameter", p))
                ang = _num(c.get("angle"), f"{name} cone angle", p)
                if not math.isnan(ang) and not 0 < ang < 90:
                    p.append(f"{name}: cone angle must be between 0 and 90 degrees.")
                    ang = math.nan
                r = _val(c.get("radius"))
                blend = float(r) if isinstance(r, int | float) and not isinstance(r, bool) else 0.0
                if blend < 0:
                    p.append(f"{name}: cone blend radius cannot be below 0.")
                pending = Corner(cone=(mouth, ang, blend))
            continue
        corner, pending = (pending or Corner()), None
        if t == "taper":
            n0 = _num(c.get("diameter_start"), f"{name} taper front diameter", p)
            n1 = _num(c.get("diameter_end"), f"{name} taper end diameter", p)
            d0, d1 = _mid(c, n0), _mid(c, n1)
            ln = _num(c.get("length"), f"{name} taper length", p)
            if not (math.isnan(d0) or math.isnan(d1)):
                if d1 <= d0:
                    p.append(
                        f"{name}: the taper must grow toward the chuck (front {n0:g}, end {n1:g})."
                        + ("" if back else " Turn the part around for a taper the other way.")
                    )
                if od and d0 < od[-1].dia - 1e-9:
                    p.append(
                        f"{name}: the taper starts at {n0:g}, smaller than the step before it "
                        f"({od[-1].dia:g}). Diameters must grow towards the chuck in one clamping."
                    )
            ang = _val(c.get("angle"))
            if isinstance(ang, int | float) and not math.isnan(ln) and ln > 0 and n1 > n0:
                drawn = math.degrees(math.atan((n1 - n0) / 2 / ln))
                if abs(drawn - float(ang)) > 0.05 and notes is not None:
                    notes.append(
                        f"{name}: the drawing's {float(ang):g}° per side does not match "
                        f"Ø{n0:g} to Ø{n1:g} over {ln:g} ({drawn:.2f}°). The program cuts the "
                        "diameters; check which governs with the designer."
                    )
            od.append(Step(d1, -z_od, -(z_od + ln), corner, n1, front=d0))
            z_od += ln
        elif t == "od":
            nom = _num(c.get("diameter"), f"{name} OD diameter", p)
            d = _mid(c, nom)
            ln = _num(c.get("length"), f"{name} OD length", p)
            # A plain step may carry on at a taper's end size (same nominal on the drawing,
            # e.g. a 2° taper to Ø21.30, then Ø21.30 0/-0.02 x 17): the taper then ends at the
            # step's cut size, so the contour has no step down (G71 needs it monotonic).
            prev = od[-1] if od else None
            continues = (
                prev is not None
                and prev.front is not None
                and prev.nominal is not None
                and not math.isnan(nom)
                and abs(nom - prev.nominal) < 0.011
            )
            if continues and prev is not None and d < prev.dia:
                od[-1] = replace(prev, dia=max(d, prev.d0))
            if od and d <= od[-1].dia and not continues:
                p.append(
                    f"{name}: OD {d:g} is not bigger than the step before it ({od[-1].dia:g}). "
                    "Diameters must grow towards the chuck in one clamping"
                    + ("." if back else "; add 'Turn part around' for the other end.")
                )
            od.append(Step(d, -z_od, -(z_od + ln), corner, nom))
            z_od += ln
        elif t == "bore":
            d = _mid(c, _num(c.get("diameter"), f"{name} bore diameter", p))
            depth = _num(c.get("depth"), f"{name} bore depth", p)
            if bores and d >= bores[-1].dia:
                p.append(f"{name}: bores must get smaller going in (largest first).")
            if depth <= bore_depth:
                p.append(f"{name}: bore depth must be deeper than the bore before it.")
            bores.append(Step(d, -bore_depth, -depth, corner))
            bore_depth = depth
        elif t == "drill":
            if drill is not None:
                p.append(f"{name}: only one drill per clamping is supported.")
            drill = (
                _num(c.get("diameter"), f"{name} drill diameter", p),
                _num(c.get("depth"), f"{name} drill depth", p),
            )
        elif t == "groove":
            grooves.append(
                Groove(
                    _mid(c, _num(c.get("diameter"), f"{name} groove diameter", p)),
                    _num(c.get("width"), f"{name} groove width", p),
                    _num(c.get("position"), f"{name} groove position", p),
                )
            )
        elif t == "thread":
            threads_raw.append((n, c))
        elif t == "face":
            pos = _num(c.get("position"), f"{name} face position", p)
            if not math.isnan(pos) and pos != 0:
                p.append(
                    f"{name}: only the {face_word} face (position 0) is faced; shoulders come "
                    "from the OD steps."
                )
        elif t == "flip":
            continue
        if (corner.chamfer or corner.radius or corner.cone) and t not in ("od", "bore", "taper"):
            p.append(
                f"Feature {pending_n}: a chamfer/radius/cone must be followed by an OD or bore."
            )
    if pending is not None:
        p.append(f"Feature {pending_n}: a chamfer/radius/cone must be followed by an OD or bore.")
    return od, bores, drill, grooves, threads_raw


def read_geometry(
    data: dict[str, Any], fallback: Fallback | None = None
) -> tuple[Geometry | None, list[str]]:
    """Turn the feature table values into turned geometry, or list what is wrong or missing."""
    p: list[str] = []
    notes: list[str] = []
    h = data.get("header", {})
    material = str(_val(h.get("material_grade")) or "")
    if not material:
        p.append("Material grade: not entered.")
    bar_given = _val(h.get("bar_diameter")) not in (None, "")
    start_x: float | None = None
    if not bar_given and fallback and fallback.approach_x:
        bar = math.nan  # unknown: rapid moves use the proven program's clear X instead
        start_x = fallback.approach_x
        notes.append(
            f"Bar size not entered: start X{fmt(start_x)} taken from {fallback.approach_source}, "
            "where it clears the bar."
        )
    else:
        bar = _num(h.get("bar_diameter"), "Bar diameter", p)
    length = _num(h.get("overall_length"), "Overall length", p)

    feats = list(data.get("features", []))
    flips = [i for i, f in enumerate(feats) if f.get("type") == "flip"]
    if len(flips) > 1:
        p.append("'Turn part around' can only be used once (two clampings).")
    cut = flips[0] if flips else len(feats)
    front = _parse_side(feats[:cut], 1, p, back=False, notes=notes)
    od, bores, drill, grooves, threads_raw = front
    back: BackSide | None = None
    if flips:
        b_od, b_bores, b_drill, b_grooves, b_threads = _parse_side(
            feats[cut + 1 :], cut + 2, p, back=True, notes=notes
        )
        if b_grooves or b_threads:
            p.append("Grooves and threads are only made in the first clamping.")
        if not (b_od or b_bores or b_drill):
            notes.append("Second clamping: the back face is faced to length only.")
        back = BackSide(b_od, b_bores, b_drill)

    threads: list[Thread] = []
    for n, c in threads_raw:
        tsize = str(_val(c.get("size")) or "").upper().replace(" ", "")
        m = re.fullmatch(r"M(\d+(?:\.\d+)?)(?:X[\d.]+)?", tsize)
        if not m:
            p.append(
                f"Feature {n}: thread size '{tsize}' - only metric threads (M..) are supported."
            )
            continue
        major = float(m.group(1))
        pitch = _num(c.get("pitch"), f"Feature {n} thread pitch", p)
        tl = _num(c.get("length"), f"Feature {n} thread length", p)
        step = next((s for s in od if abs((s.nominal or s.dia) - major) < 0.011), None)
        if step is None:
            p.append(f"Feature {n}: no OD step of diameter {major:g} to cut the {tsize} thread on.")
            continue
        threads.append(Thread(tsize, major, pitch, tl, step.z_front))

    if p:
        return None, p

    if bores and drill is None and fallback and fallback.drill:
        fdia, fdepth = fallback.drill
        if fdia is not None:
            drill = (fdia, fdepth)
            notes.append(
                f"Drill D{fmt(fdia)} to depth {fmt(fdepth)} taken from {fallback.drill_source} "
                "(the drawing shows only the finished bore)."
            )
        elif fallback.hole_x is not None:
            drill = (fallback.hole_x, fdepth)
            notes.append(
                f"Drill to depth {fmt(fdepth)} as in {fallback.drill_source}; its size is not "
                f"written there, so the program treats the hole as X{fmt(fallback.hole_x)}, where "
                f"{fallback.program} faces inside it."
            )
    if bores and drill is None:
        drill = standard_drill(min(s.dia for s in bores), -bores[-1].z_back, length)
        if drill is not None:
            notes.append(
                f"Drill D{fmt(drill[0])} to depth {fmt(drill[1])}: standard choice, the drawing "
                f"shows only the finished bore (largest 0.5 mm drill leaving at least "
                f"{BORE_STOCK / 2:g} mm a side to bore). Check the drill on the machine."
            )

    # checks that need every number
    if (bar_given and bar <= 0) or length <= 0:
        p.append("Bar diameter and overall length must be above 0.")
    limit_x = bar if bar_given else (start_x or math.inf)
    for i, s in enumerate(od):
        if s.dia >= limit_x:
            p.append(f"OD {s.dia:g} is bigger than the bar ({bar:g}).")
        _check_corner(s, od[i - 1].dia if i else 0.0, "OD", p, external=True)
    if od and -od[-1].z_back > length + 1e-9:
        p.append(
            f"The OD lengths add up to {-od[-1].z_back:g}, more than the overall length {length:g}."
        )
    if bores:
        if drill is None:
            p.append("A bore needs a drill feature first (the hole to bore from).")
        else:
            if bores[-1].dia <= drill[0]:
                p.append("The smallest bore must be bigger than the drill.")
            if drill[1] < -bores[-1].z_back:
                p.append("The drill must be at least as deep as the deepest bore.")
        if od and bores[0].dia >= od[0].d0:
            p.append("The bore is not smaller than the front OD.")
        for i, s in enumerate(bores):
            outer = bores[i - 1].dia if i else (od[0].dia if od else limit_x)
            _check_corner(s, outer, "Bore", p, external=False)
    if drill and (drill[0] <= 0 or drill[1] <= 0):
        p.append("Drill diameter and depth must be above 0.")
    for g in grooves:
        z_front, z_back = -g.position, -(g.position + g.width)
        host = next((s for s in od if s.z_front >= z_front and s.z_back <= z_back), None)
        outside = host.dia if host else limit_x
        if g.width <= 0:
            p.append("Groove width must be above 0.")
        if g.dia >= outside:
            p.append(f"Groove diameter {g.dia:g} is not below the diameter it is cut in.")
        if g.position + g.width > length:
            p.append(f"Groove at {g.position:g} runs past the end of the part.")
    for t in threads:
        if t.pitch <= 0 or t.length <= 0:
            p.append(f"Thread {t.size}: pitch and length must be above 0.")
    geo = Geometry(material, bar, length, od, bores, drill, grooves, threads, notes, start_x)
    if back is not None:
        _check_back(back, geo, limit_x, p)
    if p:
        return None, p
    geo.back = back
    geo.part_off_end_x = fallback.part_off_end_x if fallback else None
    geo.hole_x = fallback.hole_x if fallback else None
    geo.max_turn_z = fallback.max_turn_z if fallback else None
    geo.max_turn_source = fallback.max_turn_source if fallback else ""
    return geo, []


def _check_back(b: BackSide, geo: Geometry, limit_x: float, p: list[str]) -> None:
    """The second clamping must fit the part the first clamping leaves."""
    for i, s in enumerate(b.od):
        if s.dia >= limit_x:
            p.append(f"Back OD {s.dia:g} is bigger than the bar.")
        _check_corner(s, b.od[i - 1].dia if i else 0.0, "back OD", p, external=True)
    if b.od and -b.od[-1].z_back > geo.length + 1e-9:
        p.append("The back OD lengths add up to more than the overall length.")
    if b.drill:
        if b.drill[0] <= 0 or b.drill[1] <= 0:
            p.append("Back drill diameter and depth must be above 0.")
        elif b.drill[1] > geo.length + 1e-9:
            p.append("The back drill is deeper than the part is long.")
    hole = b.drill[0] if b.drill else geo.through_hole()
    if b.bores:
        if hole is None:
            p.append(
                "A back bore needs a hole to start from: a drill in the second clamping, or a "
                "drill/bore through the whole part in the first."
            )
        elif b.bores[-1].dia < hole - 1e-9:
            p.append(f"The smallest back bore is smaller than the hole ({hole:g}) it starts from.")
        if -b.bores[-1].z_back > geo.length + 1e-9:
            p.append("A back bore is deeper than the part is long.")
        if b.od and b.bores[0].dia >= b.od[0].d0:
            p.append("The back bore is not smaller than the back OD.")
        for i, s in enumerate(b.bores):
            outer = b.bores[i - 1].dia if i else (b.od[0].dia if b.od else limit_x)
            _check_corner(s, outer, "back bore", p, external=False)


def _check_corner(s: Step, other: float, what: str, p: list[str], *, external: bool) -> None:
    room = abs(s.d0 - other) / 2  # shoulder height available for the corner
    span = s.z_front - s.z_back
    if s.corner.cone:
        mouth, ang, r = s.corner.cone
        inward = mouth > s.d0 if not external else mouth < s.d0
        if not inward:
            side = "bigger" if not external else "smaller"
            p.append(f"Cone on {what} {s.dia:g}: the mouth must be {side} than the {what}.")
        elif math.isfinite(ang):
            x1, z1, _, z2 = s.corner.cone_points(s.d0, s.z_front)
            if (x1 - mouth) * (s.d0 - mouth) < -1e-9:
                p.append(f"Cone on {what} {s.dia:g}: the blend radius R{r:g} is too big.")
            if s.z_front - z2 >= span:
                p.append(f"Cone on {what} {s.dia:g} is longer than the step it is on.")
            if (external and mouth < other) or (not external and mouth > other):
                p.append(f"Cone on {what} {s.dia:g}: the mouth D{mouth:g} runs past D{other:g}.")
    if s.corner.chamfer:
        ax, rad = s.corner.chamfer
        if rad >= room or ax >= span:
            p.append(f"Chamfer on {what} {s.dia:g} is bigger than the step it is on.")
    if s.corner.radius and (s.corner.radius >= room or s.corner.radius >= span):
        p.append(f"Radius on {what} {s.dia:g} is bigger than the step it is on.")


# ------------------------------------------------------------------ program text


def _corner_len(s: Step) -> float:
    """Axial length of the corner (chamfer / radius / cone) at the front of a step."""
    c = s.corner
    if c.chamfer:
        return c.chamfer[0]
    if c.radius:
        return c.radius
    if c.cone:
        return s.z_front - c.cone_points(s.d0, s.z_front)[3]
    return 0.0


def drawing_profile(geo: Geometry) -> dict[str, Any]:
    """The finished first-clamping shape, for the simulator's compare with the drawing.

    Z is program Z (front face 0, negative towards the chuck); diameters are the cut sizes
    (middle of tolerance). Corners are given as their axial length so the compare skips them.
    """

    def steps(ss: list[Step]) -> list[dict[str, float]]:
        return [
            {
                "dia": s.dia,
                "dia_front": s.d0,
                "z_front": s.z_front,
                "z_back": s.z_back,
                "corner": _corner_len(s),
            }
            for s in ss
        ]

    return {
        "length": geo.length,
        "od": steps(geo.od),
        "bores": steps(geo.bores),
        "drill": {"dia": geo.drill[0], "depth": geo.drill[1]} if geo.drill else None,
        "grooves": [
            {"dia": g.dia, "z_front": -g.position, "z_back": -(g.position + g.width)}
            for g in geo.grooves
        ],
        "threads": [
            {
                "major": t.major,
                "pitch": t.pitch,
                "z_front": t.z_start,
                "z_back": t.z_start - t.length,
            }
            for t in geo.threads
        ],
    }


def fmt(v: float) -> str:
    """FANUC number with a decimal point (parameter 3401 safe): 45.2, 0.0, -31.0."""
    s = f"{round(v, 3) + 0.0:.3f}".rstrip("0")
    if s.endswith("."):
        s += "0"
    return "0.0" if s in ("-0.0", "-0.") else s


def _comment(text: str) -> str:
    return re.sub(r"[^A-Z0-9 .,\-/+#*=&]", "", text.upper())[:60].strip()


@dataclass
class ToolInfo:
    tool_code: str
    tool_type: str
    description: str
    nose_radius: float | None


@dataclass
class Result:
    text: str | None
    problems: list[str]
    operations: list[dict[str, Any]]
    notes: list[str] = field(default_factory=list)


def generate(
    data: dict[str, Any],
    *,
    program_number: int,
    part_number: str,
    title: str,
    setup: dict[str, dict[str, Any]],
    tools: list[ToolInfo],
    rpm_max: int | None,
    table_ref: str = "",
    fallback: Fallback | None = None,
) -> Result:
    """Build the program. Returns the text, or problems listing exactly what is missing."""
    geo, problems = read_geometry(data, fallback)
    if not 1 <= program_number <= 9999:
        problems.append("Program number must be between 1 and 9999.")
    if geo is None:
        return Result(None, problems, [])

    general = setup.get("general", {})
    part_off_raw = general.get("part_off")
    part_off = None if part_off_raw in (None, "") else part_off_raw == "yes"
    if part_off is False:
        # A cut blank is held in the chuck: the OD can only be turned as far as the proven
        # program turns it in this clamping; the rest is the second clamping.
        if geo.max_turn_z is None and geo.od and -geo.od[-1].z_back >= geo.length - 1e-9:
            problems.append(
                "Cut blank: the OD runs the full length, but how far it can be turned before the "
                "chuck jaws is not known for this part. Turn it in two clampings."
            )
        elif geo.max_turn_z is not None:
            limit = -geo.max_turn_z
            full = bool(geo.od) and -geo.od[-1].z_back >= geo.length - 1e-9
            kept = [s for s in geo.od if s.z_front > limit + 1e-9]
            if kept and kept[-1].z_back < limit - 1e-9:
                k = kept[-1]
                kept[-1] = Step(k.dia_at(limit), k.z_front, limit, k.corner, k.nominal, k.front)
                geo.notes.append(
                    f"Cut blank held in the chuck: the OD is turned to Z{fmt(limit)} in this "
                    f"clamping, as in {geo.max_turn_source}; the rest is turned after turning the "
                    "part around (second clamping)."
                )
            geo.od = kept
            turned_back = -geo.back.od[-1].z_back if geo.back and geo.back.od else 0.0
            gap = geo.length + limit - turned_back  # limit is the (negative) Z turned to
            if full and gap > 1e-9:
                geo.notes.append(
                    f"{fmt(gap)} mm of the OD (Z{fmt(limit)} to Z{fmt(-(geo.length - turned_back))}"
                    " from the front) is turned in neither clamping. Check the blank size."
                )
    needed = geo.needed_ops(part_off)
    by_code = {t.tool_code: t for t in tools}
    vals: dict[str, dict[str, Any]] = {}
    for key in needed:
        spec = OP_BY_KEY[key]
        given = setup.get(key, {})
        v: dict[str, Any] = {}
        if spec.tool_types:
            code = str(given.get("tool_code") or "")
            tool = by_code.get(code)
            if not code:
                problems.append(f"{spec.label}: choose a tool.")
            elif tool is None:
                problems.append(f"{spec.label}: {code} is not in this machine's tool list.")
            elif tool.tool_type not in spec.tool_types:
                problems.append(
                    f"{spec.label}: {code} is a '{tool.tool_type}' tool, expected "
                    + " or ".join(spec.tool_types)
                    + "."
                )
            v["tool"] = tool
        for prm in spec.params:
            raw = given.get(prm.key)
            if raw is None or raw == "":
                problems.append(f"{spec.label}: {prm.label} not entered.")
                continue
            if prm.kind == "choice":
                if raw not in prm.choices:
                    problems.append(
                        f"{spec.label}: {prm.label} must be {' or '.join(prm.choices)}."
                    )
                    continue
                v[prm.key] = raw
                continue
            try:
                num = float(raw)
            except (TypeError, ValueError):
                problems.append(f"{spec.label}: {prm.label} must be a number.")
                continue
            if not math.isfinite(num) or num < 0 or (num == 0 and prm.key not in ZERO_OK):
                problems.append(f"{spec.label}: {prm.label} must be above 0.")
                continue
            if prm.kind == "int":
                if num != int(num):
                    problems.append(f"{spec.label}: {prm.label} must be a whole number.")
                    continue
                num = int(num)
            v[prm.key] = num
        if "rpm" in v and rpm_max is not None and v["rpm"] > rpm_max:
            problems.append(
                f"{spec.label}: {v['rpm']} rpm is above the machine maximum ({rpm_max} rpm)."
            )
        vals[key] = v
    if part_off is None:
        problems.append("General: Part off from bar at the end not entered.")
    if problems:
        return Result(None, problems, [])

    g = vals["general"]
    c = float(g["clearance"])
    if "rough" in vals and vals["rough"]["face_stock"] > c:
        problems.append("Clearance must be bigger than the stock on the front face.")
    back_stock = float(vals["back"]["face_stock"]) if geo.back else 0.0
    if back_stock > c:
        problems.append("Clearance must be bigger than the stock on the back face.")
    rough_tool: ToolInfo = vals["rough"]["tool"]
    back_hole = (geo.back.drill[0] if geo.back.drill else geo.through_hole()) if geo.back else 0.0
    if (geo.drill is None or back_hole is None) and rough_tool.nose_radius is None:
        problems.append(
            f"Enter the nose radius of {rough_tool.tool_code} on the Machines page "
            "(needed to face past the centre)."
        )
    if geo.back and geo.back.bores and back_hole is not None and back_hole - 2 * c <= 0:
        problems.append("The hole is too small to enter with the boring bar from the back.")
    for key in ("groove", "part"):
        if key in vals and vals[key]["width"] <= 0:
            problems.append(f"{OP_BY_KEY[key].label}: width must be above 0.")
    for gr in geo.grooves:
        if "groove" in vals and vals["groove"]["width"] > gr.width + 1e-9:
            problems.append(
                f"The groove insert ({vals['groove']['width']:g}) is wider than the "
                f"{gr.width:g} groove."
            )
    if "bore" in vals and geo.drill and geo.drill[0] - 2 * c <= 0:
        problems.append("The drill is too small to enter with the boring bar at this clearance.")
    if problems:
        return Result(None, problems, [])

    w = _Writer(c, g["spindle_direction"])
    # start X, outside the bar (or a proven clear X when the bar size is unknown)
    xs = geo.bar + 2 * c if geo.start_x is None else geo.start_x
    w.raw("%")
    w.raw(f"O{program_number:04d}({_comment(part_number + ' ' + title)})")
    w.raw("(GENERATED FROM THE CONFIRMED FEATURE TABLE)")
    if table_ref:
        w.raw(f"(TABLE {_comment(table_ref)})")
    bar_txt = f"BAR D{fmt(geo.bar)}" if geo.start_x is None else "BAR SIZE NOT ENTERED"
    w.raw(f"(MATERIAL {_comment(geo.material)} {bar_txt} PART L{fmt(geo.length)})")
    w.raw("(Z0 = FINISHED FRONT FACE. CHECK TOOL OFFSETS BEFORE RUNNING)")
    header_end = len(w.lines)

    ops: list[dict[str, Any]] = []

    if geo.drill:
        d = vals["drill"]
        w.tool_start(d["tool"], d["rpm"], f"G0X0.0Z{fmt(c)}")
        w.raw(f"G74R{fmt(d['retract'])}")
        w.raw(f"G74Z{fmt(-geo.drill[1])}Q{round(d['peck'] * 1000)}F{fmt(d['feed'])}")
        w.raw(f"G0Z{fmt(c)}")
        w.tool_end()
        ops.append(_op("drill", d, f"Drill D{fmt(geo.drill[0])} to Z{fmt(-geo.drill[1])}"))

    r = vals["rough"]
    face_end = (
        geo.drill[0] - 2 * (rough_tool.nose_radius or 0.0)
        if geo.drill
        else -2 * (rough_tool.nose_radius or 0.0)
    )
    if geo.drill and geo.hole_x is not None and geo.hole_x < face_end:
        face_end = geo.hole_x  # where the proven program faces to: inside the hole
    w.tool_start(r["tool"], r["rpm"], f"G0X{fmt(xs)}Z{fmt(c)}")
    stock = float(r["face_stock"])
    passes = max(1, math.ceil(stock / r["depth_of_cut"] - 1e-9)) if stock > 0 else 1
    for i in range(passes):
        z = stock - (i + 1) * stock / passes if stock > 0 else 0.0
        w.raw(f"G0Z{fmt(z)}")
        w.raw(f"G1X{fmt(face_end)}F{fmt(r['feed'])}")
        w.raw(f"G0X{fmt(xs)}Z{fmt(c)}")
    ops.append(_op("rough", r, f"Face to Z0.0 in {passes} pass(es) to X{fmt(face_end)}"))
    if geo.od:
        fin = vals["finish"]
        p, q = 100, 199
        w.raw(f"G71U{fmt(r['depth_of_cut'])}R{fmt(r['retract'])}")
        w.raw(f"G71P{p}Q{q}U{fmt(r['finish_allow_x'])}W{fmt(r['finish_allow_z'])}F{fmt(r['feed'])}")
        _profile(w, geo.od, p, q, xs, fin["feed"], external=True)
        w.raw(f"G0X{fmt(xs)}Z{fmt(c)}")
        w.tool_end()
        ops[-1]["summary"] += f"; rough OD profile N{p}-N{q}"
        w.tool_start(fin["tool"], fin["rpm"], f"G0X{fmt(xs)}Z{fmt(2 * c)}")
        w.raw(f"G42G0X{fmt(xs)}Z{fmt(c)}")
        w.raw(f"G70P{p}Q{q}")
        w.raw(f"G40G0X{fmt(xs)}Z{fmt(2 * c)}")
        w.tool_end()
        ops.append(_op("finish", fin, f"Finish OD profile N{p}-N{q}"))
    else:
        w.tool_end()

    if geo.bores and geo.drill:
        b = vals["bore"]
        xi = geo.drill[0] - 2 * c
        p, q = 300, 399
        w.tool_start(b["tool"], b["rpm"], f"G0X{fmt(xi)}Z{fmt(c)}")
        w.raw(f"G71U{fmt(b['depth_of_cut'])}R{fmt(b['retract'])}")
        w.raw(
            f"G71P{p}Q{q}U{fmt(-b['finish_allow_x'])}W{fmt(b['finish_allow_z'])}F{fmt(b['feed'])}"
        )
        _profile(w, geo.bores, p, q, xi, b["finish_feed"], external=False)
        w.raw(f"G0X{fmt(xi)}Z{fmt(2 * c)}")
        w.raw(f"G41G0X{fmt(xi)}Z{fmt(c)}")
        w.raw(f"G70P{p}Q{q}")
        w.raw(f"G40G0X{fmt(xi)}Z{fmt(2 * c)}")
        w.tool_end()
        ops.append(_op("bore", b, f"Rough and finish bore profile N{p}-N{q}"))

    if geo.grooves:
        gv = vals["groove"]
        w.tool_start(gv["tool"], gv["rpm"], f"G0X{fmt(xs)}Z{fmt(c)}")
        for gr in geo.grooves:
            for z in _plunges(-gr.position, gr.width, gv["width"], gv["ref_edge"]):
                w.raw(f"G0Z{fmt(z)}")
                w.raw(f"G1X{fmt(gr.dia)}F{fmt(gv['feed'])}")
                w.raw(f"G0X{fmt(xs)}")
        w.raw(f"G0Z{fmt(c)}")
        w.tool_end()
        ops.append(_op("groove", gv, f"{len(geo.grooves)} groove(s)"))

    if geo.threads:
        tv = vals["thread"]
        w.tool_start(tv["tool"], tv["rpm"], f"G0X{fmt(xs)}Z{fmt(c)}")
        for t in geo.threads:
            h = round(0.61343 * t.pitch, 3)  # ISO 68-1 external thread depth
            minor = t.major - 2 * h
            w.raw(f"G0X{fmt(t.major + 2 * c)}Z{fmt(t.z_start + c)}")
            w.raw(
                f"G76P{int(tv['finish_passes']):02d}0060Q{round(tv['min_depth'] * 1000)}"
                f"R{fmt(tv['finish_allowance'])}"
            )
            w.raw(
                f"G76X{fmt(minor)}Z{fmt(t.z_start - t.length)}P{round(h * 1000)}"
                f"Q{round(tv['first_depth'] * 1000)}F{fmt(t.pitch)}"
            )
        w.raw(f"G0X{fmt(xs)}Z{fmt(c)}")
        w.tool_end()
        ops.append(_op("thread", tv, ", ".join(f"{t.size}x{fmt(t.pitch)}" for t in geo.threads)))

    if part_off:
        pv = vals["part"]
        zp = -(geo.length + back_stock) - (pv["width"] if pv["ref_edge"] == "left" else 0.0)
        w.tool_start(pv["tool"], pv["rpm"], f"G0X{fmt(xs)}Z{fmt(c)}")
        w.raw(f"G0Z{fmt(zp)}")
        end_x = geo.part_off_end_x if geo.part_off_end_x is not None else 0.0
        w.raw(f"G1X{fmt(end_x)}F{fmt(pv['feed'])}")
        w.raw(f"G0X{fmt(xs)}")
        w.raw(f"G0Z{fmt(c)}")
        w.tool_end()
        left = f" + {fmt(back_stock)} for facing the back" if back_stock else ""
        ops.append(_op("part", pv, f"Part off at length {fmt(geo.length)}{left}"))

    w.raw("M05")
    w.raw("M09")
    w.raw("M30")
    if geo.back:
        start_n = w.n + 1
        w.lines.insert(header_end, "(1ST OPN)")
        w.lines.insert(
            header_end,
            f"(AFTER M30: TURN THE PART AROUND, SET Z0 ON THE FINISHED BACK FACE, SEARCH "
            f"N{start_n})",
        )
        _second_clamping(w, geo, vals, xs, c, back_stock, ops)
        w.raw("M05")
        w.raw("M09")
        w.raw("M30")
    w.raw("%")
    return Result(w.text(), [], ops, list(geo.notes))


def _second_clamping(
    w: "_Writer",
    geo: Geometry,
    vals: dict[str, dict[str, Any]],
    xs: float,
    c: float,
    stock: float,
    ops: list[dict[str, Any]],
) -> None:
    """Part turned around: Z0 = finished back face. Same tools and values as the first side.

    It starts from what the first clamping left at this end: the finished OD (or the bar) and
    the finished hole. Where only a chamfer, radius or cone is left to cut (no deeper than one
    roughing cut), the finishing tool cuts it in one pass, as the proven programs do.
    """
    b = geo.back
    assert b is not None
    w.raw("(2ND OPN - PART TURNED AROUND, Z0 = FINISHED BACK FACE)")
    hole = b.drill[0] if b.drill else geo.through_hole()
    turned_full = bool(geo.od) and -geo.od[-1].z_back >= geo.length - 1e-9
    top = geo.od[-1].dia if turned_full else xs - 2 * c  # OD at this end after the 1st side
    xo = top + 2 * c
    if b.drill:
        d = vals["drill"]
        w.tool_start(d["tool"], d["rpm"], f"G0X0.0Z{fmt(c)}")
        w.raw(f"G74R{fmt(d['retract'])}")
        w.raw(f"G74Z{fmt(-b.drill[1])}Q{round(d['peck'] * 1000)}F{fmt(d['feed'])}")
        w.raw(f"G0Z{fmt(c)}")
        w.tool_end()
        ops.append(_op("drill", d, f"2nd side: drill D{fmt(b.drill[0])} to Z{fmt(-b.drill[1])}"))

    r = vals["rough"]
    nose = r["tool"].nose_radius or 0.0
    face_end = hole - 2 * nose if hole is not None else -2 * nose
    if hole is not None and not b.drill and geo.hole_x is not None and geo.hole_x < face_end:
        face_end = geo.hole_x  # the proven program faces to here: inside the hole
    w.tool_start(r["tool"], r["rpm"], f"G0X{fmt(xo)}Z{fmt(c)}")
    passes = max(1, math.ceil(stock / r["depth_of_cut"] - 1e-9)) if stock > 0 else 1
    for i in range(passes):
        z = stock - (i + 1) * stock / passes if stock > 0 else 0.0
        w.raw(f"G0Z{fmt(z)}")
        w.raw(f"G1X{fmt(face_end)}F{fmt(r['feed'])}")
        w.raw(f"G0X{fmt(xo)}Z{fmt(c)}")
    summary = f"2nd side: face {fmt(stock)} to length in {passes} pass(es)"
    od_light = bool(b.od) and (top - min(_starts(b.od, True))) / 2 <= r["depth_of_cut"] + 1e-9
    if b.od and not od_light:
        p, q = 500, 599
        w.raw(f"G71U{fmt(r['depth_of_cut'])}R{fmt(r['retract'])}")
        w.raw(f"G71P{p}Q{q}U{fmt(r['finish_allow_x'])}W{fmt(r['finish_allow_z'])}F{fmt(r['feed'])}")
        _profile(w, b.od, p, q, xo, vals["finish"]["feed"], external=True)
        w.raw(f"G0X{fmt(xo)}Z{fmt(c)}")
        summary += f"; rough back OD N{p}-N{q}"
    w.tool_end()
    ops.append(_op("rough", r, summary))
    if b.od:
        fin = vals["finish"]
        w.tool_start(fin["tool"], fin["rpm"], f"G0X{fmt(xo)}Z{fmt(2 * c)}")
        w.raw(f"G42G0X{fmt(xo)}Z{fmt(c)}")
        if od_light:
            _profile(w, b.od, 500, 599, xo, fin["feed"], external=True)
        else:
            w.raw("G70P500Q599")
        w.raw(f"G40G0X{fmt(xo)}Z{fmt(2 * c)}")
        w.tool_end()
        how = "in one pass (only the corner is left)" if od_light else "N500-N599"
        ops.append(_op("finish", fin, f"2nd side: finish back OD {how}"))

    if b.bores and hole is not None:
        bv = vals["bore"]
        xi = hole - 2 * min(c, 1.0)  # inside the finished hole
        light = (max(_starts(b.bores, False)) - hole) / 2 <= bv["depth_of_cut"] + 1e-9
        p, q = 700, 799
        w.tool_start(bv["tool"], bv["rpm"], f"G0X{fmt(xi)}Z{fmt(c)}")
        if light:
            w.raw(f"G41G0X{fmt(xi)}Z{fmt(c)}")
            _profile(w, b.bores, p, q, xi, bv["finish_feed"], external=False)
        else:
            w.raw(f"G71U{fmt(bv['depth_of_cut'])}R{fmt(bv['retract'])}")
            w.raw(
                f"G71P{p}Q{q}U{fmt(-bv['finish_allow_x'])}W{fmt(bv['finish_allow_z'])}"
                f"F{fmt(bv['feed'])}"
            )
            _profile(w, b.bores, p, q, xi, bv["finish_feed"], external=False)
            w.raw(f"G0X{fmt(xi)}Z{fmt(2 * c)}")
            w.raw(f"G41G0X{fmt(xi)}Z{fmt(c)}")
            w.raw(f"G70P{p}Q{q}")
        w.raw(f"G40G0X{fmt(xi)}Z{fmt(2 * c)}")
        w.tool_end()
        how = (
            "finish in one pass (only the corner is left)"
            if light
            else f"rough and finish N{p}-N{q}"
        )
        ops.append(_op("bore", bv, f"2nd side: back bore, {how}"))


def _starts(steps: list[Step], external: bool) -> list[float]:
    """Every diameter the profile reaches, corners included."""
    sign = 1 if external else -1
    out: list[float] = []
    for s in steps:
        out += [s.dia, s.d0]
        if s.corner.chamfer:
            out.append(s.d0 - sign * 2 * s.corner.chamfer[1])
        if s.corner.radius:
            out.append(s.d0 - sign * 2 * s.corner.radius)
        if s.corner.cone:
            out.append(s.corner.cone[0])
    return out


def _op(key: str, v: dict[str, Any], summary: str) -> dict[str, Any]:
    tool: ToolInfo | None = v.get("tool")
    return {
        "key": key,
        "label": OP_BY_KEY[key].label,
        "tool_code": tool.tool_code if tool else None,
        "rpm": v.get("rpm"),
        "summary": summary,
    }


def _plunges(z_front: float, width: float, insert: float, ref: str) -> list[float]:
    """Z positions of the insert's offset edge for each plunge, front first."""
    n = max(1, math.ceil(width / insert - 1e-9))
    first_right = z_front
    last_right = z_front - width + insert
    rights = (
        [first_right]
        if n == 1
        else [first_right + (last_right - first_right) * k / (n - 1) for k in range(n)]
    )
    return [e - insert if ref == "left" else e for e in rights]


def _profile(
    w: "_Writer",
    steps: list[Step],
    p: int,
    q: int,
    x_exit: float,
    feed: float,
    *,
    external: bool,
) -> None:
    """Finished contour between N p and N q (G71 type I: first block moves X only)."""
    sign = 1 if external else -1  # corners cut in from the outside (OD) or the inside (bore)
    arc = "G3" if external else "G2"

    def corner_start(s: Step) -> float:
        if s.corner.chamfer:
            return s.d0 - sign * 2 * s.corner.chamfer[1]
        if s.corner.radius:
            return s.d0 - sign * 2 * s.corner.radius
        if s.corner.cone:
            return s.corner.cone[0]
        return s.d0

    w.raw(f"N{p}G0X{fmt(corner_start(steps[0]))}")
    w.raw(f"G1Z{fmt(steps[0].z_front)}F{fmt(feed)}")
    for i, s in enumerate(steps):
        if i:
            w.raw(f"G1X{fmt(corner_start(s))}")
        if s.corner.chamfer:
            z = s.z_front - s.corner.chamfer[0]
            w.raw(f"G1X{fmt(s.dia_at(z))}Z{fmt(z)}")
        elif s.corner.radius:
            r = s.corner.radius
            w.raw(f"{arc}X{fmt(s.dia_at(s.z_front - r))}Z{fmt(s.z_front - r)}R{fmt(r)}")
        elif s.corner.cone:
            x1, z1, x2, z2 = s.corner.cone_points(s.d0, s.z_front)
            blend = s.corner.cone[2]
            if blend > 0:
                w.raw(f"G1X{fmt(x1)}Z{fmt(z1)}")
                w.raw(f"{arc}X{fmt(x2)}Z{fmt(z2)}R{fmt(blend)}")
            else:
                w.raw(f"G1X{fmt(x2)}Z{fmt(z2)}")
        if s.front is None:
            w.raw(f"G1Z{fmt(s.z_back)}")
        else:  # taper: one straight line to the end diameter
            w.raw(f"G1X{fmt(s.dia)}Z{fmt(s.z_back)}")
    w.raw(f"N{q}G1X{fmt(x_exit)}")


class _Writer:
    def __init__(self, clearance: float, spindle: str) -> None:
        self.lines: list[str] = []
        self.n = 0
        self.c = clearance
        self.spindle = spindle

    def raw(self, line: str) -> None:
        self.lines.append(line)

    def tool_start(self, tool: ToolInfo, rpm: int, approach: str) -> None:
        self.n += 1
        label = _comment(tool.description) or tool.tool_type.upper().replace("_", " ")
        self.raw(f"N{self.n}({label})")
        self.raw("G28U0W0")
        self.raw(f"G97S{int(rpm)}{self.spindle}")
        self.raw(tool.tool_code)
        self.raw(f"{approach}M8")

    def tool_end(self) -> None:
        self.raw("G28U0W0")
        self.raw("M01")

    def text(self) -> str:
        return "\n".join(self.lines) + "\n"
