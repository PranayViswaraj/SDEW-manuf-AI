# ManufAI – Build Plan (source of truth)

Copied verbatim from the original build prompt (Phase 0 to 2 groundwork + platform skeleton).

---

## 1. Project context

You are building **ManufAI**, a system that takes a child part drawing and runs one machined piece on a CNC lathe from a computer.

Full flow (final product):
1. Engineer uploads a drawing.
2. AI reads the drawing into a feature table (diameters, lengths, chamfers, grooves, threads, tolerances, material, bar size).
3. Engineer confirms or corrects every value.
4. System lists machines that can make the part and are online and idle.
5. Engineer selects a machine.
6. **Fixed code (never AI)** generates the CNC program from the feature table, programmer templates and the machine tool list. A simulation shows the tool path.
7. Programmer approves the program.
8. Operator confirms raw material and a safety checklist on screen.
9. Program is sent to the machine over the network.
10. Operator presses Start in the web app. Feed hold and Stop stay available, with live status.
11. First piece is measured by hand and the result is logged. Passing programs are saved for that part number.

**First release:** one lathe, one simple turned part, one piece at a time.

### Machine facts (known)
- Controller: **FANUC Series 0i-TF** (LMW CNC lathe).
- Ethernet port available on the cabinet. Communication will use **FANUC FOCAS2 over Embedded Ethernet** (default TCP port 8193).
- Programs are stored in `//CNC_MEM/USER/PATH1/` with folders (for example `/SLEEVE/`).
- Program style: FANUC lathe G-code, diameter programming on X, `G28U0W0` home, `G97 S.. M4`, `T0101` style tool calls, canned cycles `G71`, `G72`, `G74`, `G83`, chamfer by angle `A..`, `M00`/`M01` stops, `M99Pn` at program start to skip to a block, two operations per part marked `(1ST OPN)` and `(2ND OPN)`.

### Not yet available (do NOT invent these)
- Part drawings.
- Machine nameplate / exact machine limits (max diameter, max length, spindle range, chuck size).
- Turret tool layout, offsets, cutting speeds and feeds.
- The FANUC FOCAS library file (`Fwlib32.dll` / `Fwlib64.dll` on Windows, `libfwlib32.so` on Linux). This is licensed from FANUC and will be supplied later.
- The PMC address that would allow Cycle Start / Feed hold from a PC (needs a machine ladder change; may never be possible).

Everything depending on these must be **configurable placeholders** with clear `TODO` markers, and must work against a **simulated machine** until the real one is connected.

---

## 2. Non-negotiable safety rules (enforce in code, add tests for each)

1. Software never replaces the physical emergency stop. Never present any button as an emergency stop.
2. The AI never writes or edits CNC programs. Program generation is deterministic code only.
3. No program can be sent to a machine unless: feature table is confirmed by an engineer AND the program is approved by a programmer for that exact part + machine + program version (content hash).
4. Start unlocks only when: every safety checklist item is ticked in this session, the machine reports no alarm, the machine is idle, the approved program is loaded, and the user is on the allowed-to-start list.
5. The bridge connects **outward only** to the ManufAI server. It never opens a listening port to the internet.
6. The bridge accepts only these actions: `send_program`, `start`, `feed_hold`, `stop`, `read_status`. Anything else is rejected and logged.
7. Every action is logged: user, machine, program, program hash, action, result, timestamp. The log is append-only.
8. If the bridge loses connection to the server, it must not take any machine action on its own. Status shows as stale/offline in the UI after 5 seconds without updates.
9. `start`, `feed_hold` and `stop` must be disabled by default in config (`remote_control_enabled: false`). When disabled, the UI shows "Press Cycle Start at the machine".

---

## 3. Tech stack

- **Backend (cloud):** Python 3.11+, FastAPI, SQLAlchemy 2, Alembic, Pydantic v2. PostgreSQL in production, SQLite for local dev.
- **Frontend:** React + Vite + TypeScript, Tailwind CSS. Simulation view using HTML canvas or SVG.
- **Bridge (factory PC):** Python 3.11+, runs on Windows (FOCAS DLL is most common there) and Linux. Talks to the server over a single outbound **WebSocket (wss)** with token auth and auto-reconnect.
- **Machine driver:** Python `ctypes` wrapper around FOCAS2, behind an interface, with a **simulated driver** implementation.
- **Tests:** pytest (backend, bridge), Vitest (frontend).
- **Dev:** docker-compose for backend + Postgres + frontend. `.env.example` for all settings. Ruff + Black + mypy for Python, ESLint + Prettier for TS.

