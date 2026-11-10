# Safety rules (non-negotiable)

Each rule is enforced in code and has at least one automated test. The "Enforced in" column
is filled in as each milestone lands.

Role checks on every endpoint: `server/tests/test_route_roles.py` (every route must be declared).

| # | Rule | Enforced in | Tests |
|---|------|-------------|-------|
| 1 | Software never replaces the physical emergency stop. No button is ever presented as an emergency stop. | Web UI (M11) | – |
| 2 | The AI never writes or edits CNC programs. Program generation is deterministic code only. | `server/app/gcode/`, `ProgramGenerator` (M9, M12) | – |
| 3 | No program is sent unless the feature table is engineer-confirmed AND the program is programmer-approved for that exact part + machine + program version (content hash). | `services/approval`, `services/run_control` (M9, M11) | – |
| 4 | Start unlocks only when: every checklist item ticked this session, no alarm, machine idle, approved program loaded, user on the allowed-to-start list. | `services/run_control`, bridge `actions` (M8, M11) | – |
| 5 | The bridge connects **outward only**. It never opens a listening port. | `bridge/config.py` (ws/wss URL only), `bridge/ws_client.py` (M8) | `bridge/tests/test_config.py::test_server_url_must_be_outbound_websocket` |
| 6 | The bridge accepts only `send_program`, `start`, `feed_hold`, `stop`, `read_status`. Anything else is rejected and logged. | `bridge/bridge/actions.py` | `bridge/tests/test_config.py::test_action_allow_list_is_exact` |
| 7 | Every action is logged (user, machine, program, hash, action, result, timestamp). The log is append-only. | `services/audit_log` (M2) | – |
| 8 | If the bridge loses the server it takes no machine action on its own. UI shows stale/offline after 5 s without updates. | bridge (M8), web (M11); `MANUFAI_STATUS_STALE_SECONDS=5` | `server/tests/test_health.py::test_safety_timing_defaults` |
| 9 | `start`, `feed_hold`, `stop` are disabled by default (`remote_control_enabled: false`). When disabled, the UI shows "Press Cycle Start at the machine". | `bridge/config.py`, machines table (M3), web (M11) | `bridge/tests/test_config.py::test_remote_control_disabled_by_default` |
