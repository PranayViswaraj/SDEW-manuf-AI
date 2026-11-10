# Open items – waiting on real-world data

Every `TODO(REAL-DATA):` in the code is listed here. Search the repo for `TODO(REAL-DATA)` to find them.

| # | Item | Needed for | Where in code | Added |
|---|------|-----------|---------------|-------|
| 1 | FANUC FOCAS library file (`Fwlib32/64.dll` or `libfwlib32.so`) and its install path on the factory PC | Real machine connection (M6, M7) | `bridge/bridge/config.py` `focas_library_path`, `bridge/config.example.yaml` | M1 |
| 2 | Machine IP address on the factory LAN | Bridge config | `bridge/config.example.yaml` | M1 |
| 3 | PMC addresses for Cycle Start / Feed hold (needs ladder change; may never be possible) | Remote start (M5, M8) | `bridge/bridge/config.py` `pmc_start_address`, `pmc_feed_hold_address` | M1 |
| 4 | Production server URL for the bridge | Bridge config | `bridge/config.example.yaml` `server_url` | M1 |
| 5 | Part drawings | AI drawing reader, feature tables | – | – |
| 6 | Machine nameplate limits (max turning diameter/length, max bar diameter, spindle rpm min/max, chuck size, turret stations) | Capability check (M13), spindle-speed validation (M9) | `server/app/db/models.py` `LIMIT_KEYS`, `server/app/seed.py` `seed_machines`, editable on Machine page | M3 |
| 7 | Turret tool layout, offsets, cutting speeds and feeds | Tool list (validator tool check, capability check), program generator | Tools table, editable on Machine page (empty for LMW Lathe 1) | M3 |
| 8 | LMW Lathe 1 model number | Machine register | `server/app/seed.py` `seed_machines` | M3 |
| 9 | LMW Lathe 1 IP address in the server machine register (in addition to the bridge config) | Machine register, probe tool | `server/app/seed.py` `seed_machines` | M3 |
| 10 | The company's real raw material register file (column names, units, whether quantity is bars or kg) | Material import mapping defaults | `server/app/services/material_import.py` `ALIASES`; mapping is chosen in the UI per import | M4 |
| 11 | FOCAS details to verify on the real 0i-TF (struct layouts, path format, part-count parameter 6711, feed override G0012, PMC type codes, Linux start-up, folder listing) | Real machine connection | `# VERIFY ON MACHINE` in `bridge/bridge/focas_ctypes.py` and `bridge/bridge/drivers/focas.py`; list in `docs/focas-notes.md` | M6 |
| 12 | Whether programs on the CNC are kept in sub-folders (e.g. `/SLEEVE/`) or in `PATH1` | Program list / send folder | `bridge/bridge/drivers/focas.py` `list_programs` | M6 |
| 13 | Factory PC for the bridge (Windows or Linux), outbound network path to the server (WSS allowed), NTP time sync | Running the bridge as a service | `bridge/deploy/` | M8 |
| 14 | Bridge token + signing key for the factory bridge (create on the Bridges page once the server is deployed) | Bridge config | `bridge/config.example.yaml` | M8 |
| 15 | LMW machine-specific M codes (e.g. what M11 does) | Validator: turn the `W_MACHINE_M_CODE` warning into a known list | `server/app/gcode/validator.py` `STANDARD_M` | M9 |
| 16 | Parameter 3401 (decimal point programming) on the 0i-TF | Validator `W_NO_DECIMAL`, backplot units | `server/app/gcode/validator.py` | M9 |
| 17 | Confirm the turret setup per operation: the trusted programs use the same T code for different tools in 1st/2nd operation (e.g. O0001 T0404 = parting and TNMG finish) | Tool list (one list per machine today) | validator `W_TOOL_CONFLICT` | M9 |
| 18 | G83 R-point meaning on this 0i-TF (incremental vs absolute, parameter dependent) | Backplot accuracy for G83 (drawn from the start point) | `server/app/gcode/backplot.py` `_g83` | M10 |
| 19 | First block of G71 in O0004 uses `U1.0 W.5` (W instead of R): confirm meaning with the programmer | Backplot G71 retract | `server/app/gcode/backplot.py` `_rough_cycle` | M10 |
