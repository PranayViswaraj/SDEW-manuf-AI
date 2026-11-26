"""Two-agent AI drawing reader: extractor + verifier, with a fake Claude client (no network)."""

import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.ai.claude_reader import ClaudeDrawingReader, reconcile
from app.ai.drawing_reader import DrawingReaderError
from app.ai.prompts import EXTRACTION_SCHEMA, VERIFICATION_SCHEMA, extractor_system

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def val(v: Any, conf: float = 0.95, ev: str = "SECTION A-A") -> dict[str, Any]:
    return {"v": v, "evidence": ev, "confidence": conf, "source": "drawing"}


def fval(name: str, v: Any, conf: float = 0.95) -> dict[str, Any]:
    return {"name": name, **val(v, conf)}


def extraction(diameter: Any = 22.22, cls: str = "turned part") -> dict[str, Any]:
    return {
        "drawing": {
            "number": "3227C07701",
            "issue": "01",
            "title": "BOSS-SUCTION PIPE",
            "classification": cls,
            "not_lathe": None if cls == "turned part" else "Tube assembly with a parts list.",
            "views": ["SECTION A-A"],
        },
        "general_tolerances": ["above 30 up to 120: ±0.8"],
        "header": {
            "material_grade": val("EN3A"),
            "bar_diameter": val(None, 1, "not on the drawing"),
            "overall_length": val(62.0),
        },
        "features": [
            {
                "type": "od",
                "fields": [
                    fval("diameter", diameter),
                    fval("length", 34, 0.5),
                    fval("tol_plus", 0.1),
                    fval("tol_minus", -0.1),
                ],
            },
            {"type": "flip", "fields": []},
        ],
        "not_in_table": ["Perpendicularity 0.05 of the flange face to datum A"],
        "questions_for_engineer": ["Overall 67 on the drawing, steps add up to 62?"],
    }


def check(path: str, verdict: str, claimed: str = "", correct: Any = None) -> dict[str, Any]:
    return {
        "path": path,
        "claimed": claimed,
        "verdict": verdict,
        "correct": correct,
        "evidence": "SECTION A-A",
    }


ALL_OK = [
    check("header.material_grade", "ok"),
    check("header.overall_length", "ok"),
    check("features[0].fields.diameter", "ok"),
    check("features[0].fields.length", "ok"),
    check("features[0].fields.tol_plus", "ok"),
    check("features[0].fields.tol_minus", "unclear"),
]


class FakeClient:
    """Mimics client.beta.messages.stream(...) -> context manager -> get_final_message()."""

    def __init__(self, answers: list[Any], stop_reason: str = "end_turn") -> None:
        self.answers = list(answers)
        self.calls: list[dict[str, Any]] = []
        self.stop_reason = stop_reason
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        answer = self.answers.pop(0)
        msg = SimpleNamespace(
            stop_reason=self.stop_reason,
            content=[SimpleNamespace(type="text", text=json.dumps(answer))],
        )

        class Ctx:
            def __enter__(self) -> Any:
                return SimpleNamespace(get_final_message=lambda: msg)

            def __exit__(self, *a: Any) -> None:
                return None

        return Ctx()


def reader(client: FakeClient) -> ClaudeDrawingReader:
    return ClaudeDrawingReader(model="claude-opus-5-5", effort="high", client=client)


