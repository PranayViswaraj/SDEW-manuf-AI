/**
 * Turn a FANUC lathe program into a playable job: setups (clampings), operations and one flat
 * Float32Array of moves with real times. Pure: runs in the worker and in tests.
 */
import { listSections, parseBlocks, interpret } from '../sim/lathe/gcode';
import type { SimMove } from '../sim/lathe/types';
import { SIM_CONFIG, SIM_MACHINE } from './config';
import { setUnknownDrill, toolFor } from './tools';

/** Floats per move in `moves`. */
export const STRIDE = 16;
export const F = {
  x0: 0, // diameter
  z0: 1,
  x1: 2,
  z1: 3,
  t0: 4,
  t1: 5,
  line: 6,
  op: 7,
  setup: 8,
  tool: 9,
  type: 10, // MOVE_TYPE
  rpm: 11, // signed: + = M03 (CW), - = M04 (CCW), 0 = off
  feedMin: 12, // mm/min, -1 = none
  feedRev: 13, // mm/rev, -1 = none
  known: 14,
  coolant: 15, // 1 = M08 on
} as const;
export const MOVE_TYPE = { rapid: 0, feed: 1, thread: 2, dwell: 3, index: 4 } as const;
const TYPE_OF: Record<SimMove['kind'], number> = MOVE_TYPE;

export type JobMode = 'full' | 'machine';

export interface JobOptions {
  mode: JobMode;
  /** Run the blocks after the last setup (N33, N34 in O0003). Off by default. */
  extras: boolean;
  /** Bar stock for this part (diameter, length mm); the config default when not given. */
  stock?: { diameter?: number | null; length?: number | null };
}

export interface JobOp {
  index: number;
  name: string;
  setup: number;
  tool: number | null;
  firstMove: number;
  lastMove: number;
  t0: number;
  t1: number;
  line: number;
  colour: string;
}

export interface JobSetup {
  index: number;
  name: string;
  section: number;
  /** 0: part frame p = faceFront - z. 1 (turned around): p = L - faceBack + z. */
  orient: 0 | 1;
  firstMove: number;
  lastMove: number;
  t0: number;
  t1: number;
  /** Chuck face in this setup's program Z. */
  chuckZ: number;
  extra: boolean;
}

export interface Job {
  lines: string[];
  moves: Float32Array;
  count: number;
  ops: JobOp[];
  setups: JobSetup[];
  duration: number;
  toolChanges: number[];
  /** Times of M01 optional stops. */
  optionalStops: number[];
  warnings: string[];
  notices: string[];
  /** First word of M99 P at the top (e.g. 4), if any. */
  m99Target: number | null;
  hasExtras: boolean;
  /** Drill size used where a comment gives none ("U DRILL"): just under the smallest bore. */
  drillGuess: number;
  /** Safety checks found while cutting the whole job (see precompute). */
  checks: SimCheck[];
}

export interface SimCheck {
  severity: 'error' | 'warning';
  code: 'rapid-into-material' | 'spindle-off' | 'past-centre';
  message: string;
  line: number;
  move: number;
  time: number;
}

export const OP_COLOURS = [
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#9333ea',
  '#dc2626',
  '#0891b2',
  '#c026d3',
  '#65a30d',
  '#ea580c',
  '#4f46e5',
  '#0d9488',
  '#be123c',
];

const SETUP_MARK = /\b(\d+(ST|ND|RD|TH))\s*OP/i;

