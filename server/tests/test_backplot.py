"""Backplot: all trusted samples render; geometry of moves and cycles is right."""

import math

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import Program
from app.gcode.backplot import Backplot, backplot, stock_outline
from app.seed import run_seed
from tests.conftest import REPO_DIR

SAMPLES = REPO_DIR / "samples" / "programs"


def sample(name: str) -> str:
    return (SAMPLES / name).read_bytes().decode("ascii")


def prog(*lines: str) -> str:
    return "%\nO1000(TEST)\n" + "\n".join(lines) + "\nM30\n%"


def feeds(bp: Backplot) -> list[list[tuple[float, float]]]:
    return [
        [(round(z, 3), round(r, 3)) for z, r in s.points] for s in bp.segments if s.kind == "feed"
    ]


@pytest.mark.parametrize("name", ["O0001", "O0002", "O0003", "O0004", "O0009"])
def test_all_trusted_samples_render(name: str) -> None:
    bp = backplot(sample(name))
    d = bp.to_dict()
    assert len(bp.segments) > 50
    assert d["bounds"] is not None and d["bounds"]["z_min"] < -20
    assert len(bp.tools) >= 3
    # nothing failed to expand
    assert not any("not drawn" in w["message"] for w in bp.warnings), bp.warnings
    # every segment points back to a real block
    lines = {b["line"] for b in d["blocks"]}
    assert all(s.line in lines for s in bp.segments)


def test_rapid_dashed_feed_solid_and_tools() -> None:
    bp = backplot(prog("T0101", "G0X40.0Z2.0", "G1Z-10.0F0.2", "T0202", "G0X50.0Z5.0", "G1X40.0"))
    kinds = [(s.kind, s.tool) for s in bp.segments]
    assert kinds == [("feed", 1), ("rapid", 2), ("feed", 2)]
    assert feeds(bp)[0] == [(2.0, 20.0), (-10.0, 20.0)]  # X is a diameter -> radius 20


def test_incremental_u_w() -> None:
    bp = backplot(prog("G0X40.0Z2.0", "G1U-4.0W-3.0F0.1"))
    assert feeds(bp)[0] == [(2.0, 20.0), (-1.0, 18.0)]


def test_g28_makes_position_unknown() -> None:
    bp = backplot(prog("G0X40.0Z2.0", "G28U0W0", "G0X30.0", "Z1.0", "G1Z-5.0"))
    # The first move starts from an unknown position (nothing drawn). After G28 the X-only and
    # Z moves only set the position again; only the final G1 is drawn.
    assert [s.kind for s in bp.segments] == ["feed"]
    assert feeds(bp)[0] == [(1.0, 15.0), (-5.0, 15.0)]


def test_angle_moves_match_trusted_samples() -> None:
    # O0001: X43.32 -> X44.7 at A165: dz = 0.69 / sin(165) * cos(165) = -2.575
    bp = backplot(prog("G0X43.32Z0.0", "G1X44.7A165.0F0.1"))
    (_, _), (z1, r1) = feeds(bp)[0]
    assert r1 == pytest.approx(22.35)
    assert z1 == pytest.approx(-2.575, abs=1e-3)
    # O0004: Z-8.8 -> Z-8.0 at A315 from X39.05: radius drops by 0.8
    bp = backplot(prog("G0X39.05Z-8.8", "G1Z-8.0A315.0F0.05"))
    assert feeds(bp)[0][-1] == (-8.0, pytest.approx(19.525 - 0.8, abs=1e-3))
    # bore chamfer A225 going inward and deeper
    bp = backplot(prog("G0X32.5Z0.05", "G1A225.0X30.05F0.1"))
    z_end = feeds(bp)[0][-1][0]
    assert z_end == pytest.approx(0.05 - 1.225, abs=1e-3)


def test_arc_with_r_matches_sample_geometry() -> None:
    # From O0002: G1X24.774Z-3.022 then G02X24.0Z-4.33R2.4 (bore entry radius)
    bp = backplot(prog("G0X24.774Z-3.022", "G02X24.0Z-4.33R2.4F0.1"))
    arc = feeds(bp)[0]
    assert arc[0] == (-3.022, 12.387) and arc[-1] == (-4.33, 12.0)
    centre = (-4.33, 14.4)
    for z, r in arc:
        assert math.hypot(z - centre[0], r - centre[1]) == pytest.approx(2.4, abs=2e-3)


