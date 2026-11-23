/**
 * Everything heavy, done once (in the worker): build the job, cut the whole program on the grid,
 * run the safety checks, and keep a snapshot of the material at the start of every operation
 * and at the end.
 */
import { SIM_CONFIG } from './config';
import { Grid, cutMove, tipThroughMaterial, type GridState } from './grid';
import { F, MOVE_TYPE, STRIDE, buildJob, type Job, type JobOptions, type SimCheck } from './job';
import { toolFor } from './tools';

export interface Precomputed {
  job: Job;
  /** Material before move `move` (one per operation start), sorted. */
  snaps: { move: number; state: GridState }[];
  final: GridState;
  ms: number;
}

/** How deep (mm) the tool tip must run through metal at rapid to count as a crash. */
const RAPID_DEPTH = 0.5;
/** Cells a feed move with the spindle stopped may touch before it is an error. */
const STOPPED_CELLS = 4;

const DEFAULT_STOCK = { ...SIM_CONFIG.stock };

/** Bar stock for this run (the worker has its own copy of the config). */
export function applyStock(stock: JobOptions['stock']) {
  const s = SIM_CONFIG.stock;
  s.diameter = stock?.diameter && stock.diameter > 0 ? stock.diameter : DEFAULT_STOCK.diameter;
  s.length =
    stock?.length && stock.length > 0
      ? stock.length + s.faceStockFront + s.faceStockBack
      : DEFAULT_STOCK.length;
}

export function precompute(text: string, opts: JobOptions): Precomputed {
  const started = Date.now();
  applyStock(opts.stock);
  const job = buildJob(text, opts);
  const grid = new Grid();
  const snaps: Precomputed['snaps'] = [];
  const starts = new Set(job.ops.map((o) => o.firstMove));
  for (const s of job.setups) starts.add(s.firstMove);
  const checks: SimCheck[] = [];
  const seen = new Set<string>();
  const add = (c: SimCheck) => {
    const key = `${c.code}|${c.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    checks.push(c);
  };
  const m = job.moves;
  for (let i = 0; i < job.count; i++) {
    if (starts.has(i)) snaps.push({ move: i, state: grid.state() });
    const o = i * STRIDE;
    const type = m[o + F.type];
    const tdef = m[o + F.tool] ? toolFor(m[o + F.tool], job.ops[m[o + F.op]].name) : undefined;
    const crash =
      type === MOVE_TYPE.rapid && tdef && tdef.role !== 'stopper' && tdef.role !== 'unknown'
        ? tipThroughMaterial(grid, job, i, RAPID_DEPTH)
        : null;
    const removed = cutMove(grid, job, i);
    const line = m[o + F.line];
    const tool = m[o + F.tool];
    const t = `T${String(tool).padStart(2, '0')}`;
    const at = { line, move: i, time: m[o + F.t0] };
    // 1. A rapid that removes material is a crash.
    if (crash !== null)
      add({
        severity: 'error',
        code: 'rapid-into-material',
        message: `Rapid move of ${t} runs through material: use G01 at a feed, or move clear first.`,
        ...at,
        time: m[o + F.t0] + (m[o + F.t1] - m[o + F.t0]) * crash,
      });
    // 2. Cutting with the spindle stopped.
    if ((type === MOVE_TYPE.feed || type === MOVE_TYPE.thread) && removed > STOPPED_CELLS && !m[o + F.rpm])
      add({ severity: 'error', code: 'spindle-off', message: `${t} cuts with the spindle stopped.`, ...at });
    // 3. A turning / boring tool past the centre line (drills may run off centre as written).
    if (tool && (type === MOVE_TYPE.feed || type === MOVE_TYPE.thread)) {
      const def = toolFor(tool, job.ops[m[o + F.op]].name);
      const role = def?.role ?? 'unknown';
      if (role !== 'drill' && role !== 'stopper' && !def?.axial) {
        const x = Math.min(m[o + F.x0], m[o + F.x1]);
        // facing a little past centre (X-2 to X-3) to clear the pip is normal shop practice
        const allowed = 3 + 2 * (def?.noseRadius ?? 0.8);
        if (x < -allowed)
          add({
            severity: 'error',
            code: 'past-centre',
            message: `${t} goes past the centre line to X${x.toFixed(3)}.`,
            ...at,
          });
      }
    }
  }
  job.checks = checks;
  for (const c of checks) job.warnings.push(`Line ${c.line}: ${c.message}`);
  job.warnings = [...new Set(job.warnings)];
  return { job, snaps, final: grid.state(), ms: Date.now() - started };
}

/** Buffers to transfer (not copy) from the worker. */
export function transferables(p: Precomputed): Transferable[] {
  const list: Transferable[] = [p.job.moves.buffer, p.final.occ.buffer, p.final.cut.buffer];
  for (const s of p.snaps) list.push(s.state.occ.buffer, s.state.cut.buffer);
  return list;
}
