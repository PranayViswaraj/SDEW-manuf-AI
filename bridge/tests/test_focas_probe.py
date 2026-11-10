import importlib.util
import socket
from pathlib import Path
from types import ModuleType

import pytest

TOOL = Path(__file__).resolve().parents[1] / "tools" / "focas_probe.py"
TEST_PROGRAM = "%\nO1234(PROBE TEST)\nG28U0W0\nG0X20.0Z5.0\nM30\n%\n"


@pytest.fixture(scope="module")
def probe() -> ModuleType:
    spec = importlib.util.spec_from_file_location("focas_probe", TOOL)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(
    probe: ModuleType, capsys: pytest.CaptureFixture[str], *argv: str, answer: str = ""
) -> tuple[int, str]:
    code = probe.main(list(argv), ask=lambda _prompt: answer)
    return code, capsys.readouterr().out


def test_simulated_read_only(probe: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    code, out = run(probe, capsys, "--simulate")
    assert code == 0
    assert "[1] TCP connect" in out and "SKIP" in out
    assert "[2] Open FOCAS handle" in out and "[3] Read status" in out
    assert "5 programs" in out and "O0001" in out and "3773480M01 SLEEVE 4WD" in out
    assert "RESULT: PASS" in out


def test_simulated_upload(
    probe: ModuleType, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    dest = tmp_path / "O0004.nc"
    code, out = run(probe, capsys, "--simulate", "--upload", "O0004", "--out", str(dest))
    assert code == 0 and "PASS" in out
    text = dest.read_text()
    assert "\r" not in text and "SLEEVE COMPACT" in text


def test_roundtrip_with_confirmation(
    probe: ModuleType, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    f = tmp_path / "t.nc"
    f.write_text(TEST_PROGRAM)
    code, out = run(
        probe,
        capsys,
        "--simulate",
        "--roundtrip",
        str(f),
        "--number",
        "O9001",
        "--repeat",
        "5",
        answer="WRITE O9001",
    )
    assert code == 0, out
    assert "5/5 identical, O9001 deleted" in out


def test_roundtrip_needs_typed_confirmation(
    probe: ModuleType, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    f = tmp_path / "t.nc"
    f.write_text(TEST_PROGRAM)
    _, out = run(
        probe, capsys, "--simulate", "--roundtrip", str(f), "--number", "O9001", answer="yes"
    )
    assert "not confirmed" in out and "identical" not in out


def test_roundtrip_refuses_existing_number(
    probe: ModuleType, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    f = tmp_path / "t.nc"
    f.write_text(TEST_PROGRAM)
    code, out = run(
        probe,
        capsys,
        "--simulate",
        "--roundtrip",
        str(f),
        "--number",
        "O0001",
        answer="WRITE O0001",
    )
    assert code == 1
    assert "O0001 already exists" in out


def test_renumber(probe: ModuleType) -> None:
    out = probe.renumber("%\r\nO1234(X)\r\nM30\r\n%", 9001)
    assert out.splitlines()[1] == "O9001(X)"


def test_tcp_failure_is_reported(probe: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens here now
    code, out = run(probe, capsys, "--ip", "127.0.0.1", "--port", str(port), "--timeout", "1")
    assert code == 1 and "FAIL" in out and "Ethernet cable" in out


def test_missing_library_is_reported(probe: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    try:
        code, out = run(
            probe, capsys, "--ip", "127.0.0.1", "--port", str(port), "--lib", "nope.dll"
        )
    finally:
        srv.close()
    assert code == 1
    assert "[1] TCP connect" in out and "PASS" in out
    assert "FOCAS library not found" in out


def test_requires_ip_or_simulate(probe: ModuleType) -> None:
    assert probe.main([]) == 2
