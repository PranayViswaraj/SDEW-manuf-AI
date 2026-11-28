"""Non-turned features as geometry: parsed from the reader's JSON text, checked, kept with the
table, and drawn in the 3D model (3216C11701: a tube with a saddle-cut end and a tapered cross
hole, seen in the isometric view)."""

import json
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai.claude_reader import completeness
from app.ai.solid import parse_solid, solid_gaps
from app.services.feature_tables import TableData, normalise
from tests.conftest import UserFactory
from tests.test_claude_reader import ALL_OK, PDF, FakeClient, extraction, reader

# 3216C11701: tube Ø25/Ø19 x 50, back end cut by an R15.5 cylinder (deepest at 41 from the
# front), tapered cross hole Ø16.5/Ø19.5 (7°) 15 from the back face.
SLEEVE_SOLID = [
    {
        "kind": "saddle",
        "radius": 15.5,
        "end": "back",
        "z": 41.0,
        "angle": 90,
        "evidence": "main view: R15.5 end, 41 and 50 from the front face",
    },
    {
        "kind": "cross_hole",
        "z": 35.0,
        "diameter": 16.5,
        "diameter_end": 19.5,
        "angle": 0,
        "through": False,
        "depth": 3.0,
        "evidence": "SECTION A-A: Ø16.5/Ø19.5 7°±1°, 15 from the back face",
    },
]


def with_solid(solid: Any, non_turned: list[str] | None = None) -> dict[str, Any]:
    e = extraction()
    e["drawing"]["shape_3d"] = {
        "summary": "Tube with a saddle-cut end and a tapered cross hole",
        "max_diameter": 25.0,
        "length": 62.0,
        "ends": ["front: flat, chamfer", "back: saddle R15.5"],
        "non_turned": non_turned if non_turned is not None else ["saddle R15.5", "cross hole"],
        "solid": solid,
    }
    return e


def test_parse_keeps_only_well_formed_features() -> None:
    raw = json.dumps(
        [
            *SLEEVE_SOLID,
            {"kind": "teleporter", "z": 1},  # unknown kind
            {"kind": "flat", "z_from": 2, "z_to": 8, "depth": -1, "count": 999, "end": "side"},
            "not an object",
        ]
    )
    feats = parse_solid(raw)
    assert [f["kind"] for f in feats] == ["saddle", "cross_hole", "flat"]
    flat = feats[2]
    assert flat["depth"] is None and flat["count"] == 1 and flat["end"] is None
    assert feats[1]["through"] is False and feats[1]["diameter_end"] == 19.5
    assert parse_solid("not json") == [] and parse_solid("") == [] and parse_solid(None) == []
    assert parse_solid({"features": SLEEVE_SOLID})[0]["kind"] == "saddle"


def test_gaps_name_what_a_feature_lacks_or_where_it_is_outside_the_part() -> None:
    assert solid_gaps(with_solid(SLEEVE_SOLID)) == []
    bad = [
        {"kind": "saddle", "radius": 15.5, "z": 70.0},  # no end, beyond the 62 mm part
        {"kind": "hex", "z_from": 0, "z_to": 10},  # no across_flats
    ]
    gaps = solid_gaps(with_solid(bad, ["saddle", "hex", "cross hole"]))
    text = " | ".join(gaps)
    assert "3 non-turned features are named" in text and "only 2" in text
    assert "say which end" in text and "z 70 mm is outside the part" in text
    assert "no across_flats" in text


def test_solid_is_kept_with_the_table_and_listed_for_the_engineer_when_incomplete() -> None:
    first = with_solid(json.dumps(SLEEVE_SOLID))
    round1 = {
        "verdict": "accept",
        "checks": ALL_OK,
        "corrected": json.dumps(with_solid(json.dumps(SLEEVE_SOLID[:1]))),  # lost the hole
        "callouts": [],
        "questions_for_engineer": [],
    }
    fake = FakeClient([first, round1])
    result = reader(fake).read_report(PDF, "3216C11701.pdf", "3216C11701")
    assert len(fake.calls) == 2  # an incomplete 3D model alone costs no second round
    assert [f.kind for f in result.table.solid] == ["saddle"]
    assert result.table.solid[0].end == "back" and result.table.solid[0].radius == 15.5
    assert any("3D model:" in x and "only 1" in x for x in result.notes["unaccounted"])
    assert result.notes["shape_3d"]["solid"][0]["kind"] == "saddle"
    # agent 2 was told what the first reader's geometry lacks only when it lacked something
    assert "Non-turned features" not in fake.calls[1]["messages"][0]["content"][-1]["text"]


def test_round_one_is_told_what_the_geometry_lacks() -> None:
    first = with_solid(json.dumps([{"kind": "cross_hole", "diameter": 6.0}]), ["Ø6 cross hole"])
    gaps = completeness(first, None, [])
    assert gaps.solid and not gaps.serious()
    assert "no z" in gaps.message(first_round=True)


def test_normalise_keeps_the_solid() -> None:
    data = TableData.model_validate(
        {"header": {}, "features": [], "solid": parse_solid(SLEEVE_SOLID)}
    )
    out = normalise(data)
    assert [f["kind"] for f in out["solid"]] == ["saddle", "cross_hole"]
    assert "solid" not in normalise(TableData())


def test_a_face_groove_needs_its_diameters_depth_and_end() -> None:
    """3227C07701: the O-ring groove in the flange face (DETAIL-B 2:1) is a face groove."""
    ok = [
        {
            "kind": "face_groove",
            "end": "back",
            "diameter": 31.88,
            "diameter_end": 24.0,
            "depth": 2.79,
            "evidence": "DETAIL-B: 2.79 +0.13 deep, 3.94 +0.51 wide; Ø31.88 - 2 x 3.94 = Ø24.00",
        }
    ]
    assert solid_gaps(with_solid(ok, ["face groove"])) == []
    assert parse_solid(ok)[0]["kind"] == "face_groove"
    bad = [{"kind": "face_groove", "diameter": 31.88}]
    text = " | ".join(solid_gaps(with_solid(bad, ["face groove"])))
    assert "no diameter_end or width" in text and "no depth" in text
    assert "say which end" in text


def test_saving_the_rows_never_erases_the_ais_3d_features(
    client: TestClient, db: Session, make_user: UserFactory
) -> None:
    """3227C07701: the face groove vanished after "Tick all" (the page saved the rows only)."""
    from app.db.models import FeatureTable, Role
    from tests.conftest import headers_for

    eng = headers_for(make_user(Role.ENGINEER))
    tid = client.post(
        "/api/feature-tables", json={"part_number": "3227C07701"}, headers=eng
    ).json()["id"]
    ft = db.get(FeatureTable, tid)
    assert ft is not None
    groove = parse_solid(
        [
            {
                "kind": "face_groove",
                "end": "back",
                "diameter": 31.88,
                "diameter_end": 24,
                "depth": 2.79,
            }
        ]
    )
    contour = {"outer": [{"z": 0, "d": 22.22, "segment": "start"}], "inner": []}
    ft.data = normalise(TableData.model_validate({**ft.data, "solid": groove, "contour": contour}))
    db.commit()
    rows = {k: v for k, v in ft.data.items() if k in ("header", "features")}
    r = client.put(f"/api/feature-tables/{tid}", json={"data": rows}, headers=eng)
    assert r.status_code == 200, r.text
    assert [f["kind"] for f in r.json()["data"]["solid"]] == ["face_groove"]
    assert r.json()["data"]["contour"]["outer"][0]["d"] == 22.22
