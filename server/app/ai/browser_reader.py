"""The two-agent reader inside the browser (GitHub Pages build, Pyodide).

Same prompts, schemas, tiles, callout inventories and completeness checks as the server reader;
only the two outside calls differ:

- the Anthropic API is called by the browser itself (JavaScript fetch, streaming) with the key the
  user entered on THAT browser. The key is held by the JavaScript side only: Python never sees it,
  it is never in the app's code, its database or GitHub.
- the zoomed tiles are rendered by the page with PDF.js (pypdfium2 is not available in Pyodide).

The JavaScript side is in web/src/browser-server (worker.ts: manufaiAnthropic, manufaiRenderTiles,
manufaiAiKeySet).
"""

import json
from typing import Any

from app.ai.claude_reader import ClaudeDrawingReader
from app.ai.drawing_images import DrawingImages
from app.ai.drawing_reader import DrawingReaderError


def key_set() -> bool:
    """Has the user entered an API key in this browser?"""
    try:
        import js

        return bool(js.manufaiAiKeySet())
    except Exception:  # noqa: BLE001 - not in a browser, or the hook is missing
        return False


_HTTP_MESSAGES = {
    401: "The API key was rejected by Anthropic. Enter a valid key (it starts with sk-ant-).",
    403: "The API key is not allowed to use this model.",
    429: "Too many requests or the spending limit was reached. Try again later.",
}


class BrowserClaudeReader(ClaudeDrawingReader):
    runs_in_event_loop = True

    def __init__(self, model: str, effort: str = "high") -> None:
        super().__init__(model=model, effort=effort, client=object())

    async def _aask(
        self, system: str, content: list[dict[str, Any]], schema: dict[str, Any]
    ) -> dict[str, Any]:
        import js

        body = self._request(system, content, schema) | {"stream": True}
        try:
            raw = await js.manufaiAnthropic(json.dumps(body, ensure_ascii=False))
            res = json.loads(str(raw))
        except Exception as e:  # noqa: BLE001 - a browser-side failure: say what it was
            raise DrawingReaderError(f"The browser could not reach the AI service: {e}") from e
        if not res.get("ok"):
            status = int(res.get("status") or 0)
            msg = _HTTP_MESSAGES.get(status) or f"The AI service answered with an error ({status})."
            raise DrawingReaderError(msg + " " + str(res.get("error") or "")[:300])
        return self._answer(res.get("stop_reason"), str(res.get("text") or ""))

    async def _images(self, file: bytes) -> DrawingImages:
        if not self.tiles or not file.startswith(b"%PDF-"):
            return DrawingImages()
        try:
            import js
            from pyodide.ffi import to_js

            raw = await js.manufaiRenderTiles(to_js(file))
            res = json.loads(str(raw))
        except Exception:  # noqa: BLE001 - without tiles the agents still get the PDF itself
            return DrawingImages()
        out = DrawingImages(text_numbers=list(res.get("numbers") or [])[:400])
        for img in res.get("images") or []:
            data = str(img.get("data") or "")
            if not data:
                continue
            out.blocks.append({"type": "text", "text": str(img.get("label") or "Drawing")})
            out.blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": str(img.get("media") or "image/png"),
                        "data": data,
                    },
                }
            )
            out.described.append(str(img.get("described") or img.get("label") or ""))
        return out
