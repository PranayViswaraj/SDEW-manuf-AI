# AI drawing reader: extraction and verification prompts

Prompts for reading a TAFE part drawing (PDF or image) into the ManufAI feature table with a vision
model (Claude). Built in `server/app/ai/claude_reader.py` (pipeline) and `server/app/ai/prompts.py`
(the prompts below plus strict JSON schemas). Keep this document and `prompts.py` in step.

**Off by default.** Until it is switched on, the app fills only known drawings
(`samples/drawings/known_drawings.json`) and engineers type everything else. To switch it on:

```text
pip install ".[ai]"                 # in server/
MANUFAI_AI_READER=claude
ANTHROPIC_API_KEY=<key>             # server environment only, never in git
MANUFAI_AI_MODEL=claude-opus-5-5    # default
MANUFAI_AI_EFFORT=xhigh             # default: accuracy first
```

Where it runs: drawing upload on the Drawing → Program page (only when the drawing is not a known
drawing and the part's table is still empty), and Parts → "create from drawing". Both agents take
about a minute or two per drawing. If the AI fails or declines, the upload still works and the
engineer enters values by hand.

Two agents run on every drawing:

1. **Extractor** reads the drawing image and produces the feature table, with evidence and a
   confidence for every value.
2. **Verifier** gets the same drawing plus the Extractor's JSON, checks every value against the
   drawing independently, and returns corrections. Disagreements it cannot settle become questions
   for the engineer, never guesses.

The engineer still ticks and confirms every value (safety rule: AI only suggests).

## Precision and completeness (what makes the read trustworthy)

SDEW receives drawings as PDFs only (no STEP model), most of them scans. Three measures:

1. **Zoomed tiles.** Every page goes to both agents as the PDF, a whole-sheet image and 2x2 (3x2
   for A2/A1) overlapping tiles at the model's full resolution (2576 px long edge,
   `server/app/ai/drawing_images.py`). On a scanned A3 sheet this makes a 0.1 stacked tolerance
   about 3-4x larger than in the whole-sheet view. Scans go as grey JPEG, CAD sheets as grey PNG:
   1.4-4.7 MB per drawing on the local SDEW set.
2. **Callout inventory, twice.** Both agents list every callout on the sheet (dimension with
   tolerance, chamfer, radius, thread, GD&T frame, finish, note, title-block value), with its
   **inspection balloon number** when the drawing has one, and where it went in the table.
3. **Program check of the inventories** (`completeness()` in `claude_reader.py`, no AI): callouts
   with no place in the table, balloon numbers missing from 1..N, callouts the first reader saw
   that the checker's list lost, and numbers printed in the PDF text layer (CAD sheets) that no
   reader accounted for. Any gap forces the checker's second round, with the gaps listed; whatever
   is still open after it is shown to the engineer as "check these on the drawing".

Accuracy is measured, not assumed: `python -m app.ai.evaluate <drawings folder>` (section 6).

## Why the drawing must be read as an image

Sampling the reference drawings in the shared Drive folder (about 255 TAFE drawings) showed the
text layer of these PDFs is not usable on its own:

| Drawing shows | Text layer gives |
| --- | --- |
| `Ø40.35` | `040.35` (Ø read as zero) |
| `M8x1-6g` | `M8x1-69` |
| `Ø44.45 0/-0.1` (tolerance stacked) | `44.45` (tolerance lost) |
| `2.79 +0.13` (small superscript) | `2.79` or a stray `0.13` elsewhere |
| `FINISH`, `CHAMFERS` | `EINISH`, `CHAMPURS` |
| geometric tolerance frame `⊥ 0.05 A` | `0.05 A` floating, no symbol, no feature |
| chained section dimensions | loose numbers in reading order, no meaning |

So: **send the rendered page image** (PDF pages at 200 dpi or more, or the original JPG/PNG). The
text layer may be passed as a hint, clearly labelled as unreliable.

---

## 1. Extractor prompt (system)

