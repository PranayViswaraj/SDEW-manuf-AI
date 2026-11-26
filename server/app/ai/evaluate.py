"""Measure the AI drawing reader against hand-checked drawings.

    python -m app.ai.evaluate "C:/.../SDEW - Manuf/drawings" --out ai-eval.json

Every PDF in the folder (and its subfolders) that matches a known drawing
(samples/drawings/known_drawings.json, by file fingerprint or part number in the file name) is read
by the two-agent reader; each suggested value is compared with the recorded one:

- precision: suggested values that are right / all values suggested (a wrong number is the worst
  outcome: it must stay near 100 %),
- recall: recorded values the reader got right / all recorded values (nothing missed),
- missed and extra features, and drawings wrongly called (not) a lathe part.

Needs the AI reader set up (MANUFAI_AI_READER=claude, an Anthropic API key). Costs API credits:
about 3-4 model calls per drawing. The drawings are read from disk and sent only to the API.
"""

import argparse
import hashlib
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from app.ai.known_drawings import KnownDrawing, _norm, find_known, load_known

TOL = 0.0015  # values are written to 3 decimals at most


@dataclass
class DrawingScore:
    part_number: str
    file: str
    expected: int = 0  # recorded values
    suggested: int = 0  # values the AI suggested
    correct: int = 0
    wrong: list[str] = field(default_factory=list)
    missed_values: list[str] = field(default_factory=list)
    missed_features: list[str] = field(default_factory=list)
    extra_features: list[str] = field(default_factory=list)
    lathe_call: str = "ok"
    unaccounted: list[str] = field(default_factory=list)
    error: str = ""

    @property
    def precision(self) -> float:
        return self.correct / self.suggested if self.suggested else 1.0

    @property
    def recall(self) -> float:
        return self.correct / self.expected if self.expected else 1.0


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, int | float) and isinstance(b, int | float):
        return abs(float(a) - float(b)) <= TOL
    return str(a).strip().upper().replace(" ", "") == str(b).strip().upper().replace(" ", "")


def _align(known: list[str], got: list[str]) -> list[tuple[int | None, int | None]]:
    """Feature alignment by type (longest common subsequence), keeping table order."""
    n, m = len(known), len(got)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = (
                dp[i + 1][j + 1] + 1 if known[i] == got[j] else max(dp[i + 1][j], dp[i][j + 1])
            )
    pairs: list[tuple[int | None, int | None]] = []
    i = j = 0
    while i < n and j < m:
        if known[i] == got[j]:
            pairs.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            pairs.append((i, None))
            i += 1
        else:
            pairs.append((None, j))
            j += 1
    pairs += [(k, None) for k in range(i, n)] + [(None, k) for k in range(j, m)]
    return pairs


def score(
    known: KnownDrawing, table: dict[str, Any], notes: dict[str, Any], file: str = ""
) -> DrawingScore:
    """Compare a reader's table ("ai" cells) with the recorded values of a known drawing."""
    s = DrawingScore(part_number=known.part_number, file=file)
    s.unaccounted = list(notes.get("unaccounted") or [])
    said_not_lathe = bool(notes.get("not_lathe"))
    if bool(known.not_lathe) != said_not_lathe:
        s.lathe_call = "called a lathe part" if known.not_lathe else "called not a lathe part"

    def one(label: str, want: Any, got: Any) -> None:
        if want is not None:
            s.expected += 1
        if got is not None:
            s.suggested += 1
        if want is None or got is None:
            if want is not None:
                s.missed_values.append(f"{label}: {want}")
            elif got is not None:
                s.wrong.append(f"{label}: suggested {got}, not on the drawing")
            return
        if _same(want, got):
            s.correct += 1
        else:
            s.wrong.append(f"{label}: suggested {got}, drawing {want}")

    for key, want in known.header.items():
        if key == "bar_diameter":
            continue  # not on drawings; the AI must leave it empty (wrong if it invents one)
        one(f"header {key}", want, (table.get("header", {}).get(key) or {}).get("ai"))
    bar = (table.get("header", {}).get("bar_diameter") or {}).get("ai")
    if bar is not None:
        s.suggested += 1
        s.wrong.append(f"header bar_diameter: suggested {bar}, not on the drawing")

    kf = known.features
    gf = table.get("features", []) if not said_not_lathe else []
    for ki, gi in _align([f["type"] for f in kf], [f["type"] for f in gf]):
        if ki is not None and gi is None:
            f = kf[ki]
            s.missed_features.append(f"{ki + 1}. {f['type']} {f['fields']}")
            for k, v in f["fields"].items():
                one(f"feature {ki + 1} {f['type']} {k}", v, None)
        elif gi is not None and ki is None:
            f = gf[gi]
            vals = {
                k: c.get("ai") for k, c in f.get("fields", {}).items() if c.get("ai") is not None
            }
            s.extra_features.append(f"{f['type']} {vals}")
            for k, v in vals.items():
                one(f"extra {f['type']} {k}", None, v)
        elif ki is not None and gi is not None:
            want, got = kf[ki]["fields"], gf[gi].get("fields", {})
            for k in sorted(set(want) | set(got)):
                one(
                    f"feature {ki + 1} {kf[ki]['type']} {k}",
                    want.get(k),
                    (got.get(k) or {}).get("ai"),
                )
    return s


