"""FastAPI dependencies for authentication and role checks."""

from collections.abc import Callable

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.auth.security import decode_access_token
from app.config import Settings
from app.db.models import Role, User
from app.db.session import get_db
from app.services.audit_log import AuditLogger

_bearer = HTTPBearer(auto_error=False)


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_audit(request: Request) -> AuditLogger:
    return AuditLogger(request.app.state.session_factory)


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Please log in.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if creds is None:
        raise unauthorized
    user_id = decode_access_token(creds.credentials, settings.jwt_secret)
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your session has expired. Please log in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise unauthorized
    return user


def require_roles(*roles: Role) -> Callable[..., User]:
    """Dependency: the user must hold at least one of `roles`."""
    names = " or ".join(r.value for r in roles)

    def _check(user: User = Depends(get_current_user)) -> User:
        if not user.has_role(*roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"You need the {names} role to do this.",
            )
        return user

    return _check


# Any logged-in user.
any_user = get_current_user
