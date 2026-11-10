#!/usr/bin/env bash
# Run every test suite and linter. Usage (from repo root):  ./scripts/test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$ROOT/.venv/bin/python" ]; then PY="$ROOT/.venv/bin/python"
elif [ -x "$ROOT/.venv/Scripts/python.exe" ]; then PY="$ROOT/.venv/Scripts/python.exe"
else echo "No .venv found. Run ./scripts/setup.sh first." >&2; exit 1; fi

FAILED=()
step() { local name="$1"; shift; echo; echo "=== $name ==="; "$@" || FAILED+=("$name"); }

cd "$ROOT/server"
step "server: ruff"   "$PY" -m ruff check .
step "server: black"  "$PY" -m black --check -q .
step "server: mypy"   "$PY" -m mypy app
step "server: pytest" "$PY" -m pytest -q

cd "$ROOT/bridge"
step "bridge: ruff"   "$PY" -m ruff check .
step "bridge: black"  "$PY" -m black --check -q .
step "bridge: mypy"   "$PY" -m mypy bridge
step "bridge: pytest" "$PY" -m pytest -q

cd "$ROOT/web"
step "web: eslint" npm run -s lint
step "web: tsc"    npm run -s typecheck
step "web: vitest" npm test --silent
step "web: build"  npm run -s build

if [ ${#FAILED[@]} -gt 0 ]; then echo; echo "FAILED: ${FAILED[*]}"; exit 1; fi
echo; echo "All checks passed."
