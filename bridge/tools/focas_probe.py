"""FOCAS probe: first-day connection test for the FANUC 0i-TF. No server needed.

Read-only by default:
    python focas_probe.py --ip 192.168.x.x --port 8193 --lib path\\to\\Fwlib64.dll

Save one program from the CNC to a file:
    python focas_probe.py --ip ... --lib ... --upload O0001 [--out O0001.nc]

Write test (needs a typed confirmation; refuses to overwrite an existing program number):
    python focas_probe.py --ip ... --lib ... --roundtrip test.nc --number O9001 [--repeat 20]

Without a machine:
    python focas_probe.py --simulate [--upload O0001] [--roundtrip FILE --number O9001]
"""

import argparse
import asyncio
import re
import socket
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from bridge.drivers.base import (
    DEFAULT_FOLDER,
    DriverError,
    MachineDriver,
    ProgramFormatError,
    ProgramNotFound,
    RunState,
    format_o_number,
    parse_o_number,
)
from bridge.drivers.focas import FocasConfig, FocasDriver
from bridge.drivers.simulated import SimConfig, SimulatedDriver
from bridge.focas_ctypes import FocasLibraryNotFound
from bridge.program_text import canonical, program_lines, to_send_format

SAMPLES = Path(__file__).resolve().parents[2] / "samples" / "programs"
Out = Callable[[str], None]


@dataclass
class Report:
    out: Out
    results: list[tuple[str, str]] = field(default_factory=list)

    def line(self, step: int, title: str, status: str, detail: str = "") -> None:
        self.results.append((title, status))
        dots = "." * max(3, 44 - len(title))
        self.out(f"[{step}] {title} {dots} {status}{('  ' + detail) if detail else ''}")

    @property
    def failed(self) -> bool:
        return any(s == "FAIL" for _, s in self.results)


async def _timed(coro: Awaitable[Any]) -> tuple[Any, float]:
    t0 = time.perf_counter()
    result = await coro
    return result, (time.perf_counter() - t0) * 1000


def tcp_check(ip: str, port: int, timeout: float) -> float:
    t0 = time.perf_counter()
    with socket.create_connection((ip, port), timeout=timeout):
        pass
    return (time.perf_counter() - t0) * 1000


def renumber(text: str, number: int) -> str:
    lines = program_lines(text)
    if not lines or not re.match(r"^\s*O\d{1,4}", lines[0], re.IGNORECASE):
        raise ProgramFormatError("Test program must start with an O-number line.")
    lines[0] = re.sub(r"^\s*O\d{1,4}", format_o_number(number), lines[0], flags=re.IGNORECASE)
    return to_send_format("\n".join(lines))


def make_driver(args: argparse.Namespace) -> MachineDriver:
    if args.simulate:
        initial = {}
        for f in sorted(SAMPLES.glob("O[0-9][0-9][0-9][0-9]")):
            initial[parse_o_number(f.name)] = f.read_bytes().decode("ascii", errors="replace")
        return SimulatedDriver(SimConfig(manual_clock=True, initial_programs=initial))
    return FocasDriver(
        FocasConfig(
            ip=args.ip,
            port=args.port,
            library_path=args.lib,
            timeout_s=args.timeout,
            connect_attempts=2,
        )
    )


async def probe(
    args: argparse.Namespace, out: Out = print, ask: Callable[[str], str] = input
) -> int:
    rep = Report(out)
    target = "SIMULATED 0i-TF" if args.simulate else f"{args.ip}:{args.port}"
    out(f"ManufAI FOCAS probe - target {target}")
    out("Read-only unless --roundtrip is given.\n")

    # 1. TCP
    if args.simulate:
        rep.line(1, "TCP connect", "SKIP", "(simulated machine)")
    else:
        try:
            ms = tcp_check(args.ip, args.port, args.timeout)
            rep.line(1, f"TCP connect {args.ip}:{args.port}", "PASS", f"{ms:.0f} ms")
        except OSError as e:
            rep.line(1, f"TCP connect {args.ip}:{args.port}", "FAIL", str(e))
            out("\nCheck: machine powered on, Ethernet cable, IP address, FOCAS port, firewall.")
            return 1

    driver = make_driver(args)
    try:
        # 2. FOCAS handle
        try:
            _, ms = await _timed(driver.connect())
            rep.line(2, "Open FOCAS handle", "PASS", f"{ms:.0f} ms")
        except (FocasLibraryNotFound, DriverError) as e:
            rep.line(2, "Open FOCAS handle", "FAIL", str(e))
            return 1

        # 3 + 4. status, program and sequence
        try:
            st, ms = await _timed(driver.read_status())
            alarm_txt = (
                ", ".join(f"{a.code} {a.message}" for a in st.alarms) if st.alarms else "none"
            )
            rep.line(
                3,
                "Read status",
                "PASS",
                f"mode={st.mode} run={st.run_state} alarm={alarm_txt} emergency={st.emergency}",
            )
            prog = format_o_number(st.program_number) if st.program_number else "none"
            rep.line(4, "Program / sequence number", "PASS", f"{prog} N{st.sequence_number or '-'}")
        except DriverError as e:
            rep.line(3, "Read status", "FAIL", str(e))
            return 1

        # 5. list programs
        try:
            progs, ms = await _timed(driver.list_programs(args.folder))
            rep.line(5, f"List programs in {args.folder}", "PASS", f"{len(progs)} programs")
            for p in progs[:50]:
                out(f"      {p.name}  {p.size:>6} B  {p.comment}")
            if len(progs) > 50:
                out(f"      ... {len(progs) - 50} more")
        except DriverError as e:
            rep.line(5, f"List programs in {args.folder}", "FAIL", str(e))
            progs = []

        # 6. optional upload
        if args.upload:
            await _step_upload(driver, args, rep)
        else:
            rep.line(6, "Read program from CNC", "SKIP", "(use --upload O0001)")

        # 7. optional roundtrip
        if args.roundtrip:
            await _step_roundtrip(driver, args, rep, ask, {p.number for p in progs})
        else:
            rep.line(7, "Write/read-back test", "SKIP", "(use --roundtrip FILE --number O9001)")
    finally:
        await driver.disconnect()
        if isinstance(driver, FocasDriver):
            await driver.close()

    out("\nRESULT: " + ("FAIL" if rep.failed else "PASS"))
    return 1 if rep.failed else 0


