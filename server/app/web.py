"""Serve the built web app (web/dist) from the API server: one program, one port.

Used by the single-PC install (scripts/start-production.ps1). The Docker stack keeps Caddy in
front instead. Rules match the Caddyfile: /api/* is the API, files under /assets/ are cached
for a year (their names change with every build), every other path gets index.html so the
browser's router can open it.
"""

import mimetypes
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

IMMUTABLE = "public, max-age=31536000, immutable"

# Python takes file types from the Windows registry, where .js is sometimes "text/plain": the
# browser then refuses to run the app (blank page). Fix the types the web app uses.
for _ext, _type in {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
}.items():
    mimetypes.add_type(_type, _ext)


def install_web(app: FastAPI, web_dir: str) -> None:
    root = Path(web_dir).resolve()
    index = root / "index.html"
    if not index.is_file():
        raise RuntimeError(
            f"MANUFAI_WEB_DIR={web_dir} has no index.html. Build the web app first: "
            "cd web; npm run build"
        )

    @app.get("/{path:path}", include_in_schema=False)
    def web_page(path: str) -> FileResponse:
        if path == "api" or path.startswith(("api/", "docs", "redoc", "openapi.json")):
            raise HTTPException(404, "Not found.")
        if path:
            f = (root / path).resolve()
            if f.is_file() and f.is_relative_to(root):
                cache = IMMUTABLE if path.startswith("assets/") else "no-cache"
                return FileResponse(f, headers={"Cache-Control": cache})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
