"""The AI reader of the hosted (in-browser) build, with a fake JavaScript bridge, and the
"Read with AI" endpoint for a drawing that is already uploaded."""

import asyncio
import json
import sys
import types
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.ai.browser_reader import BrowserClaudeReader, key_set
from app.ai.drawing_reader import DrawingReaderError
from tests.test_claude_reader import ALL_OK, PDF, FakeClient, extraction, reader


def fake_js(
    monkeypatch: pytest.MonkeyPatch, answers: list[Any], key: bool = True
) -> list[dict[str, Any]]:
    """Install a fake `js` module: the agents' answers come back as the worker would send them."""
    sent: list[dict[str, Any]] = []
    queue = list(answers)

    async def anthropic(body: str) -> str:
        sent.append(json.loads(body))
        a = queue.pop(0)
        if isinstance(a, dict) and a.get("__http__"):
            return json.dumps({"ok": False, "status": a["__http__"], "error": "denied"})
        return json.dumps({"ok": True, "stop_reason": "end_turn", "text": json.dumps(a)})

    async def tiles(_pdf: Any) -> str:
        return json.dumps(
            {
                "images": [
                    {"label": "Page 1 of 1: whole sheet.", "media": "image/png", "data": "AAAA"},
                    {
                        "label": "Page 1 of 1: zoomed tile, top-left.",
                        "media": "image/png",
                        "data": "BBBB",
                    },
                ],
                "numbers": ["22.22", "62"],
            }
        )

    js = types.SimpleNamespace(
        manufaiAnthropic=anthropic, manufaiRenderTiles=tiles, manufaiAiKeySet=lambda: key
    )
    ffi = types.SimpleNamespace(to_js=lambda b: b)
    monkeypatch.setitem(sys.modules, "js", js)
    monkeypatch.setitem(sys.modules, "pyodide", types.SimpleNamespace(ffi=ffi))
    monkeypatch.setitem(sys.modules, "pyodide.ffi", ffi)
    return sent


def verdict(corrected: Any) -> dict[str, Any]:
    return {
        "verdict": "accept",
        "checks": ALL_OK,
        "corrected": corrected,
        "callouts": [],
        "questions_for_engineer": [],
    }


def test_browser_reader_runs_both_agents_through_the_js_bridge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # the checker sends its corrected table as JSON text (keeps the API's output grammar small)
    sent = fake_js(monkeypatch, [extraction(), verdict(json.dumps(extraction()))])
    r = BrowserClaudeReader(model="claude-opus-5-5", effort="xhigh")
    assert r.runs_in_event_loop and key_set()
    result = asyncio.run(r.aread_report(PDF, "d.pdf", "P-1"))
    assert len(sent) == 2
    assert sent[0]["stream"] is True and sent[0]["output_config"]["effort"] == "xhigh"
    kinds = [b["type"] for b in sent[0]["messages"][0]["content"]]
    assert kinds[:5] == ["document", "text", "image", "text", "image"]  # PDF + whole sheet + tile
    assert "x-api-key" not in json.dumps(sent)  # the key never passes through Python
    assert result.table.features[0].fields["diameter"].ai == 22.22
    assert result.audit["text_layer_numbers"] == ["22.22", "62"]