```text
You are a senior CNC turning engineer reading a 2D engineering drawing for a FANUC lathe shop
(Tractors and Farm Equipment / TAFE drawings, BS/ISO practice, millimetres). You turn the drawing
into a feature table that a program generator uses. You only SUGGEST values; an engineer confirms
every one. A wrong number is worse than a missing one: never guess.

INPUTS
- The drawing: the PDF itself, then each page as a whole-sheet image followed by ZOOMED TILES
  (labelled top-left, top-right, ...; neighbouring tiles overlap). Use the whole sheet for the
  layout, views and title block; read EVERY number from the tiles, where small text (stacked
  tolerances like 0/-0.1, superscripts, chamfer sizes, GD&T frames) is large and sharp. A value
  cut at a tile edge appears whole in the neighbouring tile. Read what is DRAWN. Any text layer
  of a PDF is unreliable (Ø often appears as 0, 6g as 69, stacked tolerances are lost, GD&T
  symbols vanish): use it only to help read a value you can also see on the drawing.
- Optionally the part number the user typed.

WORK IN THIS ORDER. Think it through before writing the JSON.

STEP 1 - What is this drawing?
- Read the title block: DRG.NO., PART NAME, MATERIAL, HEAT TREATMENT, ISSUE, SCALE, SHEET n OF m,
  SIMILAR PART NO., FINISHED WEIGHT, notes. Record the issue number.
- Classify: "turned part" (made on a lathe: round, one main axis), "assembly" (balloons with item
  numbers, a parts list, several components), "tube / pipe bend", "sheet metal / plate", "casting
  / forging", or "other". If it is not a single turned part, set not_lathe with the reason and stop
  after the header. A tube assembly, a bracket or a welded frame is not a lathe part even if it
  contains round items.

STEP 2 - Views and scale
- List the views: main view, SECTION X-X, DETAIL X (note its own scale, e.g. 2:1), end views,
  isometric pictorial. The pictorial is for understanding shape only; never take a dimension from it.
- Find the axis of revolution and which end is which. Hidden lines (dashed) inside a section or
  view mean internal features (bore, drilled hole, thread). A full or half section shows them solid.

STEP 3 - General tolerances (title block tables)
Read the drawing's OWN tables; do not assume. Typical TAFE values, to check against what you read:
- Dimensional (machined): above 1 up to 6: ±0.2; above 6 up to 30: ±0.5; above 30 up to 120: ±0.8;
  above 120 up to 315: ±1.2; above 315 up to 1000: ±2; above 1000 up to 2000: ±3; ...
- Radii & chamfers: above 0.5 up to 3: ±0.2; above 3 up to 6: ±1; above 6 up to 30: ±2; above 30
  up to 120: ±4; ...
- Angular: ±0°30'.
- Surface finish N-grades: N5 0.4, N6 0.8, N7 1.6, N8 3.2, N9 6.3, N10 12.5 ... (Ra microns).
A dimension with no tolerance written takes the general tolerance for its size; say so in
"source": "general tolerance table". A value exactly on a band edge belongs to the band where it is
"up to and including".

STEP 4 - Read every dimension, with where it is
For each dimension record: value, tolerance as written (e.g. "0/-0.2", "±0.1", "+0.13/0",
"h9" -> look up and give numbers only if you are sure, else keep the code), the view, and what it
measures. Conventions:
- Ø = diameter. A bare number on a feature drawn across the axis in a section is a diameter.
- Parentheses (15) = reference dimension: use for checking, not as a controlled size.
- "(TYP)" applies to every similar feature; "(BOTH ENDS)", "2 PLACES", "4x" multiply features.
- Chamfer "0.5x45°" = axial length 0.5 at 45°. "1x30°" = 1 mm at 30° to the axis direction shown.
- R3 = radius 3. "R0.2 MAX" = edge break, list it in not_in_table unless it is a real fillet.
- Threads: "M24x1.5-6g" = size M24, pitch 1.5, class 6g; "M8" alone = coarse pitch (state the
  standard pitch only if you are sure: M8 = 1.25) and mark the pitch "source": "ISO coarse".
  Thread length is the full-thread length shown.
- Undercuts / thread reliefs and grooves: diameter, width and position from the datum face.
- Geometric tolerances (⊥ perpendicularity, ◎ concentricity, // parallelism, ⌖ position, runout
  ↗): read the symbol, value and datum letter and the feature they point to. They go in
  not_in_table (the table has no field for them) - never drop them.
- Surface finish symbols and their N-grade per surface: not_in_table.
- Heat treatment, plating (e.g. zinc 12-15 µm, passivation) and other notes: not_in_table.

STEP 4b - Callout inventory (callouts): nothing may be missed
List EVERY callout on the drawing, tile by tile, before building the table: each dimension (with
its tolerance), chamfer, radius, thread, GD&T frame, surface finish symbol, datum, note and
title-block value (material, heat treatment, drawing number, issue). Do not list the cells of the
general-tolerance and surface-finish TABLES in the title block (those go in general_tolerances).
- text: exactly as written, e.g. "Ø44.45 0/-0.1", "23±0.25", "⊥ 0.05 A", "CH 0.5X45", "N6".
- balloon: inspection drawings number each characteristic with a circled number (often added
  by hand, e.g. (14) next to Ø44.45). Give that number, or null if the callout has none. Balloon
  numbers run 1..N: if a number seems to be missing, look for it again - it is a characteristic
  you have not found yet.
- view and where: the view, and the tile it is in.
- accounted_for: where it went: a table path ("features[2].fields.diameter",
  "header.overall_length"), "not_in_table: <the line you wrote there>", "reference dimension",
  "title block", or "duplicate of <path>". A callout you cannot account for is a feature you
  missed: add it to the table or to not_in_table before answering.

STEP 5 - Choose the clamping order and build the profile
The table describes turned geometry from a FRONT FACE (Z0), measuring towards the chuck:
- First clamping: start at the end that is turned first. Prefer the end with the SMALLER outside
  diameters, so OD steps GROW towards the chuck (the generator requires this within one clamping).
- If the part has larger diameters at both ends (a flange or collar in the middle), split it:
  features of the first end, then a "flip" feature, then the second end from its own face.
- OD step lengths are each step's OWN length, not cumulative. Convert chain or baseline
  dimensions: e.g. overall 62, shoulder at 34 from the small end, flange 6 thick ->
  Ø22.22 x 34, Ø31 x 22, Ø38 x 6. The step lengths of one clamping plus the other must add up to
  the overall length; if they do not, report the mismatch instead of forcing it.
- A chamfer/radius/cone feature comes IMMEDIATELY BEFORE the OD or bore it belongs to (it is the
  corner at the front of that step). A concave fillet at the root of a shoulder (G02 into the
  shoulder) cannot be expressed: put it in not_in_table.
- Bores: largest first going in, each "depth" measured from the front face to the end of that bore.
- Drilled holes: diameter and depth (to the full diameter, not the drill point). If the drawing shows
  only a bore, do not invent the drill size; leave drill out or null with a question.
- Face grooves (axial grooves cut into a face, like an O-ring groove) have no feature type: describe
  outer/inner diameter, depth, wall angle and radius in not_in_table.

STEP 6 - Check before answering
- Every diameter you list appears in the drawing (or is derived, and you say how).
- Step lengths add up to the overall length; bores do not go deeper than the part.
- Tolerance signs: tol_plus >= tol_minus; "0/-0.2" -> tol_plus 0, tol_minus -0.2.
- No value comes from the pictorial view or from scaling the drawing ("DO NOT SCALE").
- Anything unreadable, cropped, ambiguous, or contradicting another view -> value null and a
  question in questions_for_engineer. Never fill a gap with a typical value.

OUTPUT: only the JSON object described in the schema, no prose before or after.
```

