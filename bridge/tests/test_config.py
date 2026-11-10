from pathlib import Path

import pytest
from pydantic import ValidationError

from bridge.actions import ALLOWED_ACTIONS, REMOTE_CONTROL_ACTIONS, is_allowed
from bridge.config import BridgeConfig, MachineConfig, load_config
from bridge.main import main

EXAMPLE = Path(__file__).resolve().parents[1] / "config.example.yaml"


def test_example_config_loads() -> None:
    cfg = load_config(EXAMPLE)
    assert cfg.machines[0].port == 8193
    assert cfg.machines[0].driver == "simulated"


def test_remote_control_disabled_by_default() -> None:
    # Safety rule 9
    m = MachineConfig(id="m1", ip="10.0.0.1")
    assert m.remote_control_enabled is False
    assert all(not m.remote_control_enabled for m in load_config(EXAMPLE).machines)


def test_server_url_must_be_outbound_websocket() -> None:
    # Safety rule 5
    with pytest.raises(ValidationError):
        BridgeConfig(server_url="http://0.0.0.0:9000", bridge_token="x" * 16, signing_key="y" * 16)


def test_action_allow_list_is_exact() -> None:
    # Safety rule 6
    assert {"send_program", "start", "feed_hold", "stop", "read_status"} == ALLOWED_ACTIONS
    assert REMOTE_CONTROL_ACTIONS <= ALLOWED_ACTIONS
    for bad in ["delete_program", "emergency_stop", "write_param", "", "START"]:
        assert not is_allowed(bad)


def test_dev_config_loads() -> None:
    cfg = load_config(EXAMPLE.parent / "config.dev.yaml")
    by_id = {m.id: m for m in cfg.machines}
    assert by_id["lmw-lathe-1"].remote_control_enabled is False  # real machine record: off
    assert all(m.driver == "simulated" for m in cfg.machines)


def test_main_check(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--config", str(EXAMPLE), "--check"]) == 0
    assert "config OK" in capsys.readouterr().out
