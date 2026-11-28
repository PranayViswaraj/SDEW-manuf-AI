"""The part's non-turned features as geometry (the 3D model beyond the revolved profile).

The reader sends them as JSON text in drawing.shape_3d.solid (a strict schema for them would make
the API's compiled output grammar too large). Code parses every feature, keeps only well-formed
numbers, and lists what a feature still lacks for the engineer; nothing is forced or invented.

Coordinates: z in mm from the FRONT face (Z0 of the first clamping) toward the back face, as in the
point contour; angle = position around the axis in degrees, 0 at the top of the front view.
"""

import json
from typing import Any

SOLID_KINDS = (
    "cross_hole",  # radial hole through the wall (or blind): diameter, z; tapered: diameter_end
    "saddle",  # end cut by a cylinder at right angles (pipe joint): radius, z of the deepest point
    "flat",  # flat(s) on the outside: z_from, z_to and depth (or across_flats for two)
    "hex",  # hexagon: across_flats, z_from, z_to
    "square",  # square: across_flats, z_from, z_to
    "slot",  # slot across or along the part: width, depth, z_from, z_to
    "keyway",  # keyway: width, depth, z_from, z_to
    "face_hole",  # axial hole(s) in an end face off the axis: diameter, pcd, count, end
    "face_groove",  # annular groove / recess in an end face (O-ring groove): outer diameter,
    # inner diameter (diameter_end) or radial width, axial depth, end
    "knurl",  # knurled band: z_from, z_to
    "spline",  # splined band: z_from, z_to
    "other",  # anything else (described in evidence)
)
NUMBERS = (
    "z",
    "z_from",
    "z_to",
    "diameter",
    "diameter_end",
    "width",
    "depth",
    "radius",
    "across_flats",
    "pcd",
    "angle",
    "tilt",
)
REQUIRED: dict[str, tuple[tuple[str, ...], ...]] = {
    # each inner tuple: at least one of these must be given
    "cross_hole": (("z",), ("diameter",)),
    "saddle": (("z",), ("radius",)),
    "flat": (("z_from",), ("z_to",), ("depth", "across_flats")),
    "hex": (("z_from",), ("z_to",), ("across_flats",)),
    "square": (("z_from",), ("z_to",), ("across_flats",)),
    "slot": (("z_from",), ("z_to",), ("width",), ("depth",)),
    "keyway": (("z_from",), ("z_to",), ("width",), ("depth",)),
    "face_hole": (("diameter",), ("pcd",)),
    "face_groove": (("diameter",), ("diameter_end", "width"), ("depth",)),
    "knurl": (("z_from",), ("z_to",)),
    "spline": (("z_from",), ("z_to",)),
    "other": (),
}
MAX_FEATURES = 60


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    v = float(v)
    return v if -10000 <= v <= 10000 else None


def parse_solid(raw: Any) -> list[dict[str, Any]]:
    """The non-turned features (JSON text, a list or {"features": [...]}), cleaned."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw.strip() else []
        except json.JSONDecodeError:
            raw = []
    if isinstance(raw, dict):
        raw = raw.get("features") or []
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for f in raw[:MAX_FEATURES]:
        if not isinstance(f, dict) or f.get("kind") not in SOLID_KINDS:
            continue
        item: dict[str, Any] = {"kind": f["kind"]}
        for key in NUMBERS:
            item[key] = _num(f.get(key))
        for key in ("diameter", "diameter_end", "width", "depth", "radius", "across_flats", "pcd"):
            if item[key] is not None and item[key] <= 0:
                item[key] = None
        count = f.get("count")
        item["count"] = (
            int(count)
            if isinstance(count, int) and not isinstance(count, bool) and 0 < count <= 72
            else 1
        )
        item["through"] = f.get("through") is not False
        item["end"] = f.get("end") if f.get("end") in ("front", "back") else None
        item["evidence"] = str(f.get("evidence") or "")[:200]
        out.append(item)
    return out


def solid_gaps(answer: dict[str, Any]) -> list[str]:
    """What the non-turned features still lack, or where they fall outside the part."""
    shape = (answer.get("drawing") or {}).get("shape_3d") or {}
    feats = parse_solid(shape.get("solid"))
    out: list[str] = []
    listed = [x for x in shape.get("non_turned") or [] if str(x).strip()]
    if len(listed) > len(feats):
        out.append(
            f"{len(listed)} non-turned features are named in shape_3d.non_turned but only "
            f"{len(feats)} are given as geometry in shape_3d.solid."
        )
    length = _num(((answer.get("header") or {}).get("overall_length") or {}).get("v"))
    for i, f in enumerate(feats, 1):
        what = f"Non-turned feature {i} ({f['kind']})"
        missing = [
            " or ".join(alts) for alts in REQUIRED[f["kind"]] if all(f[a] is None for a in alts)
        ]
        if missing:
            out.append(f"{what}: no {'; no '.join(missing)}.")
        if f["kind"] in ("saddle", "face_groove", "face_hole") and f["end"] is None:
            out.append(f"{what}: say which end (front or back) is cut.")
        if length is not None:
            for key in ("z", "z_from", "z_to"):
                v = f[key]
                if v is not None and not (-0.01 <= v <= length + 0.01):
                    out.append(f"{what}: {key} {v:g} mm is outside the part (0 to {length:g}).")
    return out[:20]
