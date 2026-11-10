# FOCAS2 notes

Filled in during Milestones 6–7. Placeholder for now.

## Known

- Controller: FANUC Series 0i-TF, Embedded Ethernet, FOCAS2, default TCP port **8193**.
- Program storage path: `//CNC_MEM/USER/PATH1/` (sub-folders such as `/SLEEVE/`).
- Library: `Fwlib32.dll` / `Fwlib64.dll` (Windows), `libfwlib32.so` (Linux). Licensed from FANUC;
  **not** in this repo. Path is set in `bridge/config.yaml` → `focas_library_path`.

## To verify on the machine

- Embedded Ethernet / FOCAS enabled in parameters, IP and port set on the CNC.
- Function signatures and struct layouts (marked `# VERIFY ON MACHINE` in `bridge/focas_ctypes.py`).
- Whether remote Cycle Start / Feed hold is possible (needs a PMC address + ladder change).
