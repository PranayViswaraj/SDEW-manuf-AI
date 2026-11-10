"""Request/response schemas for auth and users."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.db.models import Role, User


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    full_name: str
    is_active: bool
    can_start_machine: bool
    roles: list[Role]
    created_at: datetime

    @classmethod
    def from_user(cls, u: User) -> "UserOut":
        return cls(
            id=u.id,
            username=u.username,
            full_name=u.full_name,
            is_active=u.is_active,
            can_start_machine=u.can_start_machine,
            roles=sorted(u.roles),
            created_at=u.created_at,
        )


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105 - OAuth2 token type name
    user: UserOut


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    full_name: str = Field(default="", max_length=128)
    password: str = Field(min_length=8, max_length=256)
    roles: list[Role] = Field(default_factory=list)
    can_start_machine: bool = False

    @field_validator("roles")
    @classmethod
    def _unique(cls, v: list[Role]) -> list[Role]:
        return sorted(set(v))


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, max_length=128)
    password: str | None = Field(default=None, min_length=8, max_length=256)
    roles: list[Role] | None = None
    can_start_machine: bool | None = None
    is_active: bool | None = None
