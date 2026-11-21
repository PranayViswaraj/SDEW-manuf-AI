# Trusted sample programs

**Trusted, supplied by the company, proven on LMW Lathe 1 (FANUC 0i-TF).**

| File  | Part number (from header comment) | Description          | SHA-256 (as supplied) |
|-------|-----------------------------------|----------------------|-----------------------|
| O0001 | 3773480M01                        | SLEEVE 4WD           | `92e55218576f6beec6fb2b8e1949d5489d323905c7283e54e7cce50a44fbfef9` |
| O0002 | 1816C01001&1527A02301             | SLEEVE 1-5/16        | `6452d4a4fbc761c7f22edae3d629f8872510c4e0a5a53d35310cb61aaba751d7` |
| O0003 | 1627C00501&1627A00301             | SLEEVE FERUL         | `80723ed416f47eddc825d2bb3afb09e32e3e6257b4763a45987a9fc89920a43b` |
| O0004 | 3314A01701                        | SLEEVE COMPACT       | `36d2cd18c9849f8255439b16fccf697c38d7de0cab0ee03c4ce386105a965a44` |
| O0009 | 3216C11701                        | SUCTION PIPELINE     | `eeac3e1ef7951f0db138978ebf0ae85ebbe1d7dc6d350516826dcc73b59916f3` |

Library-only programs (matched to a drawing by part number, NOT imported onto a machine, because the
shop reuses the O-number for another part):

| File                  | Part number | Description                                   | SHA-256 |
|-----------------------|-------------|-----------------------------------------------|---------|
| O0003_3227C07701      | 3227C07701  | BOSS SUCTION PIPE: N4-N8 only (what runs)     | `95d2dc27892b0874ebd934e7ca6b2c9c8cbfaf79d796e1787e85bed29f46fa45` |
| O0003_3227C07701_FULL | 3227C07701  | BOSS SUCTION PIPE: the whole file as supplied | `a8f9b9fe4d8f490d91dccf83831a1e382d40061992980079be5bc598be535fa3` |

The full file starts with M99P4, so the control jumps to N4 and runs N4-N8 (2nd operation) up to the
M30 after N8. O0003_3227C07701 is exactly those blocks, line for line (shop request, 21 Nov 2026), and
is the program offered for this part. The full file was supplied as pasted text (line endings
normalised to CR LF), so its hash is of that text.

Rules:

- **Do not edit these files.** They are kept byte-for-byte as supplied, including FANUC `%`
  markers and the `\n\r\r` line endings exported by the control. `.gitattributes` stops git from
  converting line endings. A test checks the hashes above.
- They are imported by the server seed as **approved** programs for LMW Lathe 1, with
  source "trusted, supplied by company" (Milestone 9).
