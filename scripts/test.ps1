# Run every test suite and linter. Usage (from repo root):  .\scripts\test.ps1
# Exits non-zero if anything fails.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { throw 'No .venv found. Run .\scripts\setup.ps1 first.' }

$failed = @()
function Step($name, [scriptblock]$cmd) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    & $cmd
    if ($LASTEXITCODE -ne 0) { $script:failed += $name }
}

Push-Location (Join-Path $root 'server')
Step 'server: ruff'   { & $py -m ruff check . }
Step 'server: black'  { & $py -m black --check -q . }
Step 'server: mypy'   { & $py -m mypy app }
Step 'server: pytest' { & $py -m pytest -q }
Pop-Location

Push-Location (Join-Path $root 'bridge')
Step 'bridge: ruff'   { & $py -m ruff check . }
Step 'bridge: black'  { & $py -m black --check -q . }
Step 'bridge: mypy'   { & $py -m mypy bridge }
Step 'bridge: pytest' { & $py -m pytest -q }
Pop-Location

Push-Location (Join-Path $root 'web')
Step 'web: eslint'    { npm run -s lint }
Step 'web: tsc'       { npm run -s typecheck }
Step 'web: vitest'    { npm test --silent }
Step 'web: build'     { npm run -s build }
Pop-Location

if ($failed.Count -gt 0) {
    Write-Host "`nFAILED: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "`nAll checks passed." -ForegroundColor Green