def test_arc_with_ik() -> None:
    bp = backplot(prog("G0X20.0Z0.0", "G3X30.0Z-5.0I0.0K-5.0F0.1"))
    arc = feeds(bp)[0]
    for z, r in arc:
        assert math.hypot(z - (-5.0), r - 10.0) == pytest.approx(5.0, abs=2e-3)


def test_g71_rough_passes_from_o0004() -> None:
    bp = backplot(sample("O0004"))
    rough = [s for s in bp.segments if s.cycle and s.line == 31 and s.kind == "feed"]
    assert rough[0].points == [(2.0, 20.0), (-13.5, 20.0)]  # one pass at R20 down to the shoulder
    contour = rough[-1].points
    assert contour[0] == (2.0, 21.0) and (-13.5, 19.7) in [
        (round(z, 3), round(r, 3)) for z, r in contour
    ]


def test_g72_facing_passes_from_o0004() -> None:
    bp = backplot(sample("O0004"))
    passes = [s.points for s in bp.segments if s.cycle and s.line == 25 and s.kind == "feed"]
    assert passes[0] == [(1.0, 24.0), (1.0, 14.0)]
    assert passes[1] == [(0.5, 24.0), (0.5, 14.0)]


def test_g74_pecks_in_microns() -> None:
    bp = backplot(prog("G0X0.0Z2.0", "G74R1.0", "G74Z-12.0Q5000F0.05"))
    feed_ends = [s.points[-1][0] for s in bp.segments if s.kind == "feed"]
    assert feed_ends == [-3.0, -8.0, -12.0]  # 5 mm pecks (Q5000 = 5.000 mm)


def test_g76_thread_passes() -> None:
    bp = backplot(prog("G0X22.0Z3.0", "G76P010060Q100R0.05", "G76X18.0Z-20.0P1000Q400F1.5"))
    depths = sorted(
        {round(s.points[0][1], 3) for s in bp.segments if s.kind == "feed"}, reverse=True
    )
    assert depths[-1] == pytest.approx(9.0)  # final pass at the root diameter 18
    assert len(depths) >= 4


def test_unknown_profile_warns_and_continues() -> None:
    bp = backplot(prog("G0X40.0Z2.0", "G71U1.0R0.5", "G71P50Q60U0.2W0.0F0.2", "G1Z-5.0"))
    assert any("not found" in w["message"] for w in bp.warnings)
    assert bp.segments  # drawing continued


def test_stock_outline() -> None:
    bp = backplot(sample("O0001"))
    stock = stock_outline(50.0, bp)
    assert stock is not None and stock["r"] == 25.0 and stock["z_back"] < -31
    assert stock_outline(None, bp) is None


def test_toolpath_endpoint(
    client: TestClient, role_headers: dict[str, dict[str, str]], settings: Settings, db: Session
) -> None:
    run_seed(settings, db)
    pid = db.scalars(select(Program.id).where(Program.program_number == 4)).one()
    r = client.get(
        f"/api/programs/{pid}/toolpath?bar_diameter=50", headers=role_headers["operator"]
    )
    assert r.status_code == 200
    body = r.json()
    assert body["segments"] and body["blocks"] and body["stock"]["r"] == 25.0
    assert {"z_min", "z_max", "r_min", "r_max"} <= set(body["bounds"])


def test_segments_carry_operation_and_tool_name() -> None:
    bp = backplot(sample("O0001"))
    ops = {s.op for s in bp.segments}
    assert ops == {1, 2}  # 1ST OPN and 2ND OPN (split at the first M30)
    labels = {s.label for s in bp.segments if s.op == 1}
    assert {"32.0 UDRILL", "WNMG 0.8 RG", "BORE FIN", "3MM PARTING"} <= labels
    drill = next(s for s in bp.segments if s.label == "32.0 UDRILL" and s.kind == "feed")
    assert drill.to_dict()["op"] == 1 and drill.to_dict()["label"] == "32.0 UDRILL"


def test_unlabelled_tool_gets_no_stale_name() -> None:
    bp = backplot(sample("O0009"))
    # N4 has no comment: its tool must not inherit the previous "19 UD" name.
    n4 = [s for s in bp.segments if s.op == 2 and s.tool == 1]
    assert n4 and all(s.label == "" for s in n4)