def test_extract_verify_twice_when_the_verifier_corrects() -> None:
    first = extraction(diameter=2222)  # misread: decimal point lost
    round1 = {
        "verdict": "corrected",
        "checks": [
            *ALL_OK[:2],
            check("features[0].fields.diameter", "wrong", "2222", 22.22),
            *ALL_OK[3:],
        ],
        "corrected": extraction(),
        "questions_for_engineer": [],
    }
    round2 = {
        "verdict": "needs_engineer",
        "checks": ALL_OK,
        "corrected": extraction(),
        "questions_for_engineer": ["Is the tolerance -0.1 or -0.2?"],
    }
    fake = FakeClient([first, round1, round2])
    result = reader(fake).read_report(PDF, "3227C07701.pdf", "3227C07701")

    assert len(fake.calls) == 3  # extractor, verifier, verifier again (max two rounds)
    od = result.table.features[0].fields
    assert od["diameter"].ai == 22.22
    assert od["tol_minus"].ai is None  # "unclear" in the last round -> left empty
    assert result.table.header["material_grade"].ai == "EN3A"
    assert result.table.header["bar_diameter"].ai is None
    cells = list(result.table.header.values()) + [
        c for f in result.table.features for c in f.fields.values()
    ]
    assert all(c.value is None and c.confirmed is False for c in cells)  # suggestions only
    assert result.table.features[1].type == "flip"
    assert "Feature 1 (OD (outside diameter)) Length" in result.notes["low_confidence"]
    assert "Is the tolerance -0.1 or -0.2?" in result.notes["questions"]
    assert result.notes["not_in_table"] == ["Perpendicularity 0.05 of the flange face to datum A"]
    assert result.notes["verify_rounds"] == 2
    assert len(result.audit["verifier"]) == 2 and result.audit["extractor"] == first

    req = fake.calls[0]
    assert req["model"] == "claude-opus-5-5"
    assert req["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in req["betas"]
    assert req["output_config"]["format"]["schema"] == EXTRACTION_SCHEMA
    block = req["messages"][0]["content"][0]
    assert block["type"] == "document" and block["source"]["media_type"] == "application/pdf"
    assert fake.calls[1]["output_config"]["format"]["schema"] == VERIFICATION_SCHEMA
    assert "2222" in fake.calls[1]["messages"][0]["content"][1]["text"]  # verifier sees the claim


def test_one_verify_round_when_nothing_is_wrong() -> None:
    v = {
        "verdict": "accept",
        "checks": ALL_OK,
        "corrected": extraction(),
        "questions_for_engineer": [],
    }
    fake = FakeClient([extraction(), v])
    reader(fake).read_report(PDF)
    assert len(fake.calls) == 2


def test_not_a_lathe_part_gives_no_features() -> None:
    ex = extraction(cls="assembly")
    v = {"verdict": "accept", "checks": ALL_OK, "corrected": ex, "questions_for_engineer": []}
    result = reader(FakeClient([ex, v])).read_report(PDF)
    assert result.table.features == []
    assert result.notes["not_lathe"] == "Tube assembly with a parts list."


def test_unchecked_or_unsupported_values_are_dropped() -> None:
    table, notes = reconcile(extraction(), [check("header.material_grade", "unsupported")])
    assert table.header["material_grade"].ai is None
    assert table.features[0].fields["diameter"].ai is None  # never checked -> not suggested
    assert any("unsupported" in d for d in notes["dropped"])


def test_bad_values_never_reach_the_table() -> None:
    ex = extraction()
    ex["features"][0]["fields"][0] = fval("diameter", -5)  # negative diameter
    ex["features"][0]["fields"].append(fval("angle", 30))  # not a field of an OD
    table, _ = reconcile(ex, ALL_OK + [check("features[0].fields.angle", "ok")])
    assert table.features[0].fields["diameter"].ai is None
    assert "angle" not in table.features[0].fields


def test_refusal_and_bad_files_raise_reader_errors() -> None:
    with pytest.raises(DrawingReaderError):
        reader(FakeClient([{}], stop_reason="refusal")).read_report(PDF)
    with pytest.raises(DrawingReaderError):
        reader(FakeClient([])).read_report(b"not a drawing")


def test_schemas_are_strict_and_prompt_lists_fields() -> None:
    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
                assert set(node["required"]) == set(node["properties"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(EXTRACTION_SCHEMA)
    walk(VERIFICATION_SCHEMA)
    assert "od: diameter, length, tol_plus, tol_minus" in extractor_system()


def test_drawing_upload_fills_empty_table_with_ai_suggestions(
    client: TestClient, role_headers: dict[str, dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api import drawings as api_mod

    v = {
        "verdict": "accept",
        "checks": ALL_OK,
        "corrected": extraction(),
        "questions_for_engineer": [],
    }
    fake = FakeClient([extraction(), v])
    monkeypatch.setattr(api_mod, "ai_reader_enabled", lambda: True)
    monkeypatch.setattr(api_mod, "get_drawing_reader", lambda: reader(fake))
    eng = role_headers["engineer"]
    assert (
        client.post("/api/feature-tables", json={"part_number": "AI-1"}, headers=eng).status_code
        == 201
    )
    r = client.post(
        "/api/drawings",
        data={"part_number": "AI-1"},
        files={"file": ("ai-1.pdf", PDF, "application/pdf")},
        headers=eng,
    )
    assert r.status_code == 201, r.text
    started = r.json()["autofill"]
    # the upload answers at once; the two agents run as a background job
    assert started["ai"] and started["job_id"] and not started["filled"]
    job = client.get(f"/api/drawings/ai-jobs/{started['job_id']}", headers=eng).json()
    assert job["status"] == "done" and job["stage"] == "done", job
    info = job["info"]
    assert info["filled"] and info["questions"]
    assert info["check_counts"]["ok"] >= 1 and info["verify_rounds"] == 1
    assert client.get("/api/drawings/ai-reader", headers=eng).json()["enabled"] is True
    tables = client.get("/api/feature-tables", headers=eng).json()
    ft = client.get(f"/api/feature-tables/{tables[0]['id']}", headers=eng).json()
    assert ft["source"] == "drawing_reader" and ft["status"] == "draft"
    assert ft["data"]["features"][0]["fields"]["diameter"] == {
        "ai": 22.22,
        "value": 22.22,  # filled in for the engineer to check, never ticked
        "confirmed": False,
    }


def test_reader_failure_keeps_upload_working(
    client: TestClient, role_headers: dict[str, dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api import drawings as api_mod

    class Broken:
        def read_report(self, *a: Any) -> Any:
            raise DrawingReaderError("The AI drawing reader is not available (APIConnectionError).")

    monkeypatch.setattr(api_mod, "ai_reader_enabled", lambda: True)
    monkeypatch.setattr(api_mod, "get_drawing_reader", lambda: Broken())
    eng = role_headers["engineer"]
    client.post("/api/feature-tables", json={"part_number": "AI-2"}, headers=eng)
    r = client.post(
        "/api/drawings",
        data={"part_number": "AI-2"},
        files={"file": ("ai-2.pdf", PDF, "application/pdf")},
        headers=eng,
    )
    assert r.status_code == 201, r.text
    job_id = r.json()["autofill"]["job_id"]
    job = client.get(f"/api/drawings/ai-jobs/{job_id}", headers=eng).json()
    assert job["status"] == "failed" and job["info"]["filled"] is False
    assert "not available" in job["info"]["message"]
