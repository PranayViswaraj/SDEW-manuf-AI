"""Server settings. Everything comes from environment variables / .env (prefix MANUFAI_)."""

from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MANUFAI_", env_file=".env", extra="ignore")

    env: str = "dev"
    database_url: str = "sqlite:///./manufai.db"
    jwt_secret: str = Field(default="dev-only-insecure-secret-change-me-in-prod", min_length=32)
    jwt_expire_minutes: int = 480
    cors_origins: str = "http://localhost:5173"
    # Safety rule 8: UI shows stale/offline after this many seconds without status.
    status_stale_seconds: float = 5.0
    # Bridge rejects commands older than this.
    command_max_age_seconds: float = 10.0
    # Create dev users with published passwords (README). Never in production.
    seed_dev_data: bool = False
    # Seconds to wait for the bridge to send + verify a program.
    bridge_send_timeout_s: float = 60.0
    # DEV ONLY bridge credentials created by the dev seed (match bridge/config.dev.yaml).
    dev_bridge_token: str = "dev-bridge-token-not-secret"  # noqa: S105 - published dev value
    dev_bridge_signing_key: str = "dev-bridge-signing-key-not-secret"
    # Folder with the trusted O-files imported at seed time (Milestone 9).
    samples_dir: str = "../samples/programs"
    # Sample raw-material CSV loaded by the dev seed (clearly marked SAMPLE DATA).
    sample_materials_csv: str = "../samples/materials/raw-material-register.sample.csv"

    @model_validator(mode="after")
    def _no_dev_secret_in_production(self) -> "Settings":
        if self.env == "production" and self.jwt_secret.startswith("dev-only"):
            raise ValueError("Set MANUFAI_JWT_SECRET to a long random value in production.")
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
