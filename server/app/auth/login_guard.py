"""Brute-force protection for the login endpoint.

After `max_failures` wrong passwords for the same username from the same address within the
lock-out window, further attempts are refused until the window has passed. In memory, per server
process (the first release runs one server process; see docs/architecture.md).
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass
class LoginGuard:
    max_failures: int
    lockout_s: float
    clock: Callable[[], float] = time.monotonic
    _failures: dict[tuple[str, str], list[float]] = field(default_factory=dict)

    def _key(self, username: str, address: str) -> tuple[str, str]:
        return (username.strip().lower(), address)

    def _recent(self, key: tuple[str, str]) -> list[float]:
        now = self.clock()
        kept = [t for t in self._failures.get(key, []) if now - t < self.lockout_s]
        if kept:
            self._failures[key] = kept
        else:
            self._failures.pop(key, None)
        return kept

    def seconds_locked(self, username: str, address: str) -> int:
        """0 if login may be attempted, else the seconds left in the lock-out."""
        recent = self._recent(self._key(username, address))
        if len(recent) < self.max_failures:
            return 0
        return max(1, int(self.lockout_s - (self.clock() - recent[0])) + 1)

    def failed(self, username: str, address: str) -> None:
        key = self._key(username, address)
        self._recent(key)
        self._failures.setdefault(key, []).append(self.clock())
        if len(self._failures) > 10_000:  # bound memory under attack
            oldest = sorted(self._failures, key=lambda k: self._failures[k][-1])[:5_000]
            for k in oldest:
                self._failures.pop(k, None)

    def succeeded(self, username: str, address: str) -> None:
        self._failures.pop(self._key(username, address), None)
