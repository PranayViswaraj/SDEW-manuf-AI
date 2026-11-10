#!/usr/bin/env bash
# One-time local setup on Linux/macOS. Usage (from repo root):  ./scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e "./server[dev]" -e "./bridge[dev]"
(cd web && npm install)
[ -f .env ] || cp .env.example .env
echo "Setup complete. Run ./scripts/test.sh to run all tests."
