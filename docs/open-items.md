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
