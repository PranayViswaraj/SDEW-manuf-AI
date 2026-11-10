"""Watch the simulated FANUC 0i-TF run a program. No server, no real machine.

    python bridge/tools/sim_demo.py                       # runs samples/demo/O9000
    python bridge/tools/sim_demo.py --program samples/programs/O0001 --block-time 0.05

The simulated operator presses Cycle Start at the "panel" after one second.
"""

import argparse
import asyncio
from pathlib import Path

from bridge.drivers.base import RunState
from bridge.drivers.simulated import SimConfig, SimulatedDriver

DEFAULT_PROGRAM = Path(__file__).resolve().parents[2] / "samples" / "demo" / "O9000"


def _line(status_dict: dict[str, object]) -> str:
    s = status_dict
    return (
        f"{str(s['timestamp'])[11:19]}  mode={s['mode']:<4} run={s['run_state']:<9} "
        f"prog=O{s['program_number'] or 0:04d} N{s['sequence_number'] or '-':<4} "
        f"spindle={s['spindle_speed']:>6.0f} rpm  parts={s['part_count']}  alarm={s['alarm']}"
    )


async def run(program: Path, block_time: float, max_seconds: float) -> int:
    text = program.read_bytes().decode("ascii", errors="replace")
    sim = SimulatedDriver(SimConfig(block_time_s=block_time, auto_cycle_start_after_s=1.0))
    await sim.connect()
    number = await sim.download_program(text)
    await sim.select_main_program(number)
    print(f"Loaded O{number:04d}. Simulated operator presses Cycle Start in 1 s.\n")
    elapsed, last = 0.0, ""
    try:
        while elapsed < max_seconds:
            st = await sim.read_status()
            line = _line(st.to_dict())
            if line[10:] != last[10:]:
                print(line)
                last = line
            if st.run_state == RunState.STOPPED:
                print("  (program stop M00 - simulated operator presses Cycle Start)")
                sim.press_cycle_start()
            if st.part_count and st.run_state == RunState.IDLE:
                print("\nProgram finished (M30). Part count +1.")
                return 0
            await asyncio.sleep(0.05)
            elapsed += 0.05
    finally:
        await sim.disconnect()
    print("\nStopped after time limit (program may loop with M99).")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--program", type=Path, default=DEFAULT_PROGRAM)
    p.add_argument("--block-time", type=float, default=0.1, help="seconds per block")
    p.add_argument("--max-seconds", type=float, default=60.0)
    a = p.parse_args(argv)
    return asyncio.run(run(a.program, a.block_time, a.max_seconds))


if __name__ == "__main__":
    raise SystemExit(main())
