import importlib.util
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / "tools" / "sim_demo.py"


def test_sim_demo_runs_demo_program_to_m30(capsys: pytest.CaptureFixture[str]) -> None:
    spec = importlib.util.spec_from_file_location("sim_demo", TOOL)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.main(["--block-time", "0.02", "--max-seconds", "15"]) == 0
    out = capsys.readouterr().out
    assert "run=running" in out and "spindle=  1200" in out
    assert "Program finished (M30)" in out
