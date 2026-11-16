"""Send one accepted program file (e.g. O1000.NC downloaded from ManufAI) to the CNC over Ethernet.

    python send_program.py --ip 192.168.11.12 --lib path\\to\\Fwlib64.dll O1000.NC
    python send_program.py --simulate O1000.NC

Safe by design: the machine must be idle with no alarm; an existing program with the same number
is only replaced after a typed confirmation; the program is read back and compared line by line;
it is then made the main program so it shows on the CNC screen. Nothing is started: Cycle Start
is always pressed by the operator at the machine.
"""

import argparse
import asyncio
import sys
from collections.abc import Callable
from pathlib import Path

from bridge.drivers.base import (
    DEFAULT_FOLDER,
    DriverError,
    MachineDriver,
    ProgramNotFound,
    RunState,
    format_o_number,
)
from bridge.drivers.focas import FocasConfig, FocasDriver
from bridge.drivers.simulated import SimConfig, SimulatedDriver
from bridge.program_text import canonical, program_number_from_text, to_send_format

OK, FAIL = 0, 1


def make_driver(args: argparse.Namespace) -> MachineDriver:
    if args.simulate:
        return SimulatedDriver(SimConfig(manual_clock=True))
    return FocasDriver(
        FocasConfig(
            ip=args.ip,
            port=args.port,
            library_path=args.lib,
            timeout_s=args.timeout,
            connect_attempts=2,
        )
    )


async def send(
    driver: MachineDriver, path: Path, folder: str, ask: Callable[[str], str], out=print
) -> int:
    try:
        text = to_send_format(path.read_bytes().decode("ascii"))
        number = program_number_from_text(text)
    except (OSError, UnicodeDecodeError, DriverError) as e:
        out(f"FAIL  cannot use {path.name}: {e}")
        return FAIL
    name = format_o_number(number)
    lines = len(canonical(text).splitlines())
    out(f"Program file : {path.name}  ->  {name}, {lines} lines")

    try:
        await driver.connect()
    except DriverError as e:
        out(f"FAIL  cannot connect to the CNC: {e}")
        return FAIL
    try:
        st = await driver.read_status()
        out(f"CNC status   : mode={st.mode} run={st.run_state.value} alarm={st.alarm or 'none'}")
        if st.run_state != RunState.IDLE or st.alarm or st.emergency:
            out("FAIL  The machine must be idle, with no alarm and no emergency stop.")
            return FAIL

        try:
            await driver.upload_program(number, folder)
            exists = True
        except ProgramNotFound:
            exists = False
        if exists:
            out(f"\n  {name} is ALREADY on the CNC.")
            typed = ask(f"  Type REPLACE {name} to overwrite it (anything else cancels): ").strip()
            if typed.upper() != f"REPLACE {name}":
                out("CANCELLED  nothing was changed on the CNC.")
                return FAIL
            await driver.delete_program(number, folder)
            out(f"  old {name} deleted")

        out(f"Sending      : {name} ...")
        await driver.download_program(text, folder)
        back = await driver.upload_program(number, folder)
        if canonical(back) != canonical(text):
            out("FAIL  The program read back from the CNC is DIFFERENT from the file.")
            out(f"      Delete {name} on the CNC by hand and send again.")
            return FAIL
        out(f"Read back    : identical, {lines} lines  OK")

        try:
            await driver.select_main_program(number, folder)
            out(f"Selected     : {name} is now the main program on the CNC screen")
        except DriverError as e:
            out(f"Note         : could not select {name} ({e}). Open it on the CNC: PROG > {name}.")

        out(f"\nSENT OK  {name} is on the CNC. Check it on the screen, then follow the dry-run")
        out("steps. Cycle Start is pressed by the operator at the machine.")
        return OK
    except DriverError as e:
        out(f"FAIL  {e}")
        return FAIL
    finally:
        await driver.disconnect()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Send one program file to the CNC (ManufAI)")
    p.add_argument("file", help="program file, e.g. O1000.NC")
    p.add_argument("--ip", help="CNC IP address")
    p.add_argument("--port", type=int, default=8193)
    p.add_argument("--lib", help="path to Fwlib64.dll")
    p.add_argument("--timeout", type=int, default=10)
    p.add_argument("--folder", default=DEFAULT_FOLDER)
    p.add_argument("--simulate", action="store_true", help="use the simulated 0i-TF")
    return p


def main(argv: list[str] | None = None, ask: Callable[[str], str] = input) -> int:
    args = build_parser().parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    if not args.simulate and not args.ip:
        print("Give --ip and --lib, or --simulate.", file=sys.stderr)
        return FAIL
    return asyncio.run(send(make_driver(args), Path(args.file), args.folder, ask))


if __name__ == "__main__":
    sys.exit(main())
