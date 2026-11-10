# Trusted sample programs

**Trusted, supplied by the company, proven on LMW Lathe 1 (FANUC 0i-TF).**

| File  | Part number (from header comment) | Description          | SHA-256 (as supplied) |
|-------|-----------------------------------|----------------------|-----------------------|
| O0001 | 3773480M01                        | SLEEVE 4WD           | `92e55218576f6beec6fb2b8e1949d5489d323905c7283e54e7cce50a44fbfef9` |
| O0002 | 1816C01001&1527A02301             | SLEEVE 1-5/16        | `6452d4a4fbc761c7f22edae3d629f8872510c4e0a5a53d35310cb61aaba751d7` |
| O0003 | 1627C00501&1627A00301             | SLEEVE FERUL         | `80723ed416f47eddc825d2bb3afb09e32e3e6257b4763a45987a9fc89920a43b` |
| O0004 | 3314A01701                        | SLEEVE COMPACT       | `36d2cd18c9849f8255439b16fccf697c38d7de0cab0ee03c4ce386105a965a44` |
| O0009 | 3216C11701                        | SUCTION PIPELINE     | `eeac3e1ef7951f0db138978ebf0ae85ebbe1d7dc6d350516826dcc73b59916f3` |

Rules:

- **Do not edit these files.** They are kept byte-for-byte as supplied, including FANUC `%`
  markers and the `\n\r\r` line endings exported by the control. `.gitattributes` stops git from
  converting line endings. A test checks the hashes above.
- They are imported by the server seed as **approved** programs for LMW Lathe 1, with
  source "trusted, supplied by company" (Milestone 9).
