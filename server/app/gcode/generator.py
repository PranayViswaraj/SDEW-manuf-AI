"""ProgramGenerator interface (out of scope for now: no implementation).

The generator will turn an engineer-CONFIRMED feature table, the programmer's templates and the
machine's tool list into a FANUC program using fixed, deterministic code (never AI, safety rule 2).
Every generated program is stored as a draft (source "generator"), validated, back-plotted and
must be approved by a programmer before it can be sent.

Needs real data first: drawings, turret tool layout, cutting speeds and feeds, and the programmers'
templates. TODO(REAL-DATA).
"""

from abc import ABC, abstractmethod
from typing import Any


class ProgramGenerator(ABC):
    @abstractmethod
    def generate(
        self, feature_table: dict[str, Any], machine_key: str, templates: dict[str, str]
    ) -> str:
        """Return FANUC program text for the confirmed feature table. Deterministic."""
        raise NotImplementedError
