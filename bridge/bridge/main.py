"""Bridge entry point. Service loop (WebSocket, polling, commands) arrives in Milestone 8."""

import argparse
import sys

from bridge import __version__
from bridge.config import load_config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="manufai-bridge")
    parser.add_argument("--config", default="config.yaml", help="path to bridge YAML config")
    parser.add_argument("--check", action="store_true", help="validate config and exit")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    print(f"ManufAI bridge {__version__}: config OK, {len(cfg.machines)} machine(s).")
    if args.check:
        return 0
    print("Service loop not implemented yet (Milestone 8).", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
