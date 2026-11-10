"""Login and current-user endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import get_audit, get_current_user, get_settings_dep
from app.auth.login_guard import LoginGuard
from app.auth.schemas import LoginRequest, TokenResponse, UserOut
from app.auth.security import create_access_token, verify_password
from app.config import Settings
from app.db.models import User
from app.db.session import get_db
from app.services.audit_log import AuditLogger, AuditResult

router = APIRouter(prefix="/auth", tags=["auth"])


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post(
    "/login",
    response_model=TokenResponse,
    summary="Log in and get an access token",
    responses={
        401: {"description": "Wrong username or password"},
        429: {"description": "Locked out"},
    },
)
def login(
    body: LoginRequest,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
    audit: AuditLogger = Depends(get_audit),
) -> TokenResponse:
    guard: LoginGuard = request.app.state.login_guard
    address = _client(request)
    locked = guard.seconds_locked(body.username, address)
    if locked:
        audit.record(
            "login",
            AuditResult.REJECTED,
            payload={"username": body.username, "address": address, "reason": "locked out"},
        )
        minutes = max(1, round(locked / 60))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many wrong passwords. Try again in about {minutes} minute(s), "
            "or ask an admin to reset your password.",
            headers={"Retry-After": str(locked)},
        )
    user = db.scalar(select(User).where(User.username == body.username))
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        guard.failed(body.username, address)
        audit.record(
            "login",
            AuditResult.REJECTED,
            payload={"username": body.username, "address": address},
            user=user,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Wrong username or password."
        )
    guard.succeeded(body.username, address)
    audit.record("login", AuditResult.OK, user=user, payload={"address": address})
    token = create_access_token(user.id, settings.jwt_secret, settings.jwt_expire_minutes)
    return TokenResponse(access_token=token, user=UserOut.from_user(user))


@router.get("/me", response_model=UserOut, summary="The logged-in user")
def me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.from_user(user)
