# Production deployment and operations

Everything you need to run ManufAI for real: install, first admin, bridge, backups, upgrades,
monitoring and a security checklist. For local development use `docker-compose.yml` instead.

## 1. What runs where

| Part | Where | File |
|------|-------|------|
| PostgreSQL | server host (Docker), not exposed outside Docker | `docker-compose.prod.yml` → `db` |
| ManufAI server (API + bridge WebSocket) | server host (Docker), **one process** | `server/Dockerfile` |
| Web app + HTTPS (Caddy) | server host (Docker), ports 80/443 | `web/Dockerfile.prod`, `web/Caddyfile` |
| Bridge | always-on factory PC, outbound only | `bridge/deploy/` |

The server runs a single worker on purpose: live machine status and bridge connections live in
memory. Scale up (more CPU/RAM), not out.

## 2. Install (first time)

Requirements: a Linux host with Docker + Compose, a DNS name pointing to it (for HTTPS), ports 80
and 443 open to the users' network.

```bash
git clone <repo> manufai && cd manufai
cp .env.prod.example .env.prod
python3 -c "import secrets; print(secrets.token_urlsafe(48))"   # use for MANUFAI_JWT_SECRET
python3 -c "import secrets; print(secrets.token_urlsafe(24))"   # use for POSTGRES_PASSWORD
nano .env.prod                                                  # fill in every value
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

The server refuses to start with unsafe settings (dev JWT secret, dev users on, `*` CORS, SQLite)
and says which setting to fix: `docker compose -f docker-compose.prod.yml logs server`.

## 3. First admin and users

No users exist in production. Create the first admin from the server host:

```bash
alias mcli='docker compose -f docker-compose.prod.yml --env-file .env.prod exec server python -m app.cli'
mcli create-user chief --role admin --full-name "Production Head"   # asks for the password twice
mcli check                                                         # must end with RESULT: OK
```

Then log in at `https://<your domain>` and add everyone else on the **Users** page, or with
`mcli create-user NAME --role operator --can-start`. Only people on the production head's list get
**Allowed to press Start** (`--can-start`).

Other commands: `mcli set-password NAME`, `mcli deactivate NAME`, `mcli list-users`.
Passwords: at least 10 characters with the CLI.

## 4. Connect the factory bridge

```bash
mcli create-bridge factory-pc-1      # prints bridge_token and signing_key ONCE
```

Put both into `bridge/config.yaml` on the factory PC with
`server_url: wss://<your domain>/api/bridge/ws`, then assign machines to the bridge (machine page →
*Bridge id* = `factory-pc-1`). Install the bridge as a service: `bridge/deploy/`.
The **Bridges** page shows it as Connected.

## 5. Health and monitoring

| URL | Meaning | Use for |
|-----|---------|---------|
| `GET /api/health` | process up + database reachable | Docker / load-balancer liveness |
| `GET /api/ready` | database reachable **and** schema at the latest migration; also shows connected bridges | deployment readiness, uptime monitor (alert on non-200) |

- Logs are JSON, one line per event, on stdout:
  `docker compose -f docker-compose.prod.yml logs -f server`.
  Every request has a `request_id` (also returned as the `X-Request-ID` header). When a user sees
  "Give this reference to the admin: …", search the logs for that id.
- Logins, lock-outs and every machine action are also in the **Audit log** page.
- Login lock-out: 5 wrong passwords (`MANUFAI_LOGIN_MAX_FAILURES`) lock that user from that address for
  5 minutes (`MANUFAI_LOGIN_LOCKOUT_S`). A server restart clears lock-outs.

## 6. Backups and restore

```bash
./scripts/backup.sh                          # writes backups/manufai-YYYYMMDD-HHMMSS.sql.gz
```

Run it daily from cron (`0 2 * * * cd /opt/manufai && ./scripts/backup.sh`) and copy `backups/` to
another machine. The audit log, programs, approvals and run records are all in this one database.

Restore into an empty database:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d db
gunzip -c backups/<file>.sql.gz | docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T db psql -U manufai -d manufai
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

Test a restore at least once before go-live.

## 7. Upgrades

```bash
./scripts/backup.sh
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
curl -fsS https://<your domain>/api/ready      # ready: true
```

The server applies database migrations on start. Bridges disconnect for a few seconds and
reconnect by themselves; no machine action is taken while they are disconnected (safety rule 8).

## 8. Security checklist

- [ ] `.env.prod` filled with long random secrets, readable only by the admin (`chmod 600 .env.prod`).
- [ ] `MANUFAI_DOMAIN` set; site only reachable over HTTPS; `MANUFAI_HSTS=true`.
- [ ] `MANUFAI_DOCS_ENABLED=false` unless you need the API docs.
- [ ] Database port not published (default in `docker-compose.prod.yml`).
- [ ] First admin created with the CLI; dev accounts do not exist (`mcli list-users`).
- [ ] Allowed-to-press-Start list matches the production head's names.
- [ ] Bridge PC: outbound only, NTP time sync, config file private.
- [ ] Daily backups copied off the host; restore tested.
- [ ] Containers: server runs as a non-root user with a read-only filesystem
      (`docker compose ... exec server id -un` → `manufai`).

## 9. Settings reference (server)

All `MANUFAI_*` environment variables, with defaults, are in `server/app/config.py`. The ones you
are most likely to change: `MANUFAI_LOG_LEVEL`, `MANUFAI_JWT_EXPIRE_MINUTES` (default 480 = one shift),
`MANUFAI_LOGIN_MAX_FAILURES`, `MANUFAI_LOGIN_LOCKOUT_S`, `MANUFAI_DB_POOL_SIZE`,
`MANUFAI_STATUS_STALE_SECONDS` (safety rule 8, default 5).

## Hosted online for free: GitHub Pages

**https://pranayviswaraj.github.io/SDEW-manuf-AI/** - open it on any laptop or phone, nothing to
install, nothing to pay.

There is no server to host: the real ManufAI server (`server/app`) runs inside each visitor's
browser with Pyodide (Python compiled to WebAssembly), see `web/browser-server/`. Every push to
`main` that touches `web/`, `server/app/` or `samples/` rebuilds and republishes the site
(`.github/workflows/pages.yml` → `gh-pages` branch).

- **Log in:** pick a role on the login page, password `qwerty` (demo accounts).
- **First visit** downloads about 15 MB and takes up to a minute; later visits start faster.
- **Data is saved in that browser only** (IndexedDB). Another laptop starts with its own copy of
  the demo data; clearing the browser's site data resets it.
- **No live machines:** a browser cannot reach the factory bridge. Use **Download .NC for a USB
  stick** to move approved programs to the lathe.

### Optional: one shared server for everyone (Render + Neon, free tiers)

For shared data and live machines, run the server on Render with a Neon database (`render.yaml`):
create a free Neon project and copy its connection string; on render.com *New* → *Blueprint* →
this repository, paste it as `MANUFAI_DATABASE_URL` and choose the initial admin name and
password. Then set the repository variable `API_BASE` to the Render address and re-run the Pages
workflow: the site then uses that server instead of the in-browser one. The free Render server
sleeps after ~15 minutes idle (the next request takes up to a minute).
