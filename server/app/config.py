"""Server settings. Everything comes from environment variables / .env (prefix MANUFAI_)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MANUFAI_", env_file=".env", extra="ignore")

    env: str = "dev"
    database_url: str = "sqlite:///./manufai.db"
    jwt_secret: str = Field(default="dev-only-insecure-secret", min_length=16)
    jwt_expire_minutes: int = 480
    cors_origins: str = "http://localhost:5173"
    # Safety rule 8: UI shows stale/offline after this many seconds without status.
    status_stale_seconds: float = 5.0
    # Bridge rejects commands older than this.
    command_max_age_seconds: float = 10.0

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
