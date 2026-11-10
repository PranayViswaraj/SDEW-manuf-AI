"""Drawing reader interface (Milestone 12: stub only).

The real AI reader will turn a part drawing into SUGGESTED feature-table values. It needs real
drawings to build and test, so for now the stub returns an empty table.
TODO(REAL-DATA): part drawings to build and evaluate the AI drawing reader.
"""

from abc import ABC, abstractmethod

from app.services.feature_tables import TableData, empty_data


class DrawingReader(ABC):
    @abstractmethod
    def read(self, file: bytes, filename: str = "") -> TableData:
        """Return suggested values in the "ai" field of each cell. Never sets value/confirmed."""


class StubDrawingReader(DrawingReader):
    """Returns an empty feature table: every value must be entered by an engineer."""

    def read(self, file: bytes, filename: str = "") -> TableData:
        return TableData.model_validate(empty_data())


def get_drawing_reader() -> DrawingReader:
    return StubDrawingReader()
