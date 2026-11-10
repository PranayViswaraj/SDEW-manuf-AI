"""User administration (admin only). Includes the allowed-to-start list."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import get_audit, require_roles
from app.auth.schemas import UserCreate, UserOut, UserUpdate
from app.auth.security import hash_password
from app.db.models import Role, User
from app.db.session import get_db
from app.services.audit_log import AuditLogger, AuditResult

router = APIRouter(prefix="/users", tags=["users"])
admin_only = require_roles(Role.ADMIN)


@router.get("", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(admin_only)) -> list[UserOut]:
    return [UserOut.from_user(u) for u in db.scalars(select(User).order_by(User.username))]


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(admin_only),
    audit: AuditLogger = Depends(get_audit),
) -> UserOut:
    if db.scalar(select(User).where(User.username == body.username)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"User '{body.username}' already exists.")
    user = User(
        username=body.username,
        full_name=body.full_name,
        password_hash=hash_password(body.password),
        can_start_machine=body.can_start_machine,
    )
    user.set_roles(set(body.roles))
    db.add(user)
    db.commit()
    audit.record(
        "user_create",
        AuditResult.OK,
        user=admin,
        payload={
            "username": user.username,
            "roles": sorted(user.roles),
            "can_start_machine": user.can_start_machine,
        },
    )
    return UserOut.from_user(user)


def _active_admin_count(db: Session) -> int:
    return sum(1 for u in db.scalars(select(User).where(User.is_active)) if Role.ADMIN in u.roles)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    body: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(admin_only),
    audit: AuditLogger = Depends(get_audit),
) -> UserOut:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    was_active_admin = user.is_active and Role.ADMIN in user.roles
    changes: dict[str, object] = {}
    if body.full_name is not None:
        user.full_name = body.full_name
        changes["full_name"] = body.full_name
    if body.password is not None:
        user.password_hash = hash_password(body.password)
        changes["password"] = "changed"  # noqa: S105 - audit marker, not a secret
    if body.roles is not None:
        user.set_roles(set(body.roles))
        changes["roles"] = sorted(set(body.roles))
    if body.can_start_machine is not None:
        user.can_start_machine = body.can_start_machine
        changes["can_start_machine"] = body.can_start_machine
    if body.is_active is not None:
        user.is_active = body.is_active
        changes["is_active"] = body.is_active

    still_admin = user.is_active and Role.ADMIN in user.roles
    if was_active_admin and not still_admin and _active_admin_count(db) <= 1:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "You cannot remove the last active admin.")
    db.commit()
    audit.record(
        "user_update",
        AuditResult.OK,
        user=admin,
        payload={"target_user_id": user.id, "username": user.username, "changes": changes},
    )
    return UserOut.from_user(user)
