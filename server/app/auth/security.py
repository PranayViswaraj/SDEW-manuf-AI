"""Password hashing (argon2) and JWT tokens."""

from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()
_ALGO = "HS256"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def create_access_token(user_id: int, secret: str, expire_minutes: int) -> str:
    now = datetime.now(UTC)
    payload = {"sub": str(user_id), "iat": now, "exp": now + timedelta(minutes=expire_minutes)}
    return jwt.encode(payload, secret, algorithm=_ALGO)


def decode_access_token(token: str, secret: str) -> int | None:
    """Return the user id, or None if the token is invalid or expired."""
    try:
        payload = jwt.decode(token, secret, algorithms=[_ALGO])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
