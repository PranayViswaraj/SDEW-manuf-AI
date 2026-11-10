# Open items – waiting on real-world data

Every `TODO(REAL-DATA):` in the code is listed here. Search the repo for `TODO(REAL-DATA)` to find them.

| # | Item | Needed for | Where in code | Added |
|---|------|-----------|---------------|-------|
| 1 | FANUC FOCAS library file (`Fwlib32/64.dll` or `libfwlib32.so`) and its install path on the factory PC | Real machine connection (M6, M7) | `bridge/bridge/config.py` `focas_library_path`, `bridge/config.example.yaml` | M1 |
| 2 | Machine IP address on the factory LAN | Bridge config | `bridge/config.example.yaml` | M1 |
| 3 | PMC addresses for Cycle Start / Feed hold (needs ladder change; may never be possible) | Remote start (M5, M8) | `bridge/bridge/config.py` `pmc_start_address`, `pmc_feed_hold_address` | M1 |
| 4 | Production server URL for the bridge | Bridge config | `bridge/config.example.yaml` `server_url` | M1 |
| 5 | Part drawings | AI drawing reader, feature tables | – | – |
| 6 | Machine nameplate limits (max diameter/length, spindle range, chuck size, turret stations) | Capability check (M3, M13) | – | – |
| 7 | Turret tool layout, offsets, cutting speeds and feeds | Tool list, program generator | – | – |