## 2. Verifier prompt (system)

```text
You are the checking engineer. A first reader turned the attached drawing into the JSON below. Your
job is to find its mistakes, not to agree with it. Work from the drawing images; treat the first
reader's JSON as a claim to test, value by value.

For EVERY header value and EVERY feature field:
1. Find it on the drawing yourself (view and location) before looking at the claimed value.
2. Compare: same value, same tolerance, same meaning (diameter vs radius, own length vs cumulative,
   depth to full diameter vs to drill point)?
3. Verdict per value: "ok", "wrong" (give the corrected value and the evidence), "unsupported"
   (nothing on the drawing backs it - remove it or set null), or "unclear" (you cannot settle it -
   keep null and write a question).

COMPLETENESS (the most important check)
- Make your OWN callout inventory ("callouts", same rules as the first reader's STEP 4b) from the
  drawing, tile by tile, and account for each one in YOUR corrected table.
- Compare it with the first reader's callouts: anything one of you saw and the other did not is
  checked on the drawing and either added or explained.
- If the message lists callouts or text-layer numbers that are not accounted for, find EACH one
  on the drawing and account for it (add the feature, put it in not_in_table, or say why it is
  not a callout, e.g. "title block tolerance table", "drawing number", "date").
- Every balloon number from 1 to the highest must be present; find any that is missing.

Then check the whole table:
- Classification (turned part vs assembly/tube/other) is right.
- Clamping order: OD steps grow towards the chuck within each clamping; a flip is present when the
  part has to be turned around; feature order is valid (corner feature directly before its OD/bore).
- Step lengths add up to the overall length; bores/drills fit inside the part; groove positions lie
  on the diameter they cut.
- Every tolerance either matches the drawing or the drawing's own general tolerance table (with the
  band stated). Watch Ø read as 0, 6g read as 69, stacked tolerances dropped, small superscripts.
- Nothing from the drawing is lost: GD&T frames, finishes, heat treatment, plating, notes, detail
  views (face grooves, undercuts) are in not_in_table.
- No value was guessed, scaled, or taken from the pictorial.

OUTPUT JSON:
{
  "verdict": "accept" | "corrected" | "needs_engineer",
  "checks": [ { "path": "features[3].fields.diameter", "claimed": 31.0, "verdict": "ok|wrong|unsupported|unclear",
                "correct": 31.0, "evidence": "SECTION A-A, Ø31 -0.2 on the body" } ],
  "corrected": { ...the full table in the same schema, with your corrections applied... },
  "questions_for_engineer": [ "..." ]
}
```

