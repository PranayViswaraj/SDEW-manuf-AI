"""FANUC lathe G-code tokenizer (deterministic, no AI). Shared by the validator and the backplot."""

import re
from dataclasses import dataclass, field

_WORD = re.compile(r"(,?[A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))")
_O_HEADER = re.compile(r"^O(\d{1,4})")


@dataclass(frozen=True)
class Word:
    letter: str  # "G", "X", ... or ",C" / ",R" for corner chamfer / radius
    text: str  # number exactly as written, e.g. "-31.0", ".5", "0101"
    value: float

    @property
    def has_decimal(self) -> bool:
        return "." in self.text


@dataclass
class Block:
    index: int  # 0-based block index
    line_no: int  # 1-based line number in the normalised program text
    raw: str
    code: str  # upper-case text with comments removed
    comments: list[str]
    words: list[Word]
    block_delete: bool = False
    junk: str = ""  # characters that are not valid G-code words

    def get(self, letter: str) -> Word | None:
        return next((w for w in self.words if w.letter == letter), None)

    def all(self, letter: str) -> list[Word]:
        return [w for w in self.words if w.letter == letter]

    def num(self, letter: str) -> float | None:
        w = self.get(letter)
        return w.value if w else None

    def g_codes(self) -> list[float]:
        return [w.value for w in self.all("G")]

    def m_codes(self) -> list[int]:
        return [int(w.value) for w in self.all("M")]

    @property
    def is_empty(self) -> bool:
        return not self.words and not self.junk

    @property
    def seq(self) -> int | None:
        n = self.num("N")
        return int(n) if n is not None else None


@dataclass
class ParsedProgram:
    lines: list[str]  # normalised lines (no \r), as shown to the user
    blocks: list[Block]  # every non-blank, non-'%' line (header included)
    percent_start: bool
    percent_end: bool
    o_number: int | None
    header_comment: str
    paren_errors: list[int] = field(default_factory=list)  # line numbers

    @property
    def body(self) -> list[Block]:
        """Blocks after the O-number header."""
        return self.blocks[1:] if self.o_number is not None else self.blocks


def normalise_lines(text: str) -> list[str]:
    return [ln.rstrip() for ln in text.replace("\r", "").split("\n")]


def _strip_comments(line: str) -> tuple[str, list[str], bool]:
    """Remove (comments). Returns (code, comments, balanced)."""
    out: list[str] = []
    comments: list[str] = []
    cur: list[str] = []
    depth = 0
    balanced = True
    for ch in line:
        if ch == "(":
            if depth > 0:
                balanced = False  # FANUC does not allow nested comments
            depth += 1
            cur = []
        elif ch == ")":
            if depth == 0:
                balanced = False
                continue
            depth -= 1
            if depth == 0:
                comments.append("".join(cur).strip())
        elif depth > 0:
            cur.append(ch)
        else:
            out.append(ch)
    if depth != 0:
        balanced = False
    return "".join(out), comments, balanced


def parse_block(index: int, line_no: int, raw: str) -> tuple[Block, bool]:
    code, comments, balanced = _strip_comments(raw)
    code = code.upper()
    block_delete = code.lstrip().startswith("/")
    if block_delete:
        code = code.lstrip()[1:]
    words: list[Word] = []
    pos, junk = 0, []
    compact = code
    for m in _WORD.finditer(compact):
        gap = compact[pos : m.start()]
        if gap.strip():
            junk.append(gap.strip())
        words.append(Word(m.group(1), m.group(2), float(m.group(2))))
        pos = m.end()
    tail = compact[pos:]
    if tail.strip():
        junk.append(tail.strip())
    blk = Block(
        index=index,
        line_no=line_no,
        raw=raw,
        code=code.strip(),
        comments=comments,
        words=words,
        block_delete=block_delete,
        junk=" ".join(junk),
    )
    return blk, balanced


def parse_program(text: str) -> ParsedProgram:
    lines = normalise_lines(text)
    content = [(i + 1, ln) for i, ln in enumerate(lines) if ln.strip()]
    percent_start = bool(content) and content[0][1].strip() == "%"
    percent_end = len(content) > 1 and content[-1][1].strip() == "%"
    blocks: list[Block] = []
    paren_errors: list[int] = []
    o_number: int | None = None
    header_comment = ""
    for line_no, ln in content:
        if ln.strip() == "%":
            continue
        if not blocks:
            m = _O_HEADER.match(ln.strip().upper())
            if m:
                o_number = int(m.group(1))
                _, comments, ok = _strip_comments(ln)
                header_comment = comments[0] if comments else ""
                if not ok:
                    paren_errors.append(line_no)
                blocks.append(Block(len(blocks), line_no, ln, ln.strip().upper(), comments, []))
                continue
        blk, ok = parse_block(len(blocks), line_no, ln)
        if not ok:
            paren_errors.append(line_no)
        blocks.append(blk)
    return ParsedProgram(
        lines=lines,
        blocks=blocks,
        percent_start=percent_start,
        percent_end=percent_end,
        o_number=o_number,
        header_comment=header_comment,
        paren_errors=paren_errors,
    )


def part_number_and_title(header_comment: str) -> tuple[str, str]:
    """'3773480M01 SLEEVE 4WD' -> ('3773480M01', 'SLEEVE 4WD')."""
    parts = header_comment.strip().split(None, 1)
    if not parts:
        return "", ""
    return parts[0], (parts[1].strip() if len(parts) > 1 else "")