def _match(known: list[KnownDrawing], pdf: Path) -> KnownDrawing | None:
    sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
    hit = find_known(known, sha256=sha)
    if hit:
        return hit
    name = _norm(pdf.stem)
    for k in known:
        if any(n and n in name for n in k.names()):
            return k
    return None


def summary(scores: list[DrawingScore]) -> dict[str, Any]:
    ok = [s for s in scores if not s.error]
    exp = sum(s.expected for s in ok)
    sug = sum(s.suggested for s in ok)
    cor = sum(s.correct for s in ok)
    return {
        "drawings": len(scores),
        "failed": len(scores) - len(ok),
        "precision": round(cor / sug, 4) if sug else None,
        "recall": round(cor / exp, 4) if exp else None,
        "missed_features": sum(len(s.missed_features) for s in ok),
        "extra_features": sum(len(s.extra_features) for s in ok),
        "wrong_lathe_calls": sum(1 for s in ok if s.lathe_call != "ok"),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("folder", help="folder with drawing PDFs (searched recursively)")
    ap.add_argument(
        "--known", default=str(Path(__file__).parents[3] / "samples/drawings/known_drawings.json")
    )
    ap.add_argument("--out", default="ai-eval.json")
    a = ap.parse_args(argv)

    from app.ai.claude_reader import ClaudeDrawingReader
    from app.config import get_settings

    st = get_settings()
    key = st.anthropic_api_key.get_secret_value() if st.anthropic_api_key else None
    reader = ClaudeDrawingReader(model=st.ai_model, effort=st.ai_effort, api_key=key)
    known = load_known(a.known)
    scores: list[DrawingScore] = []
    for pdf in sorted(Path(a.folder).rglob("*.pdf")):
        k = _match(known, pdf)
        if not k:
            print(f"skip (no recorded values): {pdf.name}")
            continue
        print(f"reading {pdf.name} …", flush=True)
        try:
            res = reader.read_report(pdf.read_bytes(), pdf.name, k.part_number)
            sc = score(k, res.table.model_dump(), res.notes, pdf.name)
        except Exception as e:  # noqa: BLE001 - report and continue with the next drawing
            sc = DrawingScore(part_number=k.part_number, file=pdf.name, error=str(e))
        scores.append(sc)
        if sc.error:
            print(f"  FAILED, not scored: {sc.error}")
            if "Authentication" in sc.error:
                print("  The API key was rejected: stopping (fix the key, then run again).")
                break
        else:
            print(
                f"  precision {sc.precision:.1%}  recall {sc.recall:.1%}  wrong {len(sc.wrong)}  "
                f"missed features {len(sc.missed_features)}  to check {len(sc.unaccounted)}"
            )
    report = {
        "summary": summary(scores),
        "drawings": [asdict(s) | {"precision": s.precision, "recall": s.recall} for s in scores],
    }
    Path(a.out).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
