# Architecture

```
 Browser (web/)                 Cloud (server/)                     Factory LAN
 ┌──────────────┐  HTTPS/JSON  ┌───────────────────────┐   wss    ┌──────────────┐  FOCAS2 TCP 8193  ┌──────────────┐
 │ React UI     │ ───────────► │ FastAPI               │ ◄─────── │ bridge/      │ ────────────────► │ FANUC 0i-TF  │
 │ (engineer,   │              │  auth, machines,      │ outbound │  ws_client   │                   │ LMW lathe    │
 │  programmer, │              │  programs, approval,  │  only    │  actions     │                   └──────────────┘
 │  operator)   │              │  run_control, audit   │          │  drivers/    │
 └──────────────┘              │ PostgreSQL / SQLite   │          │  (focas|sim) │
                               └───────────────────────┘          └──────────────┘
```

## Key decisions

- **Bridge dials out.** The factory PC opens a single outbound WebSocket to the server. No inbound
  ports on the factory network (safety rule 5).
- **Allow-listed actions only.** The bridge executes five actions and nothing else (rule 6).
- **Deterministic program generation.** G-code is produced and validated by fixed code in
  `server/app/gcode/`. AI is used only to read drawings into a feature table that an engineer must
  confirm (rule 2).
- **Driver interface.** `bridge/drivers/base.py` defines `MachineDriver`; `simulated.py` is used for
  development and tests until the licensed FOCAS library and the real machine are available.
- **App factory.** `server/app/main.py:create_app(settings)` builds the engine and session factory per
  app instance, so tests run against isolated SQLite databases with no global state.
- **Append-only audit log.** Every machine-affecting action writes an audit row *before* acting and
  another with the result (rule 7).

## Data flow for one part (target)

1. Upload drawing → `DrawingReader` (stub) → feature table → engineer confirms each value.
2. Capability check (rules) → list capable, online, idle machines.
3. Program generation (fixed code, later) or a stored approved program → validator → backplot.
4. Programmer approves (bound to content hash).
5. Operator: material + checklist → `send_program` → bridge downloads, uploads back, verifies hash.
6. Cycle Start at the machine (or remote `start` if ever enabled) → live status → first-piece result.

## Live status and commands (Milestone 8)

- `server/app/services/bridge_hub.py` keeps connected bridges, the latest status per machine and
  pending command acks **in memory**. First release assumption: **one server process**. Running
  several workers would need this state in a shared store (e.g. Redis pub/sub).
- Live states: `online`, `machine_unreachable`, `stale` (> `MANUFAI_STATUS_STALE_SECONDS`, default 5),
  `offline` (bridge not connected).
- `server/app/services/run_control.py: execute_machine_action` is the only path to a machine:
  checks -> audit "requested" -> signed command -> ack -> audit result.
- Command signature: HMAC-SHA256 over canonical JSON with the bridge's signing key
  (`server/app/services/command_signing.py` <-> `bridge/bridge/signing.py`).

## Production plumbing

- `server/app/observability.py`: request ID per request (`X-Request-ID`), JSON or text logs with
  the request ID, one access-log line per request, security headers (HSTS when enabled), and a
  clean JSON 500 with a reference id (no internal details leak).
- `server/app/auth/login_guard.py`: login lock-out per username + client address.
- `server/app/config.py: production_problems`: settings refused when `MANUFAI_ENV=production`.
- `server/app/api/health.py`: `/api/health` (liveness) and `/api/ready` (DB + migration head).
- `server/app/cli.py`: admin tool (`check`, `create-user`, `set-password`, `deactivate`,
  `list-users`, `create-bridge`).
- Graceful shutdown closes bridge WebSockets (code 1001) so bridges reconnect cleanly.

