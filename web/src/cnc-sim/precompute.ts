/**
 * Everything heavy, done once (in the worker): build the job, cut the whole program on the grid
 * and keep a snapshot of the material at the start of every operation and at the end.
 */
import { SIM_CONFIG } from './config';
import { Grid, cutMove, type GridState } from './grid';
import { F, STRIDE, buildJob, type Job, type JobOptions } from './job';

export interface Precomputed {
  job: Job;
  /** Material before move `move` (one per operation start), sorted. */
  snaps: { move: number; state: GridState }[];
  final: GridState;
  ms: number;
}

export function precompute(text: string, opts: JobOptions): Precomputed {
  const started = Date.now();
  const job = buildJob(text, opts);
  const grid = new Grid();
  const snaps: Precomputed['snaps'] = [];
  const starts = new Set(job.ops.map((o) => o.firstMove));
  for (const s of job.setups) starts.add(s.firstMove);
  for (let i = 0; i < job.count; i++) {
    if (starts.has(i)) snaps.push({ move: i, state: grid.state() });
    const removed = cutMove(grid, job, i);
    const o = i * STRIDE;
    if (removed > 4 && job.moves[o + F.type] === 0)
      job.warnings.push(
        `Line ${job.moves[o + F.line]}: rapid move into material (T${String(job.moves[o + F.tool]).padStart(2, '0')}).`,
      );
  }
  job.warnings = [...new Set(job.warnings)];
  void SIM_CONFIG;
  return { job, snaps, final: grid.state(), ms: Date.now() - started };
}

/** Buffers to transfer (not copy) from the worker. */
export function transferables(p: Precomputed): Transferable[] {
  const list: Transferable[] = [p.job.moves.buffer, p.final.occ.buffer, p.final.cut.buffer];
  for (const s of p.snaps) list.push(s.state.occ.buffer, s.state.cut.buffer);
  return list;
}