async def _step_upload(driver: MachineDriver, args: argparse.Namespace, rep: Report) -> None:
    title = f"Read {args.upload} from CNC"
    try:
        number = parse_o_number(args.upload)
        text, ms = await _timed(driver.upload_program(number, args.folder))
        out_path = Path(args.out or f"{format_o_number(number)}.nc")
        out_path.write_text(text, encoding="ascii", newline="\n")
        rep.line(6, title, "PASS", f"{len(text)} bytes -> {out_path} ({ms:.0f} ms)")
    except (DriverError, OSError) as e:
        rep.line(6, title, "FAIL", str(e))


async def _step_roundtrip(
    driver: MachineDriver,
    args: argparse.Namespace,
    rep: Report,
    ask: Callable[[str], str],
    existing: set[int],
) -> None:
    title = "Write/read-back test"
    if not args.number:
        rep.line(7, title, "FAIL", "--number is required with --roundtrip (e.g. O9001)")
        return
    try:
        number = parse_o_number(args.number)
        text = renumber(Path(args.roundtrip).read_bytes().decode("ascii"), number)
    except (DriverError, OSError, UnicodeDecodeError) as e:
        rep.line(7, title, "FAIL", str(e))
        return
    name = format_o_number(number)

    # Refuse to overwrite: check the list AND try to read it.
    exists = number in existing
    if not exists:
        try:
            await driver.upload_program(number, args.folder)
            exists = True
        except ProgramNotFound:
            pass
        except DriverError:
            exists = True  # cannot prove it is free: refuse
    if exists:
        rep.line(
            7, title, "FAIL", f"{name} already exists on the machine. Choose an unused number."
        )
        return

    st = await driver.read_status()
    if st.run_state != RunState.IDLE or st.alarm or st.emergency:
        rep.line(7, title, "FAIL", "Machine must be idle with no alarm and no emergency stop.")
        return

    rep.out(
        f"\n  WRITE TEST: will send {name} to {args.folder}, read it back and delete it, "
        f"{args.repeat} times."
    )
    typed = ask(f"  Type WRITE {name} to continue: ").strip()
    if typed != f"WRITE {name}":
        rep.line(7, title, "SKIP", "not confirmed")
        return

    ok = 0
    for i in range(1, args.repeat + 1):
        stored = False
        try:
            await driver.download_program(text, args.folder)
            stored = True
            back = await driver.upload_program(number, args.folder)
            if canonical(back) == canonical(text):
                ok += 1
            else:
                rep.out(f"      run {i}: MISMATCH between sent and read-back text")
        except DriverError as e:
            rep.out(f"      run {i}: {e}")
        finally:
            if stored:
                try:
                    await driver.delete_program(number, args.folder)
                except DriverError as e:
                    rep.out(f"      run {i}: could not delete {name}: {e}  << DELETE IT BY HAND")
                    break
    status = "PASS" if ok == args.repeat else "FAIL"
    rep.line(7, title, status, f"{ok}/{args.repeat} identical, {name} deleted")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="ManufAI FOCAS probe", formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--ip", help="machine IP address")
    p.add_argument("--port", type=int, default=8193)
    p.add_argument("--lib", help="path to Fwlib32.dll / Fwlib64.dll / libfwlib32.so")
    p.add_argument("--timeout", type=int, default=10, help="seconds")
    p.add_argument("--folder", default=DEFAULT_FOLDER)
    p.add_argument("--simulate", action="store_true", help="use the simulated 0i-TF")
    p.add_argument("--upload", metavar="O0001", help="read this program and save it")
    p.add_argument("--out", help="file for --upload (default O0001.nc)")
    p.add_argument("--roundtrip", metavar="FILE", help="test program to write and read back")
    p.add_argument("--number", metavar="O9001", help="UNUSED program number for --roundtrip")
    p.add_argument("--repeat", type=int, default=20)
    return p


def main(argv: list[str] | None = None, ask: Callable[[str], str] = input) -> int:
    args = build_parser().parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # factory PC consoles may not be UTF-8
    if not args.simulate and not args.ip:
        print("Give --ip (and --lib), or --simulate.", file=sys.stderr)
        return 2
    if args.repeat < 1:
        print("--repeat must be at least 1", file=sys.stderr)
        return 2
    return asyncio.run(probe(args, ask=ask))


if __name__ == "__main__":
    raise SystemExit(main())
