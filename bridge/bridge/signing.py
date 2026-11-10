"""HMAC-SHA256 signing of commands. Must match server/app/services/command_signing.py."""

import hashlib
import hmac
import json
from typing import Any


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sign(command: dict[str, Any], key: str) -> str:
    return hmac.new(key.encode(), canonical_json(command), hashlib.sha256).hexdigest()


def verify(command: dict[str, Any], signature: str, key: str) -> bool:
    return hmac.compare_digest(sign(command, key), signature or "")
