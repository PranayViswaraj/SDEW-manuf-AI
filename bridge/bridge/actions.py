"""Allow-list of actions the bridge will ever perform (safety rule 6).

The full dispatcher (expiry, machine and hash checks, acks) is built in Milestone 8.
"""

from typing import Final

ALLOWED_ACTIONS: Final[frozenset[str]] = frozenset(
    {"send_program", "start", "feed_hold", "stop", "read_status"}
)

# Actions that physically move or stop the machine. Gated by remote_control_enabled (rule 9).
REMOTE_CONTROL_ACTIONS: Final[frozenset[str]] = frozenset({"start", "feed_hold", "stop"})


def is_allowed(action: str) -> bool:
    return action in ALLOWED_ACTIONS
