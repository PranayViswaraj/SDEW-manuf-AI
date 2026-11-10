"""Bridge configuration, loaded from a YAML file. No hard-coded IPs, tokens or paths."""

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator


class MachineConfig(BaseModel):
    id: str
    ip: str
    port: int = 8193  # FANUC FOCAS2 Embedded Ethernet default
    driver: Literal["simulated", "focas"] = "simulated"
    # Safety rule 9: remote start/feed hold/stop are OFF unless explicitly enabled.
    remote_control_enabled: bool = False
    # TODO(REAL-DATA): PMC address for Cycle Start / Feed hold (needs a ladder change at the
    # machine; may never be available). Leave empty until the machine builder supplies it.
    pmc_start_address: str | None = None
    pmc_feed_hold_address: str | None = None


class BridgeConfig(BaseModel):
    server_url: str
    bridge_token: str = Field(min_length=16)
    poll_interval_s: float = Field(default=1.0, gt=0)
    heartbeat_interval_s: float = Field(default=2.0, gt=0)
    focas_library_path: str | None = None  # TODO(REAL-DATA): Fwlib32.dll / libfwlib32.so path
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


def load_config(path: str | Path) -> BridgeConfig:
    with Path(path).open(encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return BridgeConfig.model_validate(raw)
