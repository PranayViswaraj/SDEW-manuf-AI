"""Bridge entry point:  manufai-bridge --config config.yaml"""

import argparse
import asyncio
import contextlib
import logging
import signal
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from bridge import __version__
from bridge.actions import MachineEntry
from bridge.config import BridgeConfig, MachineConfig, load_config
from bridge.drivers.base import MachineDriver
from bridge.drivers.focas import FocasConfig, FocasDriver
from bridge.drivers.simulated import SimConfig, SimulatedDriver
from bridge.ws_client import BridgeService


def build_driver(cfg: BridgeConfig, m: MachineConfig) -> MachineDriver:
    if m.driver == "simulated":
        return SimulatedDriver(
            SimConfig(
                block_time_s=m.sim_block_time_s,
                remote_control_enabled=m.remote_control_enabled,
                pmc_start_address=m.pmc_start_address,
                auto_cycle_start_after_s=m.sim_auto_cycle_start_after_s,
            )
        )
    return FocasDriver(
        FocasConfig(
            ip=m.ip,
            port=m.port,
            library_path=cfg.focas_library_path,
            timeout_s=cfg.focas_timeout_s,
            remote_control_enabled=m.remote_control_enabled,
            pmc_start_address=m.pmc_start_address,
            pmc_feed_hold_address=m.pmc_feed_hold_address,
            pmc_reset_address=m.pmc_reset_address,
        )
    )


def build_machines(cfg: BridgeConfig) -> dict[str, MachineEntry]:
    return {m.id: MachineEntry(config=m, driver=build_driver(cfg, m)) for m in cfg.machines}


def setup_logging(log_file: str) -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    Path(log_file).parent.mkdir(parents=True, exist_ok=True)
    fh = RotatingFileHandler(log_file, maxBytes=5_000_000, backupCount=10, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    root.handlers[:] = [fh, sh]


async def serve(cfg: BridgeConfig) -> None:
    service = BridgeService(cfg, build_machines(cfg))
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, RuntimeError):  # Windows
            loop.add_signal_handler(sig, service.stop)
    await service.run_forever()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="manufai-bridge")
    parser.add_argument("--config", default="config.yaml", help="path to bridge YAML config")
    parser.add_argument("--check", action="store_true", help="validate config and exit")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    print(f"ManufAI bridge {__version__}: config OK, {len(cfg.machines)} machine(s).")
    for m in cfg.machines:
        remote = "ON" if m.remote_control_enabled else "off"
        print(f"  - {m.id}: driver={m.driver} {m.ip}:{m.port} remote control {remote}")
    if args.check:
        return 0
    setup_logging(cfg.log_file)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(serve(cfg))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
