# Safety rules (non-negotiable)

Each rule is enforced in code and has at least one automated test. Updated every milestone.

Role checks on **every** endpoint: `server/tests/test_route_roles.py` — every API route must be
declared with its allowed roles, or the test suite fails.

| # | Rule | Enforced in | Tests |
|---|------|-------------|-------|
| 1 | Software never replaces the physical emergency stop. No button is ever presented as an emergency stop. | Web UI: E-stop reminder on Home; no button text mentions E-stop/emergency | `web/tests/App.test.tsx` "never shows anything labelled as an emergency stop button" |
| 2 | The AI never writes or edits CNC programs. Program generation is deterministic code only. | `server/app/gcode/`, `ProgramGenerator` (M9, M12) | (M9) |
| 3 | No program is sent unless the feature table is engineer-confirmed AND the program is programmer-approved for that exact part + machine + program version (content hash). | `services/approval`, `services/run_control` (M9, M11) | (M11) |
| 4 | Start unlocks only when: every checklist item ticked this session, no alarm, machine idle, approved program loaded, user on the allowed-to-start list. | `users.can_start_machine` — admin-only, default false (M2); `services/run_control`, bridge `actions` (M8, M11) | `server/tests/test_auth.py::test_admin_manages_users_and_start_list` |
| 5 | The bridge connects **outward only**. It never opens a listening port. | `bridge/bridge/config.py` (ws/wss URL only), `bridge/bridge/ws_client.py` (M8) | `bridge/tests/test_config.py::test_server_url_must_be_outbound_websocket` |
| 6 | The bridge accepts only `send_program`, `start`, `feed_hold`, `stop`, `read_status`. Anything else is rejected and logged. | `bridge/bridge/actions.py` | `bridge/tests/test_config.py::test_action_allow_list_is_exact` |
| 7 | Every action is logged (user, machine, program, hash, action, result, timestamp). The log is append-only. | `server/app/services/audit_log.py` (own session, committed immediately); `server/app/db/guards.py` (ORM guard incl. bulk statements); DB triggers in migration `0002_users_audit` (SQLite + PostgreSQL, incl. TRUNCATE); no update/delete endpoints | `server/tests/test_audit_log.py` (ORM, bulk, raw SQL, endpoints) |
| 8 | If the bridge loses the server it takes no machine action on its own. UI shows stale/offline after 5 s without updates. | bridge (M8), web (M11); `MANUFAI_STATUS_STALE_SECONDS=5` | `server/tests/test_health.py::test_safety_timing_defaults` |
| 9 | `start`, `feed_hold`, `stop` are disabled by default (`remote_control_enabled: false`). When disabled, the UI shows "Press Cycle Start at the machine". | `bridge/bridge/config.py`; `machines.remote_control_enabled` default false, changes audited as `remote_control_changed` (M3); web (M11) | `bridge/tests/test_config.py::test_remote_control_disabled_by_default`, `bridge/tests/test_simulated_driver.py::test_remote_control_disabled_by_default`, `::test_remote_control_needs_pmc_address_too`, `server/tests/test_machines.py::test_seeded_lmw_lathe_has_unknown_limits`, `::test_new_machine_defaults_are_safe`, `::test_remote_control_change_is_audited_separately` |
