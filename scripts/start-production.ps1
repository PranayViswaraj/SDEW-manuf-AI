<#
.SYNOPSIS
  Start ManufAI for real use on ONE Windows PC: one program, one port, every laptop on the
  network opens it in a browser.

.DESCRIPTION
  First run: builds the web app, makes a secret key, creates the database, adds the six
  machines and asks for the first admin account. Every run: applies updates to the database,
  makes the daily backup and starts the server.

  Data lives in %LOCALAPPDATA%\ManufAI (database, backups, secret key) - never in OneDrive,
  because syncing a live database can corrupt it.

.EXAMPLE
  .\scripts\start-production.ps1            # start on port 8080
  .\scripts\start-production.ps1 -Rebuild   # after updating the code: rebuild the web app
#>
param(
    [int]$Port = 8080,
    [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root '.venv\Scripts\python.exe'
$data = Join-Path $env:LOCALAPPDATA 'ManufAI'
$backups = Join-Path $data 'backups'

function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }

if (-not (Test-Path $py)) {
    throw "Python environment missing. Run .\scripts\setup.ps1 once first."
}
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $who = (Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
    throw "Port $Port is already used by '$who'. If that is ManufAI it is already running; otherwise start with another port, e.g. -Port 8081."
}
New-Item -ItemType Directory -Force -Path $data, $backups | Out-Null

# --- secret key (made once, kept on this PC only)
$secretFile = Join-Path $data 'jwt-secret.txt'
if (-not (Test-Path $secretFile)) {
    Step 'Creating the secret key for logins'
    & $py -c "import secrets; print(secrets.token_urlsafe(48))" | Set-Content -Encoding ascii -NoNewline $secretFile
    # only this Windows user may read it
    icacls $secretFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}

# --- web app
$dist = Join-Path $root 'web\dist'
if ($Rebuild -or -not (Test-Path (Join-Path $dist 'index.html'))) {
    Step 'Building the web app (about a minute)'
    Push-Location (Join-Path $root 'web')
    try { npm run build; if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' } } finally { Pop-Location }
}

# --- settings for this run (production rules, one-PC database)
$dbPath = (Join-Path $data 'manufai.db') -replace '\\', '/'
$env:MANUFAI_ENV = 'production'
$env:MANUFAI_STANDALONE = 'true'
$env:MANUFAI_DATABASE_URL = "sqlite:///$dbPath"
$env:MANUFAI_JWT_SECRET = (Get-Content -Raw $secretFile).Trim()
$env:MANUFAI_WEB_DIR = $dist
$env:MANUFAI_SAMPLES_DIR = Join-Path $root 'samples\programs'
$env:MANUFAI_CORS_ORIGINS = "http://localhost:$Port"
$env:MANUFAI_SEED_DEV_DATA = 'false'
$env:MANUFAI_DOCS_ENABLED = 'false'
$env:MANUFAI_HSTS = 'false'

Push-Location (Join-Path $root 'server')
try {
    Step 'Updating the database'
    & $py -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw 'Database update failed.' }
    & $py -m app.seed

    # --- first admin
    $users = & $py -m app.cli list-users
    if (-not ($users | Select-String -SimpleMatch 'admin')) {
        Step 'No admin yet: create the first admin account'
        $name = Read-Host 'Admin user name (e.g. your first name)'
        & $py -m app.cli create-user $name --role admin --role engineer --role programmer --role operator --can-start
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the admin.' }
        Write-Host 'Add everyone else from the Users page after logging in.' -ForegroundColor Green
    }

    # --- daily backup (first start of the day)
    $today = Get-Date -Format 'yyyyMMdd'
    if (-not (Get-ChildItem $backups -Filter "manufai-$today-*.db" -ErrorAction SilentlyContinue)) {
        Step 'Daily backup'
        & $py -m app.cli backup --to $backups
    }

    Step 'Pre-launch check'
    & $py -m app.cli check
    if ($LASTEXITCODE -ne 0) { throw 'Pre-launch check found problems (see above).' }

    # --- let other laptops reach it (needs an administrator window once)
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not (Get-NetFirewallRule -DisplayName "ManufAI $Port" -ErrorAction SilentlyContinue)) {
        if ($isAdmin) {
            New-NetFirewallRule -DisplayName "ManufAI $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private, Domain | Out-Null
            Write-Host "Firewall: port $Port opened for the office network." -ForegroundColor Green
        } else {
            Write-Host "Other laptops: run this script once 'as administrator' to open port $Port in the firewall." -ForegroundColor Yellow
        }
    }

    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress
    Write-Host "`nManufAI is starting. Open it in a browser:" -ForegroundColor Green
    Write-Host "  On this PC:      http://localhost:$Port"
    foreach ($ip in $ips) { Write-Host "  Other laptops:   http://${ip}:$Port" }
    Write-Host "Keep this window open. Close it (or Ctrl+C) to stop ManufAI.`n"

    & $py -m uvicorn app.main:app --host 0.0.0.0 --port $Port --workers 1 --no-server-header --log-level warning
} finally {
    Pop-Location
}
