"""Drawing reader interface.

The AI reader turns a part drawing into SUGGESTED feature-table values (the "ai" cell only). Two
readers exist:
- StubDrawingReader (default): an empty table; every value is entered by an engineer.
- ClaudeDrawingReader (app.ai.claude_reader): two AI agents, an extractor and a verifier that
  corrects it. Switched on with MANUFAI_AI_READER=claude plus an Anthropic API key.
"""

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.config import get_settings
from app.services.feature_tables import TableData, empty_data

# progress(stage, n): stage "extract" (agent 1) or "verify" (agent 2, round n)
Progress = Callable[[str, int], None]


class DrawingReaderError(RuntimeError):
    """The reader could not produce suggestions; the message is shown to the engineer."""


@dataclass
class ReaderResult:
    table: TableData
    # Shown to the engineer: questions, items the table cannot hold, evidence, not-a-lathe-part.
    notes: dict[str, Any] = field(default_factory=dict)
    # Kept in the audit log: both agents' full answers and the drawing fingerprint.
    audit: dict[str, Any] = field(default_factory=dict)


class DrawingReader(ABC):
    @abstractmethod
    def read(self, file: bytes, filename: str = "") -> TableData:
        """Return suggested values in the "ai" field of each cell. Never sets value/confirmed."""

    def read_report(
        self,
        file: bytes,
        filename: str = "",
        part_number: str = "",
        progress: Progress | None = None,
    ) -> ReaderResult:
        return ReaderResult(table=self.read(file, filename))


class StubDrawingReader(DrawingReader):
    """Returns an empty feature table: every value must be entered by an engineer."""

    def read(self, file: bytes, filename: str = "") -> TableData:
        return TableData.model_validate(empty_data())


def ai_reader_enabled() -> bool:
    return get_settings().ai_reader == "claude"


def get_drawing_reader() -> DrawingReader:
    s = get_settings()
    if s.ai_reader == "claude":
        from app.ai.claude_reader import ClaudeDrawingReader

        key = s.anthropic_api_key.get_secret_value() if s.anthropic_api_key else None
        return ClaudeDrawingReader(model=s.ai_model, effort=s.ai_effort, api_key=key)
    return StubDrawingReader()
