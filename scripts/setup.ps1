# One-time local setup on Windows. Usage (from repo root):  .\scripts\setup.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Test-Path '.venv')) { python -m venv .venv }
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e '.\server[dev,ai]' -e '.\bridge[dev]'
Push-Location web; npm install; Pop-Location
if (-not (Test-Path '.env')) { Copy-Item .env.example .env }
Write-Host 'Setup complete. Run .\scripts\test.ps1 to run all tests.' -ForegroundColor Green
