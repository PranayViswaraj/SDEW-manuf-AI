# ManufAI

Takes a turned-part drawing and runs one machined piece on a CNC lathe (FANUC 0i-TF) from a computer,
with engineer confirmation, programmer approval and operator safety checks at every step.

> **Safety first.** Software never replaces the physical emergency stop. The AI never writes CNC
> programs. See [docs/safety-rules.md](docs/safety-rules.md).

## Parts

| Folder    | What                                                                      | Runs on            |
|-----------|---------------------------------------------------------------------------|--------------------|
| `server/` | FastAPI + SQLAlchemy + Alembic. Users, machines, programs, audit log.     | Cloud / server     |
| `web/`    | React + Vite + TypeScript + Tailwind UI.                                  | Browser            |
| `bridge/` | Outbound-only link from the factory PC to the machines (FOCAS2 or simulated). | Factory PC (Win/Linux) |
| `samples/programs/` | Trusted FANUC O-files supplied by the company.                  | –                  |
| `docs/`   | Architecture, safety rules, FOCAS notes, open items.                      | –                  |

## Prerequisites

- Python 3.11+
- Node.js 20+ (22 recommended)
- Docker Desktop (Windows) or Docker Engine + Compose plugin (Linux), for the full stack

## Option A: Full stack in Docker (server + Postgres + web)

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
docker compose up --build
```

- Web UI: http://localhost:5173
- API health: http://localhost:8000/api/health
- API docs: http://localhost:8000/docs

The server runs `alembic upgrade head` automatically on start.

## Option B: Local dev without Docker (SQLite)

**Windows (PowerShell)**
```powershell
.\scripts\setup.ps1                       # creates .venv, installs Python + npm deps, copies .env
cd server; ..\.venv\Scripts\alembic upgrade head
..\.venv\Scripts\uvicorn app.main:app --reload       # http://localhost:8000
# second terminal:
cd web; npm run dev                                  # http://localhost:5173
```
If PowerShell blocks scripts: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**Linux / macOS**
```bash
./scripts/setup.sh
cd server && ../.venv/bin/alembic upgrade head
../.venv/bin/uvicorn app.main:app --reload
# second terminal:
cd web && npm run dev
```

## Logging in (dev)

With `MANUFAI_SEED_DEV_DATA=true` (the default in `docker-compose.yml` and `.env.example`) the server
creates one user per role on start-up. **These passwords are public. Dev only.** Seeding is refused
when `MANUFAI_ENV=production`.

| Username     | Password              | Roles      | Allowed to press Start |
|--------------|-----------------------|------------|------------------------|
| `admin`      | `admin-dev-pass`      | admin      | no                     |
| `engineer`   | `engineer-dev-pass`   | engineer   | no                     |
| `programmer` | `programmer-dev-pass` | programmer | no                     |
| `operator`   | `operator-dev-pass`   | operator   | yes                    |

- **Users** page (admin): tick roles per user (a user can have several), and the separate
  **Allowed to press Start** list.
- **Audit log** page (admin): every action, newest first, filter by action. Entries cannot be edited
  or deleted: there is no API for it, the app blocks it, and database triggers block it too.

Without Docker, seed manually: `cd server; ..\.venv\Scripts\python -m app.seed` (set
`MANUFAI_SEED_DEV_DATA=true` in `.env` first).

## Machines (Milestone 3)

**Machines** page (any user) lists the machine register. The seed always creates
**LMW Lathe 1 – FANUC 0i-TF** with every unknown value left empty (model, IP, all limits).

Open a machine to:
- edit details and limits (admin). Empty limits show "Not entered – from nameplate" and stay
  `null` — they are never guessed, and unknown limits never count as "capable";
- add, edit and remove turret tools (admin or programmer): station, `T0101`-style tool/offset,
  description, insert, nose radius, type;
- turn remote control on/off (admin, with confirmation). It is off by default, and the bridge config
  must also enable it.

All changes are written to the audit log (`machine_update`, `tool_add`, `remote_control_changed`…).

## Raw materials (Milestone 4)

**Materials** page: search by grade/notes (`en8` finds `EN8`) or diameter range. Admin and
engineer can add/edit/delete rows and import the company register:

1. **Import CSV / XLSX** → choose the file. The server reads the header row and suggests which
   column is grade, bar diameter, length, quantity, notes.
2. Change any mapping in the drop-downs (your column names can be anything).
3. Choose what happens when a grade + diameter already exists: **skip** (keep existing) or **update**.
   Grades match ignoring case and spaces (`en 8` = `EN8`). Repeated rows inside the same file are
   reported and ignored.
4. **Check (dry run)** shows the result without saving; **Import** saves and writes an audit entry.

Numbers like `Ø25`, `25 mm` and `25,5` are understood. A sample file is in
`samples/materials/raw-material-register.sample.csv` (every row marked SAMPLE DATA); the dev seed
loads it into an empty table so the page is not empty.

## Simulated FANUC 0i-TF (Milestone 5)

Until the real machine is connected, everything runs against a simulated FANUC 0i-TF
(`bridge/bridge/drivers/simulated.py`). Watch it run a program:

```bash
.venv/Scripts/python bridge/tools/sim_demo.py                    # Windows (Git Bash) / use .venv\Scripts\python in PowerShell
.venv/bin/python bridge/tools/sim_demo.py --program samples/programs/O0001 --block-time 0.05
```

It prints mode, run state, program, sequence number, spindle speed and part count as they change.
`samples/demo/O9000` is a synthetic demo program for the simulator only (**not for machine use**).

## First day at the machine (Milestone 7)

Goal: prove the factory PC can talk to the FANUC 0i-TF over FOCAS2 **before** connecting ManufAI.
Bring: the factory PC with this repo + `.venv`, the FANUC FOCAS library (`Fwlib64.dll` and its
companion DLLs, from FANUC / the machine supplier), an Ethernet cable, and someone allowed to change
CNC settings.

1. **At the CNC**: check Embedded Ethernet is enabled, note the IP address, subnet and FOCAS port
   (default 8193). Put the PC on the same subnet. Note the machine is idle and has no alarm.
2. **Read-only probe** (changes nothing on the machine):
   ```powershell
   .venv\Scripts\python bridge	oolsocas_probe.py --ip 192.168.x.x --port 8193 --lib C:\manufaiwlib\Fwlib64.dll
   ```
   Expect PASS for: TCP connect, Open FOCAS handle, Read status, Program/sequence number,
   List programs. Write down the program list.
3. **Save a program** from the CNC and compare it with `samples/programs/O0001`:
   ```powershell
   .venv\Scripts\python bridge	oolsocas_probe.py --ip ... --lib ... --upload O0001 --out O0001_from_cnc.nc
   ```
4. **Write test** (only with the programmer's OK, machine idle, no alarm, program-protect key off).
   Pick a number that is **not** used on the CNC (e.g. O9001). The tool refuses existing numbers,
   asks you to type `WRITE O9001`, then sends, reads back, compares and deletes it 20 times:
   ```powershell
   .venv\Scripts\python bridge	oolsocas_probe.py --ip ... --lib ... --roundtrip samples\demo\O9000 --number O9001
   ```
5. Work through the `VERIFY ON MACHINE` list in `docs/focas-notes.md` and record the answers.

Practice without a machine: `--simulate` (simulated 0i-TF preloaded with the 5 trusted programs).
If step 1 fails: power, cable, IP/subnet, port, PC firewall. If step 2 fails with "FOCAS library not
found": wrong `--lib` path, or a 32-bit DLL with 64-bit Python.

## Programs, approval and validator (Milestone 9)

**Programs** page lists the latest version of every program. On first start the server imports
the 5 trusted O-files from `samples/programs/` as **approved + proven** programs for LMW Lathe 1
(source "trusted, supplied by company"), byte-for-byte, with their SHA-256.

Open a program to see: the exact hash, version history, validator results (click a line number to
jump to it in the text) and whether it can be sent. A programmer can:
- **Upload program** (saved as draft; part number taken from the header comment if not given),
- **Approve** (only the latest version, only with no validation errors),
- **Reject** (with a reason) or **Retire**,
- **Edit (new version)**: the text is never changed in place. A new draft version is created and the
  previously approved version is retired, so approval is always tied to one exact text hash.

The **validator** is fixed rules, no AI. Errors (block approval and sending): `%` start/end, O-number
header, brackets, unreadable characters, unknown 0i-TF G codes, program must end with M30/M99,
spindle speed above the machine limit (only when limits are entered), tools not in the machine's tool
list (only when the list is filled in), missing `M99 P` targets. Warnings: M00 stops, multiple
operations, `M99 Pn` skip lines, machine-specific M codes, empty tool list, the same T code used for
different tools, code after M30, coordinates without a decimal point, G96 without a G50 clamp.
The 5 trusted programs have **no errors**; their expected warnings are pinned in
`server/tests/test_validator.py`.

## Run all tests and linters (one command)

```powershell
.\scripts\test.ps1        # Windows
```
```bash
./scripts/test.sh         # Linux / macOS / Git Bash
```

This runs ruff, black, mypy and pytest for `server/` and `bridge/`, then eslint, tsc and vitest for `web/`.

## Bridge and live machine status (Milestone 8)

The bridge runs on the factory PC, connects **out** to the server over one WebSocket
(`/api/bridge/ws`), and never opens a listening port. Every 1 s it reads each machine and pushes the
status; every 2 s it sends a heartbeat. It acts only on **signed** commands (`send_program`, `start`,
`feed_hold`, `stop`, `read_status`) and rejects anything else, anything older than 10 s, replays,
unknown machines and program-hash mismatches. If the link drops it takes no machine action and
reconnects with backoff.

**See it:** with `docker compose up`, the `bridge` container drives two **simulated** machines:
LMW Lathe 1 (remote control off) and a fictional "SIM Lathe (dev - simulated)" (remote control on).
Open **Machines -> LMW Lathe 1**: the *Live status* panel shows mode, run state, alarms, program,
block, spindle, override and part count with an **Online** badge and a **SIMULATED** tag. Then:

```bash
docker compose stop bridge     # badge turns Offline within a second ("bridge not connected")
docker compose start bridge    # back to Online after it reconnects
```

A status older than 5 s shows **Stale** with a warning.

**Admin -> Bridges** lists bridges and creates new ones (token + signing key shown once).
Assign a machine to a bridge with the machine's *Bridge id* field.

**Factory PC install:** copy `bridge/config.example.yaml` to `config.yaml`, fill in server URL,
token, signing key, machines and `focas_library_path`, then
`manufai-bridge --config config.yaml --check`. Run it as a service:
Windows -> `bridge/deploy/install-windows-service.md` (NSSM); Linux ->
`bridge/deploy/manufai-bridge.service` (systemd). The PC clock must be NTP-synced.

## Status

See [docs/open-items.md](docs/open-items.md) for everything waiting on real-world data.
