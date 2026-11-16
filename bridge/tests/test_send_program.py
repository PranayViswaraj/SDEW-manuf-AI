import asyncio
import importlib.util
from pathlib import Path

from bridge.drivers.simulated import SimConfig, SimulatedDriver

_spec = importlib.util.spec_from_file_location(
    "send_program", Path(__file__).resolve().parents[1] / "tools" / "send_program.py"
)
assert _spec and _spec.loader
send_program = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(send_program)

PROGRAM = "%\nO1000(SLEEVE TEST)\nG21\nM30\n%\n"


def _run(driver: SimulatedDriver, path: Path, answer: str = "") -> tuple[int, list[str]]:
    lines: list[str] = []
    code = asyncio.run(
        send_program.send(driver, path, "//CNC_MEM/USER/PATH1/", lambda _q: answer, lines.append)
    )
    return code, lines


def test_send_new_program_reads_back_and_selects(tmp_path: Path) -> None:
    f = tmp_path / "O1000.NC"
    f.write_text(PROGRAM)
    driver = SimulatedDriver(SimConfig(manual_clock=True))
    code, lines = _run(driver, f)
    assert code == send_program.OK
    assert any("identical" in ln for ln in lines)
    assert any("SENT OK" in ln for ln in lines)


def test_existing_program_needs_typed_replace(tmp_path: Path) -> None:
    f = tmp_path / "O1000.NC"
    f.write_text(PROGRAM)
    old = "%\nO1000(OLD)\nM30\n%\n"
    driver = SimulatedDriver(SimConfig(manual_clock=True, initial_programs={1000: old}))
    code, lines = _run(driver, f, answer="no")
    assert code == send_program.FAIL
    assert any("CANCELLED" in ln for ln in lines)

    driver = SimulatedDriver(SimConfig(manual_clock=True, initial_programs={1000: old}))
    code, lines = _run(driver, f, answer="REPLACE O1000")
    assert code == send_program.OK


def test_bad_file_is_refused(tmp_path: Path) -> None:
    f = tmp_path / "bad.NC"
    f.write_text("G21\nM30\n")
    code, lines = _run(SimulatedDriver(SimConfig(manual_clock=True)), f)
    assert code == send_program.FAIL
