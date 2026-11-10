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

## Run all tests and linters (one command)

```powershell
.\scripts\test.ps1        # Windows
```
```bash
./scripts/test.sh         # Linux / macOS / Git Bash
```

This runs ruff, black, mypy and pytest for `server/` and `bridge/`, then eslint, tsc and vitest for `web/`.

## Bridge (factory PC)

```bash
cp bridge/config.example.yaml bridge/config.yaml   # edit server URL, token, machines
.venv/bin/manufai-bridge --config bridge/config.yaml --check
```
The service loop arrives in Milestone 8. The FANUC FOCAS library (`Fwlib*.dll` / `libfwlib32.so`)
is licensed from FANUC; it is **not** in this repo and must never be committed.

## Troubleshooting

**`pip` fails with `CERTIFICATE_VERIFY_FAILED`** (antivirus or a network proxy inspecting HTTPS):
the pip bundled with older Python 3.11 releases doesn't trust the Windows certificate store; pip 24.2+
does. Upgrade the venv's pip using any newer pip you already have, then rerun setup:
```powershell
python -m pip --python "$PWD\.venv\Scripts\python.exe" install --upgrade pip
```
Don't use `--trusted-host`; it turns off certificate checking.

## Status

See [docs/open-items.md](docs/open-items.md) for everything waiting on real-world data.