---

## 4. Repository structure

```
manufai/
  README.md
  docker-compose.yml
  .env.example
  docs/
    architecture.md
    safety-rules.md
    focas-notes.md
  server/
    app/
      main.py
      config.py
      db/ (models, session, migrations)
      auth/ (login, roles, users)
      api/ (machines, programs, runs, logs, materials, bridge_ws)
      services/ (capability_check, program_store, approval, run_control, audit_log)
      gcode/ (parser, validator, backplot)
    tests/
  bridge/
    bridge/
      main.py
      config.py
      ws_client.py
      actions.py           # allow-list dispatcher
      drivers/
        base.py            # MachineDriver interface
        simulated.py       # fake FANUC 0i-TF
        focas.py           # ctypes FOCAS2 driver
      focas_ctypes.py      # struct + function definitions
    tools/
      focas_probe.py       # standalone connection test script
    config.example.yaml
    tests/
  web/
    src/
      pages/ (Login, Machines, MachineDetail, Programs, ProgramDetail, Run, Logs, Materials)
      components/ (StatusBadge, Checklist, ToolpathView, ConfirmDialog)
      api/
    tests/
  samples/
    programs/              # put the 5 trusted O-files here (O0001, O0002, O0003, O0004, O0009)
```

---

## 5. Milestones

### Milestone 1 – Repo skeleton and dev environment
- Create the structure above, docker-compose, `.env.example`, linting, a README with setup steps for Windows and Linux.
- Health endpoint `GET /api/health`.
- **Done when:** `docker compose up` starts server, DB and web; tests run with one command.

### Milestone 2 – Users, roles and audit log
- Roles: `admin`, `engineer`, `programmer`, `operator`. A user can have several roles.
- Separate flag `can_start_machine` (the "allowed to press Start" list, set by admin).
- JWT login, password hashing (argon2 or bcrypt).
- `audit_log` table: append-only (no update/delete endpoints; add a DB trigger or app-level guard), fields: id, timestamp (UTC), user_id, machine_id, program_id, program_hash, action, payload (JSON), result, error.
- **Done when:** tests prove role checks on every endpoint and that audit rows cannot be modified.

### Milestone 3 – Machine register
- `machines` table: name, make, model, controller (`FANUC 0i-TF`), ip_address, focas_port (default 8193), status, bridge_id, `remote_control_enabled` (default false), and a JSON `limits` object: max_turning_diameter, max_turning_length, max_bar_diameter, spindle_rpm_min/max, chuck_size, turret_stations — all nullable with `TODO: from nameplate`.
- `tools` table per machine: station number, tool number/offset (e.g. `T0101`), description, insert type, nose radius, tool type (OD rough, OD finish, bore, drill, groove, thread, stopper). All editable from UI.
- Seed one machine: "LMW Lathe 1, FANUC 0i-TF" with empty limits.
- Admin UI to view and edit machines and tools.
- **Done when:** CRUD works with validation and tests.

### Milestone 4 – Raw material register
- `materials` table: grade, bar diameter, available length, stock quantity, notes.
- CSV/XLSX import endpoint and UI (the company already has a raw material register; make column mapping configurable).
- **Done when:** a sample CSV imports, duplicates are handled, and materials are searchable.

### Milestone 5 – Machine driver interface + simulated FANUC
`MachineDriver` interface (async):
- `connect()`, `disconnect()`
- `read_status() -> MachineStatus` with: mode (MEM, EDIT, MDI, JOG, etc.), run state (idle, running, feed_hold, stopped), alarm (bool + list of codes/messages), emergency (bool), current program number, current block/sequence number, spindle speed, feed override %, part count, timestamp.
- `list_programs(folder)`
- `upload_program(number) -> str` (read program text from CNC)
- `download_program(text, folder)` (send program to CNC)
- `delete_program(number)`
- `select_main_program(number)`
- `cycle_start()`, `feed_hold()`, `reset_stop()` — raise `RemoteControlNotAvailable` unless enabled in config with a configured PMC address.

