/**
 * 3D lathe simulation: shared types (advisory only, fixed rules, no AI).
 *
 * Coordinates inside the simulation are (z, r): Z along the spindle axis (program Z), r = radius
 * (program X / 2). Everything shown to people uses diameter, as on the machine.
 */

export type Point = [number, number]; // [z, r]

/** What a tool does, from the tool list (or the program comment when the list has no entry). */
export type ToolRole = 'od' | 'bore' | 'groove' | 'part' | 'thread' | 'drill' | 'stopper' | 'unknown';

/** ISO insert shape letter, or a special form. */
export type InsertShape = 'C' | 'D' | 'V' | 'W' | 'T' | 'S' | 'R' | 'K' | 'groove' | 'thread' | 'drill';

/** Where a value came from: shown next to it so people know what to trust. */
export type Source = 'tool list' | 'insert code' | 'program comment' | 'tool type' | 'demo data';

export interface SimTool {
  /** Turret station / T number (T0303 -> 3). */
  number: number;
  name: string;
  role: ToolRole;
  roleSource?: Source;
  /** Insert shape. null = unknown: the tool then removes material at its tip point only. */
  shape: InsertShape | null;
  /** Inscribed circle / edge length of the insert (mm). null = unknown. */
  insertSize: number | null;
  noseRadius: number | null;
  /** FANUC imaginary tip direction 0..9. null = unknown. */
  tipDirection: number | null;
  tipSource?: Source;
  /** Holder text (e.g. "PCLNR 2525M12", "S20S-SCLCR09"). null = unknown: no holder checks. */
  holder: string | null;
  /** Lead (approach) angle of the holder, degrees (95 for PCLN). null = unknown. */
  leadAngle: number | null;
  /** Boring bar shank diameter (mm). */
  barDiameter?: number | null;
  /** Smallest bore the boring bar fits (mm), from the holder catalogue. */
  minBore?: number | null;
  /** Groove / part-off insert width (mm). */
  width?: number | null;
  /** Groove / part-off: which blade edge the Z offset is set on. */
  refEdge?: 'left' | 'right' | null;
  /** Thread insert included angle (60 for metric). */
  threadAngle?: number | null;
  drillDiameter?: number | null;
  /** Spindle direction this tool cuts in (M03 / M04). null = unknown: not checked. */
  spindle?: 'M03' | 'M04' | null;
}

export interface SimStock {
  /** Bar diameter (mm). */
  diameter: number | null;
  /** Bar length (mm). Shown only. */
  length: number | null;
  /** How far the bar sticks out of the chuck jaws, measured from the bar's front face (mm). */
  stickOut: number | null;
  /** Bar front face in program Z (face stock left in front of Z0, e.g. 1.0). */
  faceZ: number | null;
}

export interface SimMachine {
  name: string;
  /** Allowed X range, program diameter values [min, max]. null = unknown. */
  travelX: [number, number] | null;
  /** Allowed Z range in program coordinates [min, max]. null = unknown. */
  travelZ: [number, number] | null;
  maxRpm: number | null;
  /** Rapid traverse rate (mm/min). null = unknown: rapid time is not counted. */
  rapidRate: number | null;
  /** Turret index time per tool change (s). null = unknown: not counted. */
  indexTime?: number | null;
  /** Reference point (G28) in program coordinates: X diameter, Z. null = unknown. */
  home?: { x: number; z: number } | null;
  /** Second reference point (G30), program coordinates. Defaults to home. */
  home30?: { x: number; z: number } | null;
  /** Chuck outside diameter (mm), for drawing and the chuck check. */
  chuckDiameter?: number | null;
  turretStations?: number | null;
}

/** Finished shape from the drawing (first clamping). Z is program Z, sizes are diameters. */
export interface DrawingStep {
  dia: number;
  z_front: number;
  z_back: number;
  /** Axial length of the corner at the front of the step: skipped by the compare. */
  corner?: number;
}

export interface DrawingProfile {
  length: number;
  od: DrawingStep[];
  bores: DrawingStep[];
  drill?: { dia: number; depth: number } | null;
  grooves?: { dia: number; z_front: number; z_back: number }[];
  threads?: { major: number; pitch: number; z_front: number; z_back: number }[];
}

