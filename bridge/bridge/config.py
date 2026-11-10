"""Bridge configuration, loaded from a YAML file. No hard-coded IPs, tokens or paths."""

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator


class MachineConfig(BaseModel):
    # Must equal the machine "key" in the ManufAI server (e.g. "lmw-lathe-1").
    id: str = Field(min_length=1, max_length=64)
    ip: str = "127.0.0.1"
    port: int = Field(default=8193, ge=1, le=65535)  # FANUC FOCAS2 Embedded Ethernet default
    driver: Literal["simulated", "focas"] = "simulated"
    # Safety rule 9: remote start/feed hold/stop are OFF unless explicitly enabled.
    remote_control_enabled: bool = False
    # TODO(REAL-DATA): PMC addresses for Cycle Start / Feed hold / Reset (need a ladder change
    # at the machine; may never be available). Leave empty until the machine builder supplies them.
    pmc_start_address: str | None = None
    pmc_feed_hold_address: str | None = None
    pmc_reset_address: str | None = None
    # Simulated driver only.
    sim_block_time_s: float = Field(default=0.5, gt=0)
    # Simulates the operator pressing Cycle Start at the machine N s after a program is sent.
    sim_auto_cycle_start_after_s: float | None = None


class BridgeConfig(BaseModel):
    server_url: str
    bridge_token: str = Field(min_length=16)
    # Shared secret used to verify the HMAC signature on every command from the server.
    signing_key: str = Field(min_length=16)
    poll_interval_s: float = Field(default=1.0, gt=0)
    heartbeat_interval_s: float = Field(default=2.0, gt=0)
    command_max_age_s: float = Field(default=10.0, gt=0)
    focas_library_path: str | None = None  # TODO(REAL-DATA): Fwlib64.dll / libfwlib32.so path
    focas_timeout_s: int = Field(default=10, gt=0)
    log_file: str = "logs/bridge.log"
    machines: list[MachineConfig] = Field(default_factory=list)

    @field_validator("server_url")
    @classmethod
    def _outbound_ws_only(cls, v: str) -> str:
        # Safety rule 5: the bridge only ever dials OUT to the server over a WebSocket.
        if not v.startswith(("wss://", "ws://")):
            raise ValueError("server_url must be a ws:// or wss:// URL (outbound connection only)")
        return v

    @model_validator(mode="after")
    def _unique_machine_ids(self) -> "BridgeConfig":
        ids = [m.id for m in self.machines]
        if len(ids) != len(set(ids)):
            raise ValueError("Each machine id may appear only once in the bridge config.")
        return self


def load_config(path: str | Path) -> BridgeConfig:
    with Path(path).open(encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return BridgeConfig.model_validate(raw)