Simulated driver:
- Behaves like a FANUC 0i-TF: keeps programs in memory, enforces O-number format, rejects download while running, simulates running through blocks over time, can inject alarms and connection drops (configurable) for testing.
- **Done when:** full driver test suite passes against the simulator.

### Milestone 6 – FOCAS2 ctypes driver (code now, test later on the real machine)
- Load the library from a configurable path. If missing, fail with a clear message ("FOCAS library not found – obtain Fwlib from FANUC/machine supplier").
- Wrap at least: `cnc_allclibhndl3`, `cnc_freelibhndl`, `cnc_statinfo`, `cnc_rdprgnum`, `cnc_rdseqnum`, `cnc_alarm2` / `cnc_rdalmmsg2`, `cnc_acts` (spindle), `cnc_rdparam` where useful, `cnc_rdprogdir3` (program list), `cnc_upstart4` / `cnc_upload4` / `cnc_upend4`, `cnc_dwnstart4` / `cnc_download4` / `cnc_dwnend4`, `cnc_delall`-style delete only for single programs (`cnc_pdf_del` or `cnc_delete`), `cnc_pdf_slctmain` for main program selection, `pmc_rdpmcrng` / `pmc_wrpmcrng` for the future start signal.
- Verify every function signature and struct layout against the official FOCAS2 documentation; mark anything uncertain with `# VERIFY ON MACHINE`.
- Map FANUC return codes (EW_OK, EW_SOCKET, EW_HANDLE, EW_BUSY, etc.) to clear Python exceptions.
- Handle FANUC program text format: `%` start/end, LF line endings when sending, strip `\r` duplicates when receiving.
- Use a short timeout (configurable, default 10 s), reconnect with backoff, one handle per thread.
- **Done when:** unit tests pass with a mocked library, and code paths are documented in `docs/focas-notes.md`.

### Milestone 7 – FOCAS probe tool (for the first day at the machine)
`bridge/tools/focas_probe.py` — a standalone CLI script, no server needed:
```
python focas_probe.py --ip 192.168.x.x --port 8193 --lib path\to\Fwlib32.dll
```
Steps, printed clearly with PASS/FAIL:
1. Ping / TCP connect to ip:port.
2. Open FOCAS handle.
3. Read status (mode, run state, alarm, emergency).
4. Read current program number and sequence number.
5. List programs in `//CNC_MEM/USER/PATH1/`.
6. Optional `--upload O0001`: read a program and save it to a file.
7. Optional `--roundtrip FILE --number O9001`: download a test program to an unused number, upload it back, compare byte-for-byte (normalised line endings), repeat N times (default 20), then delete it. Refuse to overwrite an existing program number.
- Read-only by default; write actions need explicit flags and a typed confirmation.
- **Done when:** runs against the simulated driver with `--simulate`.

### Milestone 8 – Bridge service
- Config YAML: server URL, bridge token, list of machines (id, ip, port, driver type `simulated|focas`), poll interval (default 1 s), `remote_control_enabled` per machine.
- One outbound WebSocket to the server; auto-reconnect with backoff; heartbeat every 2 s.
- Polls each machine and pushes status messages.
- Receives commands as signed JSON messages: `{id, action, machine_id, program_id, program_hash, user_id, issued_at}`. Rejects: unknown actions, expired commands (older than 10 s), wrong machine, hash mismatch.
- Before `send_program`: machine must be idle with no alarm. After download, upload it back and verify the hash; report failure if different.
- Before `start`: re-check idle, no alarm, no emergency, correct program selected.
- Sends an ack for every command with result and error details.
- Local rotating log file.
- Runs as a Windows service (document NSSM or `pywin32`) and a systemd service on Linux.
- **Done when:** end-to-end tests with server + bridge + simulated driver pass, including connection drops.