export interface SimInput {
  program: string;
  stock: SimStock;
  material: string | null;
  tools: SimTool[];
  machine: SimMachine;
  drawing?: DrawingProfile | null;
  /** Which operation (clamping) of a multi-operation file to run, split at M30. Default 0. */
  section?: number;
}

export type OpKind =
  'Face' | 'Rough' | 'Finish' | 'Groove' | 'Thread' | 'Drill' | 'Bore' | 'Part-off' | 'Other';

export const OP_KINDS: OpKind[] = [
  'Face',
  'Rough',
  'Finish',
  'Groove',
  'Thread',
  'Drill',
  'Bore',
  'Part-off',
  'Other',
];

export type MoveKind = 'rapid' | 'feed' | 'thread' | 'dwell' | 'index';

export interface SimMove {
  index: number;
  /** 1-based line in the program text. */
  line: number;
  kind: MoveKind;
  from: Point;
  to: Point;
  /** False when the start position was not known (after G28 with no home): drawn as a jump. */
  known: boolean;
  tool: number | null;
  op: OpKind;
  /** Short name of the cycle or code running this move, e.g. "G71 rough", "G01". */
  cycle: string;
  /** Feed per revolution (mm/rev) or null under G98 / for rapids. */
  feedRev: number | null;
  /** Feed per minute (mm/min) at the start of the move. */
  feedMin: number | null;
  rpm: number | null;
  /** Cutting speed at the start of the move (m/min). */
  vc: number | null;
  css: boolean;
  spindle: 'cw' | 'ccw' | 'off';
  coolant: boolean;
  comp: 40 | 41 | 42;
  /** Program comment naming the tool at its call, e.g. "OD FIN". */
  label?: string;
  /** Thread lead (mm/rev) for thread moves. */
  pitch?: number;
  /** Real time of this move in seconds; null when it cannot be known (rapid rate unknown). */
  realTime: number | null;
  /** Timeline (animation) start and end, seconds. Equal to real time where it is known. */
  t0: number;
  t1: number;
}

export type Severity = 'error' | 'warning';

export type CheckCode =
  | 'rapid-into-material'
  | 'chuck-collision'
  | 'insert-rubbing'
  | 'holder-collision'
  | 'past-centre'
  | 'bar-too-big'
  | 'spindle-off'
  | 'cut-after-partoff'
  | 'undersize'
  | 'over-travel'
  | 'g96-no-g50'
  | 'spindle-direction'
  | 'oversize'
  | 'tool-unknown'
  | 'travel-unknown'
  | 'input-unknown'
  | 'program';

export interface SimCheck {
  severity: Severity;
  code: CheckCode;
  message: string;
  line: number | null;
  move: number | null;
  time: number | null;
}

export interface OpGroup {
  op: OpKind;
  tool: number | null;
  firstMove: number;
  lastMove: number;
  line: number;
  /** Real seconds (known part). */
  time: number;
  /** True when some of the time is unknown (rapids without a rapid rate). */
  partial: boolean;
}

export interface ThreadZone {
  zFront: number;
  zBack: number;
  /** Radius before threading (crest) and the deepest radius reached (root). */
  major: number;
  minor: number;
  pitch: number;
  external: boolean;
}

export type CompareState = 0 | 1 | 2 | 3; // 0 = not compared, 1 = OK, 2 = too deep, 3 = excess

export interface MaterialSnapshot {
  outer: Float32Array;
  inner: Float32Array;
  tagOuter: Uint8Array;
  tagInner: Uint8Array;
  partedAt: number | null;
  threads: ThreadZone[];
}

export interface SimResult {
  moves: SimMove[];
  lines: string[];
  checks: SimCheck[];
  ops: OpGroup[];
  duration: number;
  /** Real total time of what is known (s) and whether some of it is unknown. */
  realTime: number;
  realTimePartial: boolean;
  grid: { zMin: number; zMax: number; res: number; barR: number; faceZ: number; chuckZ: number | null };
  /** Snapshots of the material BEFORE move `at` (sorted). */
  snapshots: { at: number; state: MaterialSnapshot }[];
  final: MaterialSnapshot;
  compare: { state: Uint8Array; inner: Uint8Array; summary: string } | null;
  /** Fields that were missing from the input, as "what: unknown". */
  unknowns: string[];
  blocked: boolean;
  /** Tools as simulated: the tool list, plus tools named only in program comments. */
  tools: SimTool[];
}
