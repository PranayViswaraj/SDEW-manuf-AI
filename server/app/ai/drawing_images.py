"""Drawing pages as high-resolution images for the AI readers.

A scanned A3 sheet sent as one image is read at ~150 dpi: 0.2 superscripts, stacked tolerances and
chamfer sizes become a handful of pixels and get misread or missed. So every page goes as the whole
sheet (layout, views, title block) plus overlapping zoomed tiles at the model's full resolution
(2576 px long edge), where the smallest text is 3-4x larger.

Also lists the numbers in a PDF's text layer (CAD drawings have one; scans do not). The text layer
is unreliable for values (Ø read as 0, stacked tolerances lost) but good at saying THAT a number is
on the sheet: the readers must account for each one, so none is silently missed.

Needs pypdfium2 and Pillow (pip install "manufai-server[ai]"); without them the drawing is sent as
the PDF/image only.
"""

import base64
import io
import logging
import re
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

MAX_EDGE = 2576  # the model's largest image (long edge, px): the zoomed tiles
OVERVIEW_EDGE = 1568  # the whole sheet is for layout only: a third of the tokens
MAX_PAGES = 3
OVERLAP = 0.08  # tiles overlap so no callout is cut in half
MAX_IMAGE_BYTES = 1_200_000  # bigger PNGs are noisy scans: JPEG keeps them small
_NUM = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)?")


@dataclass
class DrawingImages:
    """Content blocks for the readers, and what was sent (for the audit log)."""

    blocks: list[dict[str, Any]] = field(default_factory=list)
    described: list[str] = field(default_factory=list)
    text_numbers: list[str] = field(default_factory=list)


def _block(img: Any) -> dict[str, Any]:
    """A PIL image as a base64 image block: grey PNG (line art), JPEG if that is too big."""
    grey = img.convert("L")
    buf = io.BytesIO()
    grey.save(buf, "PNG", optimize=True)
    data, media = buf.getvalue(), "image/png"
    if len(data) > MAX_IMAGE_BYTES:
        buf = io.BytesIO()
        grey.save(buf, "JPEG", quality=85)
        data, media = buf.getvalue(), "image/jpeg"
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media,
            "data": base64.standard_b64encode(data).decode("ascii"),
        },
    }


def _fit(img: Any, edge: int = MAX_EDGE) -> Any:
    w, h = img.size
    s = edge / max(w, h)
    if s >= 1:
        return img
    from PIL import Image

    return img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.Resampling.LANCZOS)


def grid_for(w: float, h: float) -> tuple[int, int]:
    """Columns and rows of tiles: 2x2 for A4-A3, 3x2 (or 2x3) for A2 and larger sheets."""
    long_edge = max(w, h)
    big = long_edge > 1700  # points: A3 is 1191, A2 is 1684
    if w >= h:
        return (3, 2) if big else (2, 2)
    return (2, 3) if big else (2, 2)


def tile_boxes(w: int, h: int, cols: int, rows: int) -> list[tuple[int, int, int, int]]:
    """Overlapping crop boxes (left, top, right, bottom) covering the whole image."""
    tw, th = w / cols, h / rows
    ox, oy = tw * OVERLAP, th * OVERLAP
    boxes = []
    for r in range(rows):
        for c in range(cols):
            boxes.append(
                (
                    max(0, round(c * tw - ox)),
                    max(0, round(r * th - oy)),
                    min(w, round((c + 1) * tw + ox)),
                    min(h, round((r + 1) * th + oy)),
                )
            )
    return boxes


_POS = {
    (2, 2): ["top-left", "top-right", "bottom-left", "bottom-right"],
    (3, 2): ["top-left", "top-middle", "top-right", "bottom-left", "bottom-middle", "bottom-right"],
    (2, 3): ["top-left", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-right"],
}


def _page_blocks(out: DrawingImages, img: Any, label: str, cols: int, rows: int) -> None:
    out.blocks.append({"type": "text", "text": f"{label}: whole sheet."})
    out.blocks.append(_block(_fit(img, OVERVIEW_EDGE)))
    out.described.append(f"{label} whole sheet {img.size[0]}x{img.size[1]}")
    names = _POS.get((cols, rows)) or [f"tile {i + 1}" for i in range(cols * rows)]
    for name, box in zip(names, tile_boxes(img.size[0], img.size[1], cols, rows), strict=True):
        tile = img.crop(box)
        out.blocks.append(
            {
                "type": "text",
                "text": f"{label}: zoomed tile, {name} of the sheet (overlaps its neighbours).",
            }
        )
        out.blocks.append(_block(_fit(tile)))
        out.described.append(f"{label} tile {name} {tile.size[0]}x{tile.size[1]}")


def text_layer_numbers(page: Any) -> list[str]:
    try:
        text = page.get_textpage().get_text_range()
    except Exception:  # noqa: BLE001 - a broken text layer is simply not used
        return []
    return [m.group(0).replace(",", ".") for m in _NUM.finditer(text or "")]


def render(content: bytes) -> DrawingImages:
    """Whole-sheet views and zoomed tiles of a PDF (first pages) or an image. Empty if the
    imaging libraries are missing or the file cannot be rendered."""
    out = DrawingImages()
    try:
        from PIL import Image
    except ImportError:
        return out
    try:
        if content.startswith(b"%PDF-"):
            import pypdfium2 as pdfium

            pdf = pdfium.PdfDocument(content)
            numbers: list[str] = []
            for i in range(min(len(pdf), MAX_PAGES)):
                page = pdf[i]
                w, h = page.get_size()  # points
                cols, rows = grid_for(w, h)
                # render so each tile comes out at about the model's full resolution
                scale = min(MAX_EDGE * max(cols, rows) / max(w, h), 12.0)
                img = page.render(scale=scale, grayscale=True).to_pil()
                _page_blocks(out, img, f"Page {i + 1} of {len(pdf)}", cols, rows)
                numbers += text_layer_numbers(page)
            out.text_numbers = sorted(set(numbers), key=lambda s: (float(s), s))[:400]
        else:
            img = Image.open(io.BytesIO(content))
            img.load()
            cols, rows = grid_for(*img.size)
            _page_blocks(out, img, "Drawing", cols, rows)
    except ImportError:
        return DrawingImages()
    except Exception as e:  # noqa: BLE001 - fall back to the PDF/image block alone
        log.warning("Could not render the drawing for the AI reader: %s", e)
        return DrawingImages()
    return out