def test_browser_reader_explains_a_rejected_key(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_js(monkeypatch, [{"__http__": 401}])
    with pytest.raises(DrawingReaderError, match="API key was rejected"):
        asyncio.run(BrowserClaudeReader(model="m").aread_report(PDF))


def test_key_set_is_false_outside_a_browser(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "js", raising=False)
    assert key_set() is False


def test_a_bad_corrected_table_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_js(monkeypatch, [extraction(), verdict("{not json")])
    with pytest.raises(DrawingReaderError, match="corrected table was not valid JSON"):
        asyncio.run(BrowserClaudeReader(model="m").aread_report(PDF))


def test_read_with_ai_for_an_uploaded_drawing(
    client: TestClient, role_headers: dict[str, dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api import drawings as api_mod

    eng = role_headers["engineer"]
    client.post("/api/feature-tables", json={"part_number": "AI-9"}, headers=eng)
    up = client.post(
        "/api/drawings",
        data={"part_number": "AI-9"},
        files={"file": ("ai-9.pdf", PDF, "application/pdf")},
        headers=eng,
    )
    assert up.status_code == 201 and up.json()["autofill"] is None  # AI off: nothing read
    did = up.json()["id"]
    assert client.post(f"/api/drawings/{did}/ai-read", headers=eng).status_code == 409  # off

    fake = FakeClient([extraction(), verdict(extraction())])
    monkeypatch.setattr(api_mod, "ai_reader_enabled", lambda: True)
    monkeypatch.setattr(api_mod, "get_drawing_reader", lambda: reader(fake))
    r = client.post(f"/api/drawings/{did}/ai-read", headers=eng)
    assert r.status_code == 200, r.text
    job = client.get(f"/api/drawings/ai-jobs/{r.json()['job_id']}", headers=eng).json()
    assert job["status"] == "done" and job["info"]["filled"], job
    # nobody has touched the AI's values yet: uploading the drawing again reads it again
    fake2 = FakeClient([extraction(diameter=22.0), verdict(extraction(diameter=22.0))])
    monkeypatch.setattr(api_mod, "get_drawing_reader", lambda: reader(fake2))
    up2 = client.post(
        "/api/drawings",
        data={"part_number": "AI-9"},
        files={"file": ("ai-9.pdf", PDF, "application/pdf")},
        headers=eng,
    )
    job2 = client.get(f"/api/drawings/ai-jobs/{up2.json()['autofill']['job_id']}", headers=eng)
    assert job2.json()["info"]["filled"], job2.json()
    ft_id = client.get("/api/feature-tables", headers=eng).json()[0]["id"]
    ft = client.get(f"/api/feature-tables/{ft_id}", headers=eng).json()
    assert ft["data"]["features"][0]["fields"]["diameter"]["value"] == 22.0  # the new reading
    # once an engineer has ticked a value, the AI never touches the table again
    data = ft["data"]
    data["features"][0]["fields"]["diameter"]["confirmed"] = True
    assert (
        client.put(f"/api/feature-tables/{ft_id}", json={"data": data}, headers=eng).status_code
        == 200
    )
    again = client.post(f"/api/drawings/{did}/ai-read", headers=eng)
    assert again.status_code == 409 and "never overwrites" in again.json()["detail"]
    assert (
        client.post(f"/api/drawings/{did}/ai-read", headers=role_headers["operator"]).status_code
        == 403
    )


def test_a_browser_side_failure_is_explained(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_js(monkeypatch, [])

    async def boom(_body: str) -> str:
        raise RuntimeError("TypeError: Failed to fetch")

    monkeypatch.setattr(sys.modules["js"], "manufaiAnthropic", boom)
    with pytest.raises(DrawingReaderError, match="could not reach the AI service: TypeError"):
        asyncio.run(BrowserClaudeReader(model="m").aread_report(PDF))


def test_read_again_with_opus(
    client: TestClient, role_headers: dict[str, dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api import drawings as api_mod

    eng = role_headers["engineer"]
    client.post("/api/feature-tables", json={"part_number": "AI-10"}, headers=eng)
    did = client.post(
        "/api/drawings",
        data={"part_number": "AI-10"},
        files={"file": ("ai-10.pdf", PDF, "application/pdf")},
        headers=eng,
    ).json()["id"]
    used: list[str | None] = []

    def factory(model: str | None = None) -> Any:
        used.append(model)
        return reader(FakeClient([extraction(), verdict(extraction())]))

    monkeypatch.setattr(api_mod, "ai_reader_enabled", lambda: True)
    monkeypatch.setattr(api_mod, "get_drawing_reader", factory)
    assert client.post(f"/api/drawings/{did}/ai-read?model=gpt", headers=eng).status_code == 422
    r = client.post(f"/api/drawings/{did}/ai-read?model=opus", headers=eng)
    assert r.status_code == 200 and r.json()["model"] == "claude-opus-5-5"
    assert used == ["claude-opus-5-5"]
