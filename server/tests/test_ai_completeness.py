"""Precision and completeness of the AI drawing reader: zoomed tiles, callout inventories,
balloon numbers, text-layer numbers, and the accuracy evaluation against known drawings."""

import io
from typing import Any

import pytest

from app.ai.claude_reader import completeness
from app.ai.drawing_images import grid_for, render, tile_boxes
from app.ai.evaluate import score, summary
from app.ai.known_drawings import KnownDrawing
from tests.test_claude_reader import ALL_OK, PDF, FakeClient, extraction, reader


def callout(
    text: str, balloon: int | None, where: str = "features[0].fields.diameter"
) -> dict[str, Any]:
    return {
        "text": text,
        "balloon": balloon,
        "view": "SECTION A-A",
        "where": "top-left",
        "accounted_for": where,
    }


# ------------------------------------------------------------------ tiles


def test_tiles_cover_the_whole_sheet_and_overlap() -> None:
    assert grid_for(1191, 842) == (2, 2)  # A3 landscape
    assert grid_for(2384, 1684) == (3, 2)  # A1 landscape
    assert grid_for(595, 842) == (2, 2)  # A4 portrait
    w, h = 5000, 3500
    boxes = tile_boxes(w, h, 2, 2)
    assert len(boxes) == 4
    assert min(b[0] for b in boxes) == 0 and max(b[2] for b in boxes) == w
    assert min(b[1] for b in boxes) == 0 and max(b[3] for b in boxes) == h
    left, right = boxes[0], boxes[1]
    assert left[2] > right[0]  # neighbours overlap: no callout is cut in half


def test_render_sends_the_sheet_and_zoomed_tiles_at_full_resolution() -> None:
    image = pytest.importorskip("PIL.Image")
    pytest.importorskip("pypdfium2")
    sheet = image.new("L", (1684, 1191), 255)  # an A3 sheet at 144 dpi
    buf = io.BytesIO()
    sheet.save(buf, "PDF", resolution=144)
    out = render(buf.getvalue())
    imgs = [b for b in out.blocks if b["type"] == "image"]
    assert len(imgs) == 5  # whole sheet + 2x2 tiles
    assert "whole sheet" in out.described[0] and "tile top-left" in out.described[1]
    assert int(out.described[1].split()[-1].split("x")[0]) >= 2000  # tiles near full resolution


def test_render_falls_back_quietly_on_a_broken_file() -> None:
    assert render(b"%PDF-1.4 broken").blocks == []


# ------------------------------------------------------------------ completeness


def test_finds_missing_balloons_unplaced_callouts_and_lost_values() -> None:
    first = extraction() | {
        "callouts": [
            callout("Ø22.22 ±0.1", 1),
            callout("CH 0.5X45", 2, "not_in_table: chamfer"),
            callout("⊥ 0.05 A", 4, "none"),
            callout("R3", 5, "features[3].fields.radius"),
        ]
    }
    gaps = completeness(first, None, ["22.22", "0.1", "2.79", "011"])
    assert gaps.missing_balloons == [3]  # 1..5 drawn, 3 not found
    assert gaps.unaccounted == ["⊥ 0.05 A"]
    assert gaps.text_only == ["2.79"]  # printed on the sheet, in nobody's answer; "011" ignored
    msg = gaps.message(first_round=True)
    assert "Inspection balloon numbers not found yet: 3" in msg and "2.79" in msg

    checker = {"corrected": extraction(), "callouts": [callout("Ø22.22 ±0.1", 1)], "checks": []}
    lost = completeness(first, checker, [])
    assert lost.first_only == ["CH 0.5X45", "⊥ 0.05 A", "R3"]  # the checker dropped these
    assert lost.missing_balloons == [2, 3, 4, 5]
    assert any("Balloon 3" in x for x in lost.for_engineer())


def test_a_gap_forces_the_second_look_even_when_every_value_was_ok() -> None:
    first = extraction() | {
        "callouts": [callout("Ø22.22 ±0.1", 1), callout("34", 3, "features[0].fields.length")]
    }
    round1 = {
        "verdict": "accept",
        "checks": ALL_OK,
        "corrected": extraction(),
        "callouts": [callout("Ø22.22 ±0.1", 1), callout("34", 3, "features[0].fields.length")],
        "questions_for_engineer": [],
    }
    round2 = round1 | {
        "callouts": [*round1["callouts"], callout("CH 1X45", 2, "not_in_table: back chamfer")]
    }
    fake = FakeClient([first, round1, round2])
    result = reader(fake).read_report(PDF, "d.pdf", "3227C07701")
    assert len(fake.calls) == 3
    second = fake.calls[2]["messages"][0]["content"][-1]["text"]
    assert "Inspection balloon numbers not found yet: 2" in second
    assert result.notes["unaccounted"] == []  # balloon 2 found in the second look
    assert result.notes["balloons"] == 3 and result.notes["callouts"] == 3


def test_no_second_look_when_all_is_accounted_for() -> None:
    cs = [callout("Ø22.22 ±0.1", 1)]
    first = extraction() | {"callouts": cs}
    round1 = {
        "verdict": "accept",
        "checks": ALL_OK,
        "corrected": extraction(),
        "callouts": cs,
        "questions_for_engineer": [],
    }
    fake = FakeClient([first, round1])
    result = reader(fake).read_report(PDF, "d.pdf", "")
    assert len(fake.calls) == 2
    assert result.notes["unaccounted"] == []


# ------------------------------------------------------------------ accuracy evaluation

