"""Login and current-user endpoints."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import get_audit, get_current_user, get_settings_dep
from app.auth.schemas import LoginRequest, TokenResponse, UserOut
from app.auth.security import create_access_token, verify_password
from app.config import Settings
from app.db.models import User
from app.db.session import get_db
from app.services.audit_log import AuditLogger, AuditResult

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(
    body: LoginRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
    audit: AuditLogger = Depends(get_audit),
) -> TokenResponse:
    user = db.scalar(select(User).where(User.username == body.username))
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        audit.record("login", AuditResult.REJECTED, payload={"username": body.username}, user=user)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Wrong username or password."
        )
    audit.record("login", AuditResult.OK, user=user)
    token = create_access_token(user.id, settings.jwt_secret, settings.jwt_expire_minutes)
    return TokenResponse(access_token=token, user=UserOut.from_user(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.from_user(user)
