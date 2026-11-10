# FOCAS2 notes

How ManufAI talks to the FANUC 0i-TF, and what must be checked on the real machine.
Code: `bridge/bridge/focas_ctypes.py` (definitions + `Fwlib` wrapper) and
`bridge/bridge/drivers/focas.py` (`FocasDriver`). Tests: `bridge/tests/test_focas_driver.py`
run against a fake library (`bridge/tests/fake_fwlib.py`) — **nothing here has run on a real
machine yet.**

## The library (licensed, not in this repo)

| Platform | File | Python |
|----------|------|--------|
| Windows 64-bit | `Fwlib64.dll` (+ the series DLLs it loads, e.g. `fwlib30i64.dll`, `fwlibe64.dll`) | 64-bit Python |
| Windows 32-bit | `Fwlib32.dll` (+ `fwlib30i.dll`, `fwlibe1.dll`) | **32-bit Python only** |
| Linux | `libfwlib32.so` (x86 / ARM builds from FANUC) | match the library's bitness |

- Path comes from `bridge/config.yaml` → `focas_library_path`. Keep all FANUC DLLs in the same folder.
- If the file is missing the driver stops with:
  **"FOCAS library not found – obtain Fwlib from FANUC/machine supplier"**.
- Loading a 32-bit DLL into 64-bit Python gives a hint in the error message.
- Linux: `cnc_startupprocess(0, "focas.log")` is called once after loading. # VERIFY ON MACHINE
- `*.dll` / `*.so` are git-ignored. Never commit them.

## Controller side (check on day one)

1. Embedded Ethernet enabled; IP address, subnet and **FOCAS2 port (default 8193)** set in the
   Ethernet settings screen (SYSTEM → Embedded Ethernet / ETHPRM).  # VERIFY ON MACHINE
2. The factory PC can reach the machine: `python bridge/tools/focas_probe.py --ip … --lib …` (M7).
3. Program memory protect (key switch / parameter 3202) blocks writes → `EW_PROT`, shown as
   "Program memory is protected. Turn the program-protect key."

## Call flow

### Connect
`cnc_allclibhndl3(ip, port, timeout_s, &handle)` — timeout from `focas_timeout_s` (default 10 s).
Retries `connect_attempts` times with exponential backoff (0.5 s, 1 s, 2 s … max 8 s).
All calls for one machine run on **one dedicated worker thread** that owns the handle
(FOCAS handles are not shared between threads). Socket/handle/protocol errors free the handle
and mark the driver disconnected; the bridge reconnects on its next poll.

### Status (`read_status`)
| Field | Call | Notes |
|-------|------|-------|
| mode | `cnc_statinfo` → `aut` | 0 MDI, 1 MEM, 3 EDIT, 4 HND, 5 JOG, 6 TJOG, 7 THND, 8 INC, 9 REF, 10 RMT |
| run state | `cnc_statinfo` → `run` | 0 reset→idle, 1 STOP→stopped, 2 HOLD→feed_hold, 3 STRT / 4 MSTR→running |
| emergency | `cnc_statinfo` → `emergency == 1` | |
| alarm | `cnc_alarm2` bitmask (+ `statinfo.alarm == 1`) | messages from `cnc_rdalmmsg2(type=-1)` |
| program | `cnc_rdprgnum` → `mdata` (main) or `data` (running) | |
| block | `cnc_rdseqnum` | N number being executed |
| spindle | `cnc_acts` | actual rpm |
| part count | `cnc_rdparam(6711)` | parameter number # VERIFY ON MACHINE; `None` if it fails |
| feed override | `pmc_rdpmcrng` G0012 (`*FV0-7`, negative logic) | # VERIFY ON MACHINE; `None` if it fails |

`ODBST` uses the Series 30i / 0i-D / 0i-F layout (9 shorts: hdck, tmmode, aut, run, motion,
mstb, emergency, alarm, edit). # VERIFY ON MACHINE

