# ManufAI bridge as a Windows service (NSSM)

1. Install Python 3.11 **64-bit** (use `Fwlib64.dll`) and create the venv in `C:\manufai`:
   `python -m venv C:\manufai\.venv` then `C:\manufai\.venv\Scripts\pip install C:\manufai\bridge`
2. Put the FANUC library files in `C:\manufai\fwlib\` and set `focas_library_path` in
   `C:\manufai\bridge\config.yaml` (copy from `config.example.yaml`; fill token + signing key
   from the ManufAI **Bridges** page).
3. Check the config:
   `C:\manufai\.venv\Scripts\manufai-bridge.exe --config C:\manufai\bridge\config.yaml --check`
4. Install [NSSM](https://nssm.cc/) and run in an **admin** PowerShell:
   ```powershell
   nssm install ManufAIBridge C:\manufai\.venv\Scripts\manufai-bridge.exe --config C:\manufai\bridge\config.yaml
   nssm set ManufAIBridge AppDirectory C:\manufai\bridge
   nssm set ManufAIBridge Start SERVICE_AUTO_START
   nssm set ManufAIBridge AppExit Default Restart
   nssm set ManufAIBridge AppRestartDelay 5000
   nssm start ManufAIBridge
   ```
5. Logs: `C:\manufai\bridge\logs\bridge.log` (rotates at 5 MB, 10 files kept).
6. The Windows clock must be synced (Settings → Time → Sync now): commands older than 10 s are
   rejected.

The bridge only makes an outbound connection to the server. Do not open any inbound firewall port.
Alternative to NSSM: `pywin32` service wrapper — not needed for the first release.