### Milestone 9 – Programs, approval and G-code validator
- Upload/store programs (text), with part number, machine, version, SHA-256 hash, status (`draft`, `approved`, `rejected`, `retired`), approved_by, approved_at.
- Any change to program text creates a new version and clears approval.
- Import the 5 trusted O-files from `samples/programs/` as approved programs ("trusted, supplied by company") for LMW Lathe 1.
- **Validator** (fixed rules, no AI): checks `%` and `O` number header, balanced parentheses, known G/M codes for 0i-TF lathe, tool calls exist in the machine tool list (warning only while tool list is empty), spindle speed within limits (skip if limits unknown), program ends with `M30` or `M99`, flags `M00` stops, flags multiple operations (`1ST OPN` / `2ND OPN`), flags `M99Pn` skip lines. Output: errors (block send) and warnings (show to programmer).
- **Done when:** all 5 sample programs parse and validate with only expected warnings.

### Milestone 10 – Simulation view (tool path backplot)
- Parse lathe G-code into a path: `G0`, `G1`, `G2`, `G3` (with R and I/K), absolute X/Z and incremental U/W, diameter mode on X, `G28` handling, `A` angle chamfer moves.
- Expand canned cycles `G71`, `G72` (using P/Q blocks), `G74`, `G83`, `G76` (draw thread passes simply); if a cycle can't be expanded, draw its finish profile and show a warning.
- Draw in X–Z plane (Z horizontal, X radius vertical), rapid moves dashed, feed moves solid, colour per tool. Show the stock outline when bar size is known.
- Step-through slider by block, with the current block's text highlighted.
- **Done when:** all 5 sample programs render without errors, verified visually.

### Milestone 11 – Run screen
- Select machine → shows live status (mode, run state, alarm list, program, block, spindle, override), with a stale/offline badge.
- Select an **approved** program → shows the raw material required (from the materials register; field is manual entry until drawings exist).
- Safety checklist (must all be ticked, reset after each run): correct raw material loaded, tools and offsets match the program, chuck clamped, door closed, no alarm on machine, operator at machine.
- Buttons: **Send program**, **Start**, **Feed hold**, **Stop**. Start enabled only per safety rule 4. If remote control is disabled, show "Program sent. Press Cycle Start at the machine." and still track the run from status.
- Add a confirmation dialog before Send and Start.
- After the run: first piece result form (pass/fail, measured values, notes) saved against the program version. On pass, mark the program "proven" for that part number.
- **Done when:** a full simulated run works end to end and every step appears in the audit log.

### Milestone 12 – Feature table screen (UI only, no AI yet)
- Data model for a turned part: part number, material grade, bar diameter, overall length, and an ordered list of features: OD (diameter, length, tolerance), ID/bore, face, chamfer (size × angle), radius, groove (diameter, width, position), thread (size, pitch, length), drill (diameter, depth), each with tolerance fields.
- Screen where each value has an "AI value" and a "confirmed value"; nothing proceeds until every value is confirmed by an engineer.
- Leave the drawing reader as a stub interface `DrawingReader.read(file) -> FeatureTable` that returns an empty table. The real AI reader comes later.
- **Done when:** a feature table can be created by hand, confirmed and stored, with confirmed_by/confirmed_at.

### Milestone 13 – Capability check (rules only)
- Function: `(feature_table, machine) -> (capable: bool, reasons: list)` using limits and tool list. Unknown limits → result "Unknown – machine limits not entered" (never assume capable).
- Machine list page shows only machines that are capable, online and idle, with reasons for excluded ones.
- **Done when:** unit tests cover pass, fail and unknown cases.

---

## 6. Explicitly out of scope for now

- The AI drawing reader (needs real drawings).
- The program generator from feature tables (needs drawings, tool layout, speeds/feeds and programmer templates). Only create an empty `ProgramGenerator` interface with a docstring.
- Batch runs, bar feeder, VMC, pipe benders, automatic inspection.

---

## 7. Coding rules

- Type hints everywhere; small functions; no hidden global state.
- All settings from env/config files; no hard-coded IPs, tokens or paths.
- Every write to a machine goes through one function that checks permissions, writes the audit log first, then acts, then logs the result.
- Clear, plain-English error messages for operators.
- Write tests alongside each feature. Do not mark a milestone done with failing tests.
- When something depends on missing real-world info, add a `TODO(REAL-DATA):` comment and list it in `docs/open-items.md`.
