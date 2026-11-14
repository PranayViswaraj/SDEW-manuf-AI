# Go-live runbook: first part on LMW SMARTURN 55-04927

The first production day, step by step. Read it once fully before starting.

## What works on day 1, and what does not yet

| Works | Not yet (and the day-1 way round it) |
|---|---|
| Upload a drawing; known drawings fill their values, both clampings | Unknown drawings: values are typed in by the engineer |
| Engineer confirms the table, chooses the machine, generates the program | |
| Program check: validator, tool path drawing, engineer/programmer accepts it | |
| **USB stick**: the accepted program downloads as `O1000.NC` | **Network send**: needs FANUC's FOCAS library (`Fwlib32.dll`, from FANUC or LMW) and the bridge PC on the machine network. Until then, use USB. |
| Audit log of every change, accept and download | Tool list and machine limits per machine: the program uses the turret of the part's proven program (shown in the notes) |

Safety rules that never change: the program is never written by AI; nobody runs a program that
is not accepted; Cycle Start is pressed at the machine by the operator.

## A. Before the day (IT, about 1 hour)

**Option 1 - one Windows PC (recommended to start).** The laptop or office PC that runs ManufAI;
other laptops and tablets open it in a browser over Wi-Fi or the office network.

1. Once: `.\scripts\setup.ps1` (installs what the app needs).
2. Start: `.\scripts\start-production.ps1`. The first time it builds the app, makes a secret key,
   creates the database outside OneDrive (`%LOCALAPPDATA%\ManufAI`), adds the six machines and
   asks for the first admin (name + password of 10+ characters). It prints the address to open,
   e.g. `http://192.168.1.25:8080`. Run it once "as administrator" so the firewall lets other
   laptops in.
3. Start with Windows and back up every evening at 20:00: `.\scripts\install-autostart.ps1`.
   Copy one file from `%LOCALAPPDATA%\ManufAIackups` to a pen drive every week.
4. Log in as the admin and add everyone on the **Users** page (personal accounts; the shared
   `qwerty` test accounts do not exist here). Only people on the production head's list get
   **Allowed to press Start**.
5. After updating the code: `.\scripts\start-production.ps1 -Rebuild`.

**Option 2 - server with Docker (later, for several sites).** `docker compose -f
docker-compose.prod.yml --env-file .env.prod up -d --build` with PostgreSQL and HTTPS; see
`docs/deployment.md`.

The installed app: in Chrome or Edge, open the address and choose **Install ManufAI** (address
bar icon). It then opens from the Start menu or taskbar in its own window, like a program.

## B. The first part (engineer + programmer, 20 minutes)

Use **3773480M01 (Sleeve 4WD)**: its proven program O0001 matches the generated one most closely.

1. **Drawing to program → Upload** `3773480M01 SLEEVE 4WD.pdf`. The values fill in.
2. Check every row against the drawing and tick it. Rows after **Turn part around** are the back
   end, measured from the back face. Read the blue notice: the bar size (Ø48) and the back-end
   lengths (Z-4.0 / Z-5.0) are not on the drawing and say where they come from. Measure the bar on
   the rack. Press **Confirm table**.
3. Choose **LMW SMARTURN · 55-04927** → **Generate live program**.
4. Compare with the proven program O0001: step 4 shows **Compare with proven program O0001**,
   the generated cutting path (blue) over O0001 (amber) for each clamping. Same tools (T0101 drill, T0202 rough, T0303
   finish, T0707 bore, T0404 parting), part-off at Z-26.5, second side from N6. If anyone has a
   doubt, press **use O0001 instead**: the proven program, byte for byte, goes through the same
   accept step.
5. Read every note and warning on the page. Then **Accept program** (engineer or programmer).
6. **Download O1000.NC for a USB stick** (step 6). The download is refused unless the accepted,
   latest version is the one being downloaded.

## C. At the machine (programmer + operator)

1. Load `O1000.NC` from the USB stick (EDIT mode, program list, device = USB memory). Check the
   program number and the first lines on the screen.
2. Turret: the tools must sit where O0001 has them (T0101 … T0707). Tool offsets as for O0001.
3. **Dry run** with no bar in the chuck, or the turret well clear: single block on, rapid and feed
   override low, hand on Feed Hold. Watch every tool's first move.
4. **First piece**, first clamping, in single block: the program stops at `M30` after part-off.
5. Turn the part around, set **Z0 on the finished back face** (the part-off leaves 0.5 mm for
   facing), then sequence search **N6** and run the second clamping in single block.
6. Measure every dimension against the drawing (Ø44.45 0/-0.1, Ø34.85 +0.04/0, 23 ±0.25,
   2 × 15° chamfers both ends) and write them on the first-piece sheet. (In the app the first-piece
   record and the "proven" mark belong to a run sent over the network; with USB they stay on paper
   until the bridge is in.)
7. Not good → stop, note what was off, do not run a second piece; the programmer fixes the setup
   values and generates again (a new version must be accepted again).

**Stop at once** on any alarm, unexpected move, tool not where expected, or a value on the screen
that differs from the drawing. Nothing in the app overrides the operator's judgement.

## D. After day 1

- Get the FOCAS library and set up the bridge PC (WiFi bridge guide) to send over the network.
- Enter the turret tool list and the machine limits on the Machines page.
- Programmer checks the three notes marked **CHECK WITH THE PROGRAMMER** (1816C01001, 1627C00501,
  3216C11701): places where the proven program and the drawing differ.