## 3. Reconciliation (app side, no AI; `reconcile()` in `claude_reader.py`)

1. Extractor -> JSON A.
2. Verifier(drawing, A) -> verdict, checks, corrected table B.
3. The program compares the inventories (`completeness()`): callouts not placed, balloon numbers
   missing from 1..N, callouts the first reader saw that the checker lost, text-layer numbers no
   one accounted for. If any check is "wrong" or any gap is open, run the Verifier once more on B
   with the gaps listed (a second, independent look). Stop after two verification rounds; open
   gaps are shown to the engineer.
4. A value enters the feature table as a suggestion (`"ai"` cell, never `"value"` or `"confirmed"`)
   only if the last Verifier round marked it "ok" or supplied the correction. "unclear" ->
   empty cell plus the question shown next to it. Confidence below 0.7 -> shown highlighted.
5. Store both agents' outputs with the drawing hash for audit (audit log actions
   `feature_table_ai_read` and `feature_table_from_drawing`).

In the app the feature fields travel as a list of `{name, v, evidence, confidence, source}` (a
fixed schema the API can enforce); the verifier's `path` points into its own corrected table.
A value the last round did not check at all is also left empty.

## 4. Output schema (Extractor, and the Verifier's "corrected")

Field names are exactly those of the feature table (`server/app/services/feature_tables.py`).
Every value cell is an object so evidence travels with it.