KNOWN = KnownDrawing(
    part_number="P-1",
    title="",
    sha256=(),
    read_by="",
    header={"material_grade": "EN8", "bar_diameter": None, "overall_length": 62.0},
    features=[
        {"type": "chamfer", "fields": {"size": 0.5, "angle": 45}},
        {
            "type": "od",
            "fields": {"diameter": 22.22, "length": 34, "tol_plus": 0.1, "tol_minus": -0.1},
        },
        {"type": "bore", "fields": {"diameter": 19, "depth": 33}},
    ],
    not_on_drawing=(),
    not_in_table=(),
    aliases=(),
)


def cells(**kv: Any) -> dict[str, Any]:
    return {k: {"ai": v, "value": None, "confirmed": False} for k, v in kv.items()}


def test_score_counts_right_wrong_and_missed() -> None:
    table = {
        "header": cells(material_grade="EN8", bar_diameter=None, overall_length=62),
        "features": [
            {
                "type": "od",
                "fields": cells(diameter=22.22, length=43, tol_plus=0.1, tol_minus=-0.1),
            },
            {"type": "bore", "fields": cells(diameter=19, depth=33)},
            {"type": "groove", "fields": cells(diameter=20)},
        ],
    }
    s = score(KNOWN, table, {})
    assert s.expected == 10 and s.suggested == 9
    assert s.correct == 7  # length 43 is wrong; the groove is invented
    assert any("length: suggested 43, drawing 34" in w for w in s.wrong)
    assert s.missed_features and "chamfer" in s.missed_features[0]
    assert s.extra_features and "groove" in s.extra_features[0]
    assert s.precision == pytest.approx(7 / 9) and s.recall == pytest.approx(7 / 10)
    assert summary([s])["missed_features"] == 1


def test_score_flags_an_invented_bar_size_and_a_wrong_lathe_call() -> None:
    table = {
        "header": cells(material_grade="EN8", bar_diameter=25, overall_length=62),
        "features": [],
    }
    s = score(KNOWN, table, {"not_lathe": "Looks like a tube assembly."})
    assert s.lathe_call == "called not a lathe part"
    assert any("bar_diameter" in w for w in s.wrong)


# ------------------------------------------------------------------ the API key


def test_api_key_comes_from_a_dotenv_file_and_stays_secret(tmp_path: Any, monkeypatch: Any) -> None:
    from app.config import Settings

    env = tmp_path / ".env"
    env.write_text(
        "MANUFAI_AI_READER=claude\nANTHROPIC_API_KEY=sk-ant-test-123\n", encoding="utf-8"
    )
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("MANUFAI_AI_READER", raising=False)
    s = Settings(_env_file=env)
    assert s.ai_reader == "claude"
    assert s.anthropic_api_key is not None
    assert s.anthropic_api_key.get_secret_value() == "sk-ant-test-123"
    assert "sk-ant-test-123" not in repr(s) and "sk-ant-test-123" not in str(s.model_dump())


def test_a_blank_key_counts_as_no_key(monkeypatch: Any) -> None:
    from app.config import Settings

    monkeypatch.setenv("ANTHROPIC_API_KEY", "  ")
    assert Settings(_env_file=None).anthropic_api_key is None


def test_tests_never_run_the_real_reader() -> None:
    from app.ai.drawing_reader import ai_reader_enabled
    from app.config import get_settings

    get_settings.cache_clear()
    assert not ai_reader_enabled()
    assert get_settings().anthropic_api_key is None


# ------------------------------------------------------------------ token cost


def _with_tiles(r: Any, monkeypatch: pytest.MonkeyPatch, numbers: list[str]) -> None:
    from app.ai.drawing_images import DrawingImages

    img = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AA"}}

    async def tiles(_file: bytes) -> DrawingImages:
        return DrawingImages(blocks=[{"type": "text", "text": "tile"}, img], text_numbers=numbers)

    monkeypatch.setattr(r, "_images", tiles)


def test_a_scan_is_sent_once_cached_and_checked_once(monkeypatch: pytest.MonkeyPatch) -> None:
    cs = [callout("Ø22.22 ±0.1", 1)]
    first = extraction() | {"callouts": cs}
    check = {
        "verdict": "accept",
        "checks": ALL_OK,
        "corrected": extraction(),
        "callouts": cs,
        "questions_for_engineer": [],
    }
    fake = FakeClient([first, check])
    fake.usage = {
        "input_tokens": 1000,
        "output_tokens": 2000,
        "cache_creation_input_tokens": 9000,
        "cache_read_input_tokens": 0,
    }
    r = reader(fake)
    _with_tiles(r, monkeypatch, numbers=[])
    result = r.read_report(PDF)
    content = fake.calls[0]["messages"][0]["content"]
    assert [b["type"] for b in content] == ["text", "image", "text"]  # no PDF copy of a scan
    assert content[1]["cache_control"] == {"type": "ephemeral"}  # agent 2 reads it from cache
    assert len(fake.calls) == 2
    u = result.notes["usage"]
    assert u["calls"] == 2 and u["input"] == 2000 and u["output"] == 4000
    assert u["cost_usd"] == round((2000 * 4 + 4000 * 20 + 18000 * 5) / 1e6, 2)


def test_a_text_layer_number_alone_does_not_cost_a_second_round(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cs = [callout("Ø22.22 ±0.1", 1)]
    first = extraction() | {"callouts": cs}
    check = {
        "verdict": "accept",
        "checks": ALL_OK,
        "corrected": extraction(),
        "callouts": cs,
        "questions_for_engineer": [],
    }
    fake = FakeClient([first, check])
    r = reader(fake)
    _with_tiles(r, monkeypatch, numbers=["99.9"])  # a CAD sheet: printed number nobody used
    result = r.read_report(PDF)
    assert fake.calls[0]["messages"][0]["content"][0]["type"] == "document"  # text layer: PDF kept
    assert len(fake.calls) == 2  # no third call for it...
    assert any("99.9" in x for x in result.notes["unaccounted"])  # ...the engineer checks it
