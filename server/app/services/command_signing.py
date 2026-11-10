"""HMAC-SHA256 signing of bridge commands. Must match bridge/bridge/signing.py."""

import hashlib
import hmac
import json
from typing import Any


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sign(command: dict[str, Any], key: str) -> str:
    return hmac.new(key.encode(), canonical_json(command), hashlib.sha256).hexdigest()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
