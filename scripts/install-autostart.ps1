<#
.SYNOPSIS
  Make ManufAI start by itself when this PC's user logs in, and back up every evening.

.DESCRIPTION
  Creates two Windows scheduled tasks for the current user:
    ManufAI server - at log-on, runs start-production.ps1 in a minimised window
    ManufAI backup - every day at 20:00, copies the database to %LOCALAPPDATA%\ManufAI\backups
  Run start-production.ps1 by hand once first (it asks for the first admin).
  Remove both with:  .\scripts\install-autostart.ps1 -Remove
#>
param([int]$Port = 8080, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
    'ManufAI server', 'ManufAI backup' | ForEach-Object {
        Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue
    }
    Write-Host 'ManufAI auto-start and nightly backup removed.' -ForegroundColor Green
    return
}

$start = Join-Path $root 'scripts\start-production.ps1'
$server = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$start`" -Port $Port"
Register-ScheduledTask -TaskName 'ManufAI server' -Action $server -Force `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
    -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)) `
    -Description 'Starts ManufAI (one-PC install).' | Out-Null

$py = Join-Path $root '.venv\Scripts\python.exe'
$db = ((Join-Path $env:LOCALAPPDATA 'ManufAI\manufai.db') -replace '\\', '/')
$backups = Join-Path $env:LOCALAPPDATA 'ManufAI\backups'
$cmd = "`$env:MANUFAI_DATABASE_URL='sqlite:///$db'; Set-Location '$root\server'; & '$py' -m app.cli backup --to '$backups'"
$backup = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
Register-ScheduledTask -TaskName 'ManufAI backup' -Action $backup -Force `
    -Trigger (New-ScheduledTaskTrigger -Daily -At '20:00') `
    -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable) `
    -Description 'Nightly copy of the ManufAI database (kept 30 days).' | Out-Null

Write-Host 'Done. ManufAI starts when you log in, and backs up every day at 20:00.' -ForegroundColor Green
Write-Host "Backups: $backups  (copy one to a pen drive or another PC every week)"