export function buildJob(text: string, opts: JobOptions): Job {
  const { lines, blocks } = parseBlocks(text);
  const sections = listSections(text);
  const warnings: string[] = [];
  const notices: string[] = [];

  // M99 Pn near the top: the machine jumps to Nn.
  let m99Target: number | null = null;
  for (const b of blocks.slice(0, 6)) {
    const m = b.words.find((w) => w.letter === 'M' && Math.round(w.value) === 99);
    const p = b.words.find((w) => w.letter === 'P');
    if (m && p) {
      m99Target = Math.round(p.value);
      notices.push(
        `Line ${b.line}: M99 P${m99Target} makes the machine jump to N${m99Target}. "Full job" runs every setup; "Machine-accurate" starts at N${m99Target}.`,
      );
    }
  }

  // Which sections are setups (marked "(1ST OPN)" etc.) and which are extra blocks after them.
  const marked = sections.map((s, k) => {
    const next = sections[k + 1]?.line ?? lines.length + 1;
    const mark = lines.slice(s.line - 1, next - 1).find((ln) => SETUP_MARK.test(ln));
    return mark ? (mark.match(SETUP_MARK) as RegExpMatchArray)[1].toUpperCase() + ' OP' : null;
  });
  // No setup markers at all (e.g. an extract of one operation): every section is a real setup.
  const lastMarked = marked.some(Boolean) ? marked.reduce((a, m, k) => (m ? k : a), -1) : sections.length - 1;
  const hasExtras = sections.some((_, k) => k > lastMarked);

  let chosen: { section: number; name: string; extra: boolean }[];
  if (opts.mode === 'machine' && m99Target !== null) {
    const target = blocks.find((b) => b.seq === m99Target);
    const sec = target ? sections.filter((s) => s.line <= target.line).at(-1) : undefined;
    chosen = sec
      ? [{ section: sec.index, name: marked[sections.indexOf(sec)] ?? sec.label, extra: false }]
      : [];
    if (!sec) warnings.push(`M99 P${m99Target}: N${m99Target} not found; nothing to run.`);
  } else {
    chosen = sections
      .map((s, k) => ({
        section: s.index,
        name: marked[k] ?? (marked.some(Boolean) ? s.label : `SETUP ${k + 1}`),
        extra: k > lastMarked,
      }))
      .filter((c) => opts.extras || !c.extra);
  }

  const rows: number[] = [];
  const ops: JobOp[] = [];
  const setups: JobSetup[] = [];
  const toolChanges: number[] = [];
  const optionalStops: number[] = [];
  let t = 0;
  let orient: 0 | 1 = 1;
  const usedFor = new Map<number, Set<string>>();

  for (const c of chosen) {
    const res = interpret(text, SIM_MACHINE, c.section);
    for (const ch of res.checks) warnings.push(`Line ${ch.line}: ${ch.message}`);
    // Each marked setup turns the part around; extra blocks stay in the last clamping.
    if (!c.extra) orient = orient === 0 ? 1 : 0;
    const setupIndex = setups.length;
    const first = rows.length / STRIDE;
    const setupT0 = t;
    let minZ = Infinity;
    let lastOpKey = '';
    // Moves before the first N-block comment belong to the operation that follows.
    const labels = res.moves.map((m) => (m.label || '').trim().toUpperCase());
    for (let i = labels.length - 2; i >= 0; i--) if (!labels[i]) labels[i] = labels[i + 1];
    res.moves.forEach((m, mi) => {
      // Moves from an unknown start (program start, before G28): come from home.
      let from = m.from;
      if (!m.known) from = [SIM_MACHINE.home!.z, SIM_MACHINE.home!.x / 2];
      let dt = m.realTime;
      if (dt === null) {
        if (m.kind === 'rapid') {
          const d = Math.max(Math.abs(m.to[0] - from[0]), Math.abs(m.to[1] - from[1]));
          dt = d / (SIM_MACHINE.rapidRate! / 60);
        } else if (m.kind === 'index') dt = 1;
        else dt = m.t1 - m.t0;
      }
      const label = labels[mi] || 'PROGRAM';
      const key = label;
      if (key !== lastOpKey) {
        lastOpKey = key;
        ops.push({
          index: ops.length,
          name: label,
          setup: setupIndex,
          tool: null,
          firstMove: rows.length / STRIDE,
          lastMove: rows.length / STRIDE,
          t0: t,
          t1: t,
          line: m.line,
          colour: OP_COLOURS[ops.length % OP_COLOURS.length],
        });
      }
      const op = ops[ops.length - 1];
      if (m.kind === 'index') toolChanges.push(t);
      if ((m.kind === 'feed' || m.kind === 'thread') && m.tool !== null) {
        const set = usedFor.get(m.tool) ?? new Set<string>();
        set.add(label);
        usedFor.set(m.tool, set);
        minZ = Math.min(minZ, m.to[0], from[0]);
        const tool = toolFor(m.tool, label);
        const negX = Math.min(m.to[1], from[1]) < -0.01;
        if (negX && tool?.role !== 'drill' && tool?.role !== 'stopper')
          warnings.push(`Line ${m.line}: T${pad(m.tool)} goes to negative X (X${(m.to[1] * 2).toFixed(3)}).`);
        if (negX && tool?.role === 'drill')
          warnings.push(
            `Line ${m.line}: T${pad(m.tool)} (${tool.name}) runs off centre at X${(Math.min(m.to[1], from[1]) * 2).toFixed(3)}: simulated as written.`,
          );
      }
      const rpm = m.rpm ?? 0;
      rows.push(
        from[1] * 2,
        from[0],
        m.to[1] * 2,
        m.to[0],
        t,
        t + dt,
        m.line,
        op.index,
        setupIndex,
        m.tool ?? 0,
        TYPE_OF[m.kind],
        m.spindle === 'off' ? 0 : m.spindle === 'cw' ? rpm : -rpm,
        m.feedMin ?? -1,
        m.feedRev ?? -1,
        m.known ? 1 : 0,
        m.coolant ? 1 : 0,
      );
      t += dt;
      op.lastMove = rows.length / STRIDE - 1;
      op.t1 = t;
      if ((m.kind === 'feed' || m.kind === 'thread') && m.tool !== null && op.tool === null) op.tool = m.tool;
    });
    setups.push({
      index: setupIndex,
      name: c.extra ? `${c.name} (extra)` : c.name,
      section: c.section,
      orient,
      firstMove: first,
      lastMove: rows.length / STRIDE - 1,
      t0: setupT0,
      t1: t,
      chuckZ: Number.isFinite(minZ) ? Math.min(minZ - 2, -10) : -40,
      extra: c.extra,
    });
    if (c.extra)
      warnings.push(`${c.name}: extra block after M30; run in the last clamping (orientation assumed).`);
  }

  // A drill with no size in its comment: just under the smallest bore the program finishes.
  let minBore = Infinity;
  for (let i = 0; i < rows.length / STRIDE; i++) {
    const o = i * STRIDE;
    if (rows[o + F.type] !== MOVE_TYPE.feed || !rows[o + F.tool]) continue;
    const op = ops[rows[o + F.op]];
    if (toolFor(rows[o + F.tool], op.name)?.role !== 'bore') continue;
    const x = Math.min(rows[o + F.x0], rows[o + F.x1]);
    if (x > 4) minBore = Math.min(minBore, x);
  }
  const drillGuess = Number.isFinite(minBore) ? Math.max(5, Math.floor(minBore - 1)) : 16;
  setUnknownDrill(drillGuess);

  // M01 optional stops: at the first move after each M01 line.
  const moveLines = new Float32Array(rows.length / STRIDE);
  for (let i = 0; i < moveLines.length; i++) moveLines[i] = rows[i * STRIDE + F.line];
  for (const b of blocks) {
    if (!b.words.some((w) => w.letter === 'M' && Math.round(w.value) === 1)) continue;
    for (let i = 0; i < moveLines.length; i++)
      if (moveLines[i] > b.line) {
        optionalStops.push(rows[i * STRIDE + F.t0]);
        break;
      }
  }
  for (const b of blocks) {
    const m = b.words.filter((w) => w.letter === 'M').map((w) => Math.round(w.value));
    for (const code of [10, 11, 25, 26])
      if (m.includes(code)) notices.push(`Line ${b.line}: M${code} (logged only).`);
  }
  for (const [tool, labels] of usedFor)
    if (labels.size > 1)
      warnings.push(
        `T${pad(tool)} is used for ${labels.size} jobs (${[...labels].join(', ')}): check the turret.`,
      );

  return {
    lines,
    moves: new Float32Array(rows),
    count: rows.length / STRIDE,
    ops,
    setups,
    duration: t,
    toolChanges,
    optionalStops,
    warnings: [...new Set(warnings)],
    notices,
    m99Target,
    hasExtras,
    drillGuess,
    checks: [],
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Index of the move running at time t (binary search on end times). */
export function moveAt(moves: Float32Array, count: number, t: number): number {
  let lo = 0;
  let hi = count - 1;
  if (hi < 0) return -1;
  if (t >= moves[hi * STRIDE + F.t1]) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (moves[mid * STRIDE + F.t1] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const STOCK = SIM_CONFIG.stock;
