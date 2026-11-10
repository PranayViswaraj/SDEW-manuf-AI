"""Production plumbing: logging, request IDs, access log, security headers, safe error responses."""

import json
import logging
import sys
import time
import uuid
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
access_log = logging.getLogger("manufai.access")
error_log = logging.getLogger("manufai.error")

SECURITY_HEADERS: list[tuple[bytes, bytes]] = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"strict-origin-when-cross-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
    (b"cross-origin-opener-policy", b"same-origin"),
]


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            data.update(extra)
        if record.exc_info:
            data["exception"] = self.formatException(record.exc_info)
        return json.dumps(data, default=str)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            base += " " + " ".join(f"{k}={v}" for k, v in extra.items())
        return base


def setup_logging(level: str = "INFO", json_logs: bool = False) -> None:
    handler = logging.StreamHandler(sys.stdout)
    if json_logs:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            TextFormatter("%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s")
        )
        handler.addFilter(_RequestIdFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    for noisy in ("uvicorn.access",):  # replaced by our own access log with request IDs
        logging.getLogger(noisy).handlers[:] = []
        logging.getLogger(noisy).propagate = False


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


class RequestContextMiddleware:
    """Pure ASGI middleware (does not touch WebSockets):
    - takes X-Request-ID from the client (if sane) or creates one, returns it on every response,
    - adds security headers,
    - writes one access-log line per request with status and duration.
    """

    def __init__(self, app: ASGIApp, hsts: bool = False) -> None:
        self.app = app
        self.hsts = hsts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode("latin-1")
        rid = (
            incoming
            if incoming and len(incoming) <= 64 and incoming.isascii()
            else uuid.uuid4().hex
        )
        token = request_id_var.set(rid)
        # Also on the request itself: the crash handler runs outside this middleware.
        scope.setdefault("state", {})["request_id"] = rid
        start = time.perf_counter()
        status = {"code": 500}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", rid.encode()))
                headers.extend(SECURITY_HEADERS)
                if self.hsts:
                    headers.append(
                        (b"strict-transport-security", b"max-age=31536000; includeSubDomains")
                    )
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            ms = (time.perf_counter() - start) * 1000
            path = scope.get("path", "")
            if path != "/api/health":  # health checks every few seconds would drown the log
                access_log.info(
                    "%s %s %s",
                    scope.get("method"),
                    path,
                    status["code"],
                    extra={"fields": {"status": status["code"], "duration_ms": round(ms, 1)}},
                )
            request_id_var.reset(token)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        rid = getattr(request.state, "request_id", None) or request_id_var.get()
        token = request_id_var.set(rid)
        error_log.exception("Unhandled error on %s %s", request.method, request.url.path)
        response = JSONResponse(
            status_code=500,
            content={
                "detail": "Something went wrong on the server. Nothing was changed on any machine. "
                f"Give this reference to the admin: {rid}",
                "request_id": rid,
            },
            headers={"x-request-id": rid},
        )
        request_id_var.reset(token)
        return response