### Program list
`cnc_rdprogdir3(type=1, &top, &num, PRGDIR3[10])` in pages of 10 until fewer are returned.
Lists the **current** folder (`//CNC_MEM/USER/PATH1/`). Other folders (e.g. `/SLEEVE/`) need
`cnc_rdpdf_alldir` — not implemented yet. # VERIFY ON MACHINE

### Read a program from the CNC ("upload" in FANUC terms)
`cnc_upstart4(0, "//CNC_MEM/USER/PATH1/O0001")` → loop `cnc_upload4(&len, buf[1280])`
(retry on `EW_BUFFER`) until the data ends with the closing `%` → always `cnc_upend4`.
Received text: every `\r` removed (the trusted samples use `\n\r\r`), `%` markers kept, LF endings.

### Send a program to the CNC ("download")
Text converted to `%\nO….\n…\n%` with LF endings. `cnc_dwnstart4(0, folder)` → 256-byte chunks via
`cnc_download4(&len, data)` (retry on `EW_BUFFER`; advance by the length the CNC accepted) →
`cnc_dwnend4`. `EW_DATA` from `cnc_dwnend4` = number already exists or program rejected →
`ProgramExists`. The bridge always reads the program back and compares (canonical form: no `\r`,
no trailing spaces, no blank lines, no `%`).

### Delete / select
`cnc_pdf_del(path)` deletes **one** program (never `cnc_delall`).
`cnc_pdf_slctmain(path)` selects the main program.

### Remote Cycle Start / Feed hold / Reset (future, probably never on day one)
Only if `remote_control_enabled: true` **and** a PMC bit address is configured
(`pmc_start_address`, `pmc_feed_hold_address`, `pmc_reset_address`, e.g. `R0100.0`). Otherwise
`RemoteControlNotAvailable` → UI shows "Press Cycle Start at the machine".
The driver pulses the bit: read byte → set bit → wait `pmc_pulse_s` (0.3 s) → read → clear bit
(`pmc_rdpmcrng` / `pmc_wrpmcrng`, byte type). The ladder logic that turns that bit into a cycle
start does not exist yet and needs the machine builder. # VERIFY ON MACHINE

## Return codes → errors shown to operators

| Code | Meaning | Python error |
|------|---------|--------------|
| EW_SOCKET (-16), EW_HANDLE (-8), EW_PROTOCOL (-17) | network / handle lost | `ConnectionLost` (reconnect) |
| EW_BUSY (-1), EW_MODE (12), EW_REJECT (13), EW_RESET (-2) | busy, wrong mode, rejected | `MachineBusy` |
| EW_ALARM (15) | alarm on machine | `MachineAlarm` |
| EW_PROT (7) | memory protected | `MachineBusy` ("turn the program-protect key") |
| EW_PASSWD (17) | program password-locked | `MachineBusy` |
| EW_DATA (5), EW_NUMBER (3) | program missing / exists / invalid | `ProgramNotFound` / `ProgramExists` |
| EW_BUFFER (10) | buffer busy | retried inside upload/download |
| others | see `EW_MESSAGES` | `DriverError` with plain-English text |

## Day-one VERIFY list

Search the code for `VERIFY ON MACHINE`. In short:
1. `ODBST`, `ODBALMMSG2`, `PRGDIR3` layouts on this 0i-TF / library version.
2. `c_long` size for the library build in use (64-bit Linux builds use 8-byte `long`).
3. Path format for `cnc_upstart4` / `cnc_pdf_*` (`//CNC_MEM/USER/PATH1/O0001`).
4. Part-count parameter (6711) and feed-override address (G0012).
5. PMC address type codes for the 0i-F PMC.
6. `cnc_startupprocess` on Linux.
7. Folder listing (`cnc_rdpdf_alldir`) if programs are kept in sub-folders like `/SLEEVE/`.