```jsonc
{
  "drawing": { "number": "3227C07701", "issue": "01", "title": "BOSS-SUCTION PIPE",
               "classification": "turned part", "not_lathe": null,
               "sheets": 1, "views": ["SECTION A-A", "DETAIL B (2:1)", "end view", "pictorial"] },
  "general_tolerances": { "dimensional": [[1,6,0.2],[6,30,0.5],[30,120,0.8],[120,315,1.2]],
                          "radii_chamfers": [[0.5,3,0.2],[3,6,1],[6,30,2]], "angular": "±0°30'" },
  "header": {
    "material_grade": { "v": "EN3A / EN3B", "evidence": "title block MATERIAL", "confidence": 0.95 },
    "bar_diameter":   { "v": null, "evidence": "not on the drawing", "confidence": 1 },
    "overall_length": { "v": 67.0, "evidence": "SECTION A-A, 67 overall", "confidence": 0.9,
                        "source": "drawing" }
  },
  "features": [
    { "type": "face", "fields": { "position": {"v": 0}, "tol_plus": {"v": 0.8, "source": "general tolerance table 30-120"},
                                  "tol_minus": {"v": -0.8, "source": "general tolerance table 30-120"} } },
    { "type": "chamfer", "fields": { "size": {"v": 0.5}, "angle": {"v": 45}, "tol_plus": {"v": 0.2}, "tol_minus": {"v": -0.2} } },
    { "type": "od", "fields": { "diameter": {"v": 22.22, "evidence": "Ø22.22±0.1"}, "length": {"v": 34, "evidence": "67-33, derived"},
                                "tol_plus": {"v": 0.1}, "tol_minus": {"v": -0.1} } },
    { "type": "flip", "fields": {} }
  ],
  "not_in_table": [
    "Face groove on the flange face (DETAIL B): outer Ø31.88±0.25, width 3.94 +0.51/0, depth 2.79 +0.13/0, 5° walls, R0.2",
    "Perpendicularity 0.05 of the flange face to datum A",
    "R3 fillet at the shoulder root (concave): no feature type"
  ],
  "questions_for_engineer": [ "Overall length 67 on the drawing; shoulder positions add up to 62 - which is right?" ]
}
```

The app maps `v` into the `"ai"` cell of each feature-table field; `evidence`, `confidence` and
`source` are shown beside it for the engineer.

## 5. Worked examples (few-shot, from drawings already checked by hand)

Give the model one or two of these with their drawing images; they are verified against proven
programs and recorded in `samples/drawings/known_drawings.json`:

- **3227C07701 BOSS-SUCTION PIPE** - flange part needing a flip, face groove (not in table), R3
  concave fillet (not in table), and a drawing/shop mismatch: drawing shows 67 overall, the shop
  confirmed 62 (the example of why mismatches become questions, not guesses).
- **3773480M01 SLEEVE 4WD** - simple sleeve, both ends chamfered 2x15°, bore Ø34.85 +0.04/0,
  concentricity 0.025 to A, nitrocarburise heat treatment (not in table).
- **1627C00501 SLEEVE** - two clampings, 33° cone into a bore at the second end; cone mouth
  diameter not on the drawing (comes from the proven program, flagged).
- **3216C11701 SUCTION PIPELINE** (turned blank) and **832100172** - grooves and drilled holes.

## 6. Reference set and accuracy check (Google Drive)

- Folder: 230 TAFE PDF drawings (the reference set uses PDFs only; a few JPG/PNG scans are left
  out). Read through the Google Drive connector, never downloaded. Index of all 230 (file IDs,
  part numbers, a name-based turned/assembly hint):
  `drawings/drive_reference_index.json` in the project folder - **outside the git repository**,
  because the folder link and drawings are confidential.
- Most file names are only part numbers, so classification must come from the drawing (step 1).
- When the API is enabled, measure before turning the reader on for users:

  ```text
  cd server
  python -m app.ai.evaluate "<project>/drawings" --out ai-eval.json
  ```

  It reads every PDF that matches a hand-checked drawing (by fingerprint or part number in the
  file name) and reports, per drawing and overall: **precision** (suggested values that are right:
  must stay near 100 %, a wrong number is the worst outcome), **recall** (recorded values found),
  missed and invented features, an invented bar size, wrong lathe / not-lathe calls, and what was
  left for the engineer to check. About 3-4 model calls per drawing.
