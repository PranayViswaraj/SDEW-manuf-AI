"""Server settings. Everything comes from environment variables / .env (prefix MANUFAI_).

In production (MANUFAI_ENV=production) unsafe settings are refused at start-up, so a
misconfigured server never comes up quietly.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_JWT_PREFIX = "dev-only"
DEV_BRIDGE_TOKEN = "dev-bridge-token-not-secret"  # noqa: S105 - published dev value
DEV_BRIDGE_KEY = "dev-bridge-signing-key-not-secret"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MANUFAI_", env_file=".env", extra="ignore")

    env: Literal["dev", "test", "production"] = "dev"
    database_url: str = "sqlite:///./manufai.db"
    # PostgreSQL connection pool (ignored for SQLite).
    db_pool_size: int = Field(default=10, ge=1, le=100)
    db_max_overflow: int = Field(default=10, ge=0, le=100)
    db_pool_recycle_s: int = Field(default=1800, ge=60)

    jwt_secret: str = Field(
        default=f"{DEV_JWT_PREFIX}-insecure-secret-change-me-in-prod", min_length=32
    )
    jwt_expire_minutes: int = Field(default=480, ge=5, le=24 * 60)
    cors_origins: str = "http://localhost:5173"

    # Login protection: this many wrong passwords in the window locks that user + address.
    login_max_failures: int = Field(default=5, ge=1, le=50)
    login_lockout_s: int = Field(default=300, ge=10, le=24 * 3600)

    # Logging and API docs.
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_json: bool = False  # one JSON object per line (for log collectors)
    docs_enabled: bool = True  # /docs and /openapi.json
    # Send Strict-Transport-Security (only when the site is served over HTTPS).
    hsts: bool = False

    # Safety rule 8: UI shows stale/offline after this many seconds without status.
    status_stale_seconds: float = 5.0
    # Bridge rejects commands older than this.
    command_max_age_seconds: float = 10.0
    # Create dev users with published passwords (README). Never in production.
    seed_dev_data: bool = False
    # Seconds to wait for the bridge to send + verify a program.
    bridge_send_timeout_s: float = 60.0
    # DEV ONLY bridge credentials created by the dev seed (match bridge/config.dev.yaml).
    dev_bridge_token: str = DEV_BRIDGE_TOKEN
    dev_bridge_signing_key: str = DEV_BRIDGE_KEY
    # Folder with the trusted O-files imported at seed time (Milestone 9).
    samples_dir: str = "../samples/programs"
    # Sample raw-material CSV loaded by the dev seed (clearly marked SAMPLE DATA).
    sample_materials_csv: str = "../samples/materials/raw-material-register.sample.csv"

    @model_validator(mode="after")
    def _production_safety(self) -> "Settings":
        if self.env != "production":
            return self
        problems = production_problems(self)
        if problems:
            raise ValueError("Unsafe production settings: " + " ".join(problems))
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.env == "production"


def production_problems(s: Settings) -> list[str]:
    """Plain-English list of settings that must not be used in production."""
    out = []
    if s.jwt_secret.startswith(DEV_JWT_PREFIX):
        out.append("Set MANUFAI_JWT_SECRET to a long random value.")
    if s.seed_dev_data:
        out.append("Set MANUFAI_SEED_DEV_DATA=false (dev users have published passwords).")
    if "*" in s.cors_origin_list:
        out.append("MANUFAI_CORS_ORIGINS must list your site, not '*'.")
    if s.database_url.startswith("sqlite"):
        out.append("Use PostgreSQL (MANUFAI_DATABASE_URL), not SQLite.")
    return out


@lru_cache
def get_settings() -> Settings:
    return Settings()
