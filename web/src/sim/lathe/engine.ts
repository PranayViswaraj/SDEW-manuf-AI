/**
 * Lathe simulation engine: program -> moves -> material removal -> checks (advisory only).
 *
 * Pure and deterministic, so it runs in a web worker and in tests. It never changes the program
 * and never talks to a machine.
 */

import { classifyOps, interpret } from './gcode';
import { Stock, radial, spanAt, type CutMode } from './stock';
import { angleOf, hull, insideWedge, toolGeometry, type ToolGeometry } from './tools';
import {
  OP_KINDS,
  type CheckCode,
  type MaterialSnapshot,
  type OpGroup,
  type OpKind,
  type Point,
  type Severity,
  type SimCheck,
  type SimInput,
  type SimMove,
  type SimResult,
  type SimTool,
} from './types';

/** Colour index of each operation in the material tags (0 = raw bar). */
export const OP_TAG: Record<OpKind, number> = Object.fromEntries(
  OP_KINDS.map((k, i) => [k, i + 1]),
) as Record<OpKind, number>;

const RUB_MARGIN = 2; // degrees of clearance the edges need
const MIN_AREA = 0.01; // mm²: less than this is a touch, not a cut
const COMPARE_TOL = 0.02; // mm on radius
const SHOULDER_SKIP = 1.0; // mm next to each step end: nose radius corners are not compared
const SNAPSHOTS = 240;

export function cutMode(tool: SimTool | undefined): CutMode {
  switch (tool?.role) {
    case 'od':
    case 'groove':
    case 'part':
      return 'outer';
    case 'bore':
    case 'drill':
      return 'inner';
    case 'thread':
      return 'thread';
    default:
      return 'auto';
  }
}

const translate = (poly: Point[], p: Point): Point[] => poly.map(([z, r]) => [z + p[0], r + p[1]]);

/** Where the imaginary tip is for a programmed point, with G41/G42 nose radius compensation. */
export function placeTip(p: Point, d: Point | null, comp: 40 | 41 | 42, g: ToolGeometry): Point {
  const rn = g.nose.r;
  if (comp === 40 || !d || rn <= 0) return p;
  const len = Math.hypot(d[0], d[1]) || 1;
  const dz = d[0] / len;
  const dr = d[1] / len;
  const n: Point = comp === 42 ? [dr, -dz] : [-dr, dz];
  const c: Point = [p[0] + rn * n[0], p[1] + rn * n[1]];
  return [c[0] - rn * g.nose.signs[0], c[1] - rn * g.nose.signs[1]];
}

/** Swept insert of a move from `a` to `b` (programmed points). */
export function sweep(poly: Point[], a: Point, b: Point): Point[] {
  if (!poly.length) return [];
  return hull([...translate(poly, a), ...translate(poly, b)]);
}

/** Sutherland-Hodgman: does a convex polygon overlap the box? */
function overlapsBox(poly: Point[], z0: number, z1: number, r0: number, r1: number): boolean {
  let pts = poly;
  const clip = (inside: (p: Point) => boolean, cut: (p: Point, q: Point) => Point) => {
    const out: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      const pi = inside(p);
      const qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push(cut(p, q));
    }
    pts = out;
  };
  const atZ =
    (z: number) =>
    (p: Point, q: Point): Point => {
      const t = (z - p[0]) / (q[0] - p[0]);
      return [z, p[1] + t * (q[1] - p[1])];
    };
  const atR =
    (r: number) =>
    (p: Point, q: Point): Point => {
      const t = (r - p[1]) / (q[1] - p[1]);
      return [p[0] + t * (q[0] - p[0]), r];
    };
  clip((p) => p[0] >= z0, atZ(z0));
  if (pts.length) clip((p) => p[0] <= z1, atZ(z1));
  if (pts.length) clip((p) => p[1] >= r0, atR(r0));
  if (pts.length) clip((p) => p[1] <= r1, atR(r1));
  if (pts.length < 3) return false;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2 > 1e-4;
}

const fmtZ = (z: number) => z.toFixed(2);

export function runSimulation(input: SimInput): SimResult {
  const toolMap = new Map<number, SimTool>();
  for (const t of input.tools) toolMap.set(t.number, t);
  const toolOf = (n: number) => toolMap.get(n);
  const geoms = new Map<number, ToolGeometry>();
  const geomOf = (n: number | null): ToolGeometry => {
    const key = n ?? -1;
    if (!geoms.has(key)) geoms.set(key, toolGeometry(n === null ? undefined : toolOf(n)));
    return geoms.get(key) as ToolGeometry;
  };

  const { lines, moves, checks: progChecks, toolsUsed } = interpret(input.program, input.machine);
  classifyOps(moves, toolOf);
  const checks: SimCheck[] = [];
  const add = (severity: Severity, code: CheckCode, message: string, m: SimMove | null) => {
    const line = m?.line ?? null;
    if (checks.some((c) => c.code === code && c.line === line)) return;
    checks.push({ severity, code, message, line, move: m?.index ?? null, time: m ? m.t0 : null });
  };

  // ---------------------------------------------------- timeline
  let t = 0;
  let real = 0;
  for (const m of moves) {
    const dt = m.t1;
    m.t0 = t;
    m.t1 = t + dt;
    t += dt;
    real += m.realTime ?? 0;
  }
  // Unknown: rapids without a rapid rate, feeds without spindle speed. Jumps from an unknown
  // position (program start) and index times are not part of the cycle time shown.
  const partial = moves.some((m) => m.realTime === null && m.known && m.kind !== 'index');

  // ---------------------------------------------------- unknown inputs
  const unknowns: string[] = [];
  const unknown = (what: string, code: CheckCode = 'input-unknown', detail = '') => {
    unknowns.push(what);
    add('warning', code, `${what}: unknown${detail ? ` (${detail})` : ''}.`, null);
  };
  const { stock, machine } = input;
  if (!stock.diameter) unknown('Bar diameter', 'input-unknown', 'bar drawn from the largest cut');
  if (!stock.length) unknown('Bar length');
  if (stock.stickOut === null)
    unknown('Stick-out from the chuck', 'input-unknown', 'chuck collisions not checked');
  if (stock.faceZ === null) unknown('Bar front face Z', 'input-unknown', 'bar drawn with its face at Z0');
  if (!input.material) unknown('Material');
  if (!machine.travelX || !machine.travelZ)
    unknown('Machine X/Z travel', 'travel-unknown', 'over-travel not checked');
  if (!machine.maxRpm) unknown('Machine max rpm');
  if (!machine.rapidRate) unknown('Rapid rate', 'input-unknown', 'rapid time not counted');
  for (const n of toolsUsed) {
    const tool = toolOf(n);
    const g = geomOf(n);
    const tn = `T${String(n).padStart(2, '0')}`;
    if (!tool) {
      unknowns.push(`${tn} tool data`);
      add(
        'warning',
        'tool-unknown',
        `${tn}: not in the tool list. It cuts at its tip point only; no holder checks.`,
        null,
      );
      continue;
    }
    const miss = [...g.missing];
    if (!tool.holder && tool.role !== 'stopper') miss.push('holder');
    if (!tool.spindle && tool.role !== 'stopper') miss.push('spindle direction');
    if (miss.length) {
      unknowns.push(`${tn} ${miss.join(', ')}`);
      add(
        'warning',
        'tool-unknown',
        `${tn} ${tool.name}: ${miss.join(', ')} unknown${g.shaped ? '' : ' - cuts at its tip point only'}${
          tool.holder ? '' : '; holder collisions not checked'
        }.`,
        null,
      );
    }
  }

  // ---------------------------------------------------- stock and grid
  const feeds = moves.filter((m) => m.known && (m.kind === 'feed' || m.kind === 'thread'));
  const allPts = moves.filter((m) => m.known).flatMap((m) => [m.from, m.to]);
  const maxFeedR = feeds.length
    ? Math.max(...feeds.flatMap((m) => [Math.abs(m.from[1]), Math.abs(m.to[1])]))
    : 10;
  const minFeedZ = feeds.length ? Math.min(...feeds.flatMap((m) => [m.from[0], m.to[0]])) : -20;
  const barR = stock.diameter ? stock.diameter / 2 : Math.ceil(maxFeedR + 1);
  const faceZ = stock.faceZ ?? 0;
  const chuckZ = stock.stickOut !== null ? faceZ - stock.stickOut : null;
  const zLow = Math.min(chuckZ ?? minFeedZ - 10, minFeedZ - 5) - 20;
  const zHigh = Math.max(faceZ, ...allPts.map((p) => p[0]).filter((z) => z < faceZ + 5), 0) + 2;
  const res = Math.min(0.25, Math.max(0.05, (zHigh - zLow) / 2500));
  const mat = new Stock(zLow, zHigh, res, barR, faceZ);
  const chuckR = (machine.chuckDiameter ?? Infinity) / 2;

  // ---------------------------------------------------- run the moves
  const every = Math.max(1, Math.ceil(moves.length / SNAPSHOTS));
  const snapshots: { at: number; state: MaterialSnapshot }[] = [];
  let lastDir: Point | null = null;
  for (const m of moves) {
    if (m.index % every === 0) snapshots.push({ at: m.index, state: mat.snapshot() });
    if (!m.known || m.kind === 'dwell' || m.kind === 'index') continue;
    const tool = m.tool !== null ? toolOf(m.tool) : undefined;
    const g = geomOf(m.tool);
    const d: Point = [m.to[0] - m.from[0], m.to[1] - m.from[1]];
    if (Math.hypot(d[0], d[1]) > 1e-9) lastDir = d;
    const a = placeTip(m.from, lastDir, m.comp, g);
    const b = placeTip(m.to, lastDir, m.comp, g);
    const swept = sweep(g.insert, a, b);
    const holders = g.holder.map((h) => sweep(h, a, b));
    const cutting = m.kind === 'feed' || m.kind === 'thread';
    const tn = m.tool !== null ? `T${String(m.tool).padStart(2, '0')}` : 'the tool';

    // Over-travel.
    if (machine.travelX && machine.travelZ) {
      const [x0, x1] = machine.travelX;
      const [z0, z1] = machine.travelZ;
      const x = m.to[1] * 2;
      if (x < x0 - 1e-6 || x > x1 + 1e-6 || m.to[0] < z0 - 1e-6 || m.to[0] > z1 + 1e-6)
        add('error', 'over-travel', `X${x.toFixed(3)} Z${fmtZ(m.to[0])} is outside the machine travel.`, m);
    }
    // Past centre.
    const role = tool?.role ?? 'unknown';
    if (role !== 'drill' && role !== 'stopper') {
      const allowed = g.nose.r + 0.5;
      if (m.to[1] < -allowed)
        add('error', 'past-centre', `${tn} goes past the centre to X${(m.to[1] * 2).toFixed(3)}.`, m);
    }
    // Chuck and jaws: everything behind the chuck face outside the bar.
    if (chuckZ !== null) {
      const bodies = [swept, ...holders];
      const hit = bodies.some(
        (p) =>
          p.length > 2 &&
          (overlapsBox(p, -1e6, chuckZ, barR - 0.01, chuckR) ||
            overlapsBox(p, -1e6, chuckZ, -chuckR, -(barR - 0.01))),
      );
      if (hit)
        add('error', 'chuck-collision', `${tn} ${holders.length ? 'or its holder ' : ''}hits the chuck.`, m);
    }
    // Cut.
    const before = mat.partedAt;
    const r = mat.cut(
      swept,
      cutMode(tool),
      OP_TAG[m.op],
      m.kind === 'thread' ? (m.pitch ?? m.feedRev ?? 0) : 0,
    );
    // Holder / boring bar against the part (after the insert has cut its way).
    for (const h of holders) {
      if (h.length > 2 && mat.overlaps(h)) {
        if (role === 'bore')
          add(
            'error',
            'bar-too-big',
            `${tn} boring bar is too big for the bore here: its body hits the part.`,
            m,
          );
        else add('error', 'holder-collision', `${tn} holder hits the part.`, m);
      }
    }

    if (r.area > MIN_AREA) {
      if (m.kind === 'rapid') add('error', 'rapid-into-material', `Rapid move of ${tn} into material.`, m);
      else if (m.spindle === 'off') add('error', 'spindle-off', `${tn} cuts with the spindle stopped.`, m);
      if (cutting && tool?.spindle && m.spindle !== 'off') {
        const want = tool.spindle === 'M03' ? 'cw' : 'ccw';
        if (m.spindle !== want)
          add(
            'warning',
            'spindle-direction',
            `${tn} cuts with ${m.spindle === 'cw' ? 'M03' : 'M04'}; the tool needs ${tool.spindle}.`,
            m,
          );
      }
      if (cutting && g.wedge && m.kind === 'feed') {
        const ang = angleOf(d);
        const back = angleOf([-d[0], -d[1]]);
        if (insideWedge(ang, g.wedge, RUB_MARGIN) || insideWedge(back, g.wedge, RUB_MARGIN))
          add(
            'error',
            'insert-rubbing',
            `${tn}: the back of the insert rubs the part on this move (too steep for the insert).`,
            m,
          );
      }
      if (cutting && role === 'bore' && tool?.minBore && 2 * Math.abs(b[1]) < tool.minBore - 1e-6)
        add(
          'error',
          'bar-too-big',
          `${tn} boring bar needs a Ø${tool.minBore} bore; cutting at Ø${(2 * Math.abs(b[1])).toFixed(2)}.`,
          m,
        );
    }
    if (r.droppedArea > MIN_AREA && cutting && !partedSeenThisMove(before, mat.partedAt))
      add('error', 'cut-after-partoff', `${tn} cuts where the part was, after it was cut off.`, m);
  }
  const final = mat.snapshot();

  // ---------------------------------------------------- compare with the drawing
  let compare: SimResult['compare'] = null;
  if (input.drawing) {
    compare = compareDrawing(mat, input.drawing, faceZ, (sev, code, msg) => add(sev, code, msg, null));
  } else {
    add('warning', 'input-unknown', 'Drawing profile: unknown (final shape not compared).', null);
  }

  // ---------------------------------------------------- operations
  const ops: OpGroup[] = [];
  for (const m of moves) {
    const last = ops[ops.length - 1];
    if (last && last.op === m.op && last.tool === m.tool) {
      last.lastMove = m.index;
      if (m.realTime === null && m.known && m.kind !== 'index') last.partial = true;
      last.time += m.realTime ?? 0;
    } else {
      ops.push({
        op: m.op,
        tool: m.tool,
        firstMove: m.index,
        lastMove: m.index,
        line: m.line,
        time: m.realTime ?? 0,
        partial: m.realTime === null && m.known && m.kind !== 'index',
      });
    }
  }

  // Program-level notes from the interpreter: times from their move.
  for (const c of progChecks) {
    const mv = c.move !== null ? moves[Math.min(c.move, moves.length - 1)] : undefined;
    checks.push({ ...c, time: mv ? mv.t0 : null, move: mv ? mv.index : null });
  }
  checks.sort((x, y) =>
    x.severity === y.severity ? (x.time ?? -1) - (y.time ?? -1) : x.severity === 'error' ? -1 : 1,
  );

  return {
    moves,
    lines,
    checks,
    ops,
    duration: t,
    realTime: real,
    realTimePartial: partial,
    grid: { zMin: mat.zMin, zMax: mat.zMin + mat.n * res, res, barR, faceZ, chuckZ },
    snapshots,
    final,
    compare,
    unknowns,
    blocked: checks.some((c) => c.severity === 'error'),
  };
}

/** The part-off move itself may graze the falling part: that is not "cutting after part-off". */
function partedSeenThisMove(before: number | null, after: number | null): boolean {
  return before === null && after !== null;
}

/** Colour the final part against the drawing: 1 OK, 2 too deep, 3 excess, 0 not compared. */
export function compareDrawing(
  mat: Stock,
  dwg: NonNullable<SimInput['drawing']>,
  faceZ: number,
  report: (sev: Severity, code: CheckCode, msg: string) => void,
): NonNullable<SimResult['compare']> {
  const state = new Uint8Array(mat.n);
  const innerState = new Uint8Array(mat.n);
  const near = (z: number, a: number, b: number, skipFront: number) =>
    z > a - skipFront - SHOULDER_SKIP || z < b + SHOULDER_SKIP;
  const runs: { kind: 'deep' | 'excess'; where: string; z0: number; z1: number; dev: number; dia: number }[] =
    [];
  const lastOf: Record<string, (typeof runs)[number] | undefined> = {};
  const note = (kind: 'deep' | 'excess', where: string, z: number, dev: number, dia: number) => {
    const side = /bore|hole|centre/.test(where) ? 'in' : 'out';
    const last = lastOf[side];
    if (
      last &&
      last.kind === kind &&
      last.where === where &&
      Math.abs(last.dia - dia) < 1e-6 &&
      z - last.z1 < mat.res * 1.5
    ) {
      last.z1 = z;
      last.dev = Math.max(last.dev, dev);
    } else {
      const run = { kind, where, z0: z, z1: z, dev, dia };
      runs.push(run);
      lastOf[side] = run;
    }
  };
  const threads = dwg.threads ?? [];
  const grooves = dwg.grooves ?? [];
  for (let i = 0; i < mat.n; i++) {
    const z = mat.zOf(i);
    if (z > 0 || z < -dwg.length) {
      // In front of the finished face: should be faced away.
      if (z > 0 && z <= faceZ && mat.has(i) && mat.zOf(i) > mat.res) {
        state[i] = 3;
        note('excess', 'front face', z, z, 0);
      }
      continue;
    }
    if (!mat.has(i)) {
      // Nothing left where the drawing has material.
      const step = dwg.od.find((s) => z <= s.z_front && z >= s.z_back);
      if (step && !near(z, s0(step), step.z_back, step.corner ?? 0)) {
        state[i] = 2;
        note('deep', 'OD', z, step.dia / 2, step.dia);
      }
      continue;
    }
    const o = mat.outer[i];
    const inn = mat.inner[i];
    // Outside.
    const step = dwg.od.find((s) => z <= s.z_front && z >= s.z_back);
    const groove = grooves.find((g) => z <= g.z_front && z >= g.z_back);
    const thread = threads.find((th) => z <= th.z_front && z >= th.z_back);
    if (step && !near(z, s0(step), step.z_back, step.corner ?? 0)) {
      let want = step.dia / 2;
      let where = `OD Ø${step.dia}`;
      if (groove) {
        if (z > groove.z_front - SHOULDER_SKIP || z < groove.z_back + SHOULDER_SKIP) want = NaN;
        else {
          want = groove.dia / 2;
          where = `groove Ø${groove.dia}`;
        }
      } else if (thread) {
        want = thread.major / 2;
        where = `thread Ø${thread.major}`;
      }
      if (Number.isFinite(want)) {
        if (o < want - COMPARE_TOL) {
          state[i] = 2;
          note('deep', where, z, want - o, want * 2);
        } else if (o > want + COMPARE_TOL) {
          state[i] = 3;
          note('excess', where, z, o - want, want * 2);
        } else state[i] = 1;
      }
    }
    // Inside.
    const bore = dwg.bores.find((s) => z <= s.z_front && z >= s.z_back);
    let wantIn = 0;
    let whereIn = '';
    let skip = false;
    if (bore) {
      wantIn = bore.dia / 2;
      whereIn = `bore Ø${bore.dia}`;
      skip = near(z, s0(bore), bore.z_back, bore.corner ?? 0);
    } else if (dwg.drill && z >= -dwg.drill.depth) {
      wantIn = dwg.drill.dia / 2;
      whereIn = `drilled hole Ø${dwg.drill.dia}`;
      skip = z < -dwg.drill.depth + dwg.drill.dia / 2 / Math.tan((59 * Math.PI) / 180) + SHOULDER_SKIP;
    }
    if (!skip) {
      if (inn > wantIn + COMPARE_TOL) {
        innerState[i] = 2;
        note('deep', whereIn || 'centre', z, inn - wantIn, wantIn * 2);
      } else if (inn < wantIn - COMPARE_TOL) {
        innerState[i] = 3;
        note('excess', whereIn, z, wantIn - inn, wantIn * 2);
      } else innerState[i] = 1;
    }
  }
  let deep = 0;
  let excess = 0;
  for (const r of runs.filter((x) => x.z1 - x.z0 >= mat.res * 1.5 || x.dev > 0.1)) {
    const span = `Z${fmtZ(r.z1)} to Z${fmtZ(r.z0)}`;
    if (r.kind === 'deep') {
      deep++;
      report(
        'error',
        'undersize',
        `${r.where} cut below drawing size by up to ${r.dev.toFixed(3)} mm (${span}).`,
      );
    } else {
      excess++;
      report(
        'warning',
        'oversize',
        `${r.where}: material left over drawing size, up to ${r.dev.toFixed(3)} mm (${span}).`,
      );
    }
  }
  const summary =
    deep || excess
      ? `${deep} area(s) too deep, ${excess} area(s) with material left.`
      : 'Final shape matches the drawing (corners and shoulders within 1 mm not compared).';
  return { state, inner: innerState, summary };
}

/** Front Z of a step (for the corner skip). */
function s0(s: { z_front: number }): number {
  return s.z_front;
}

/** Material state before move `index` at fraction `f` of it, from the nearest snapshot. */
export function materialAt(
  result: SimResult,
  input: SimInput,
  index: number,
  f: number,
  into?: Stock,
): Stock {
  const g = result.grid;
  const mat = into ?? new Stock(g.zMin, g.zMax, g.res, g.barR, g.faceZ);
  let snap = result.snapshots[0];
  for (const s of result.snapshots) if (s.at <= index) snap = s;
  if (snap) mat.restore(snap.state);
  const stepper = makeStepper(input);
  for (let i = snap ? snap.at : 0; i < index && i < result.moves.length; i++)
    stepper(mat, result.moves[i], 1);
  if (f > 0 && index < result.moves.length) stepper(mat, result.moves[index], f);
  return mat;
}

/** Apply (part of) one move to the material: the same removal as the full run, for playback. */
export function makeStepper(input: SimInput) {
  const toolMap = new Map<number, SimTool>();
  for (const t of input.tools) toolMap.set(t.number, t);
  const geoms = new Map<number, ToolGeometry>();
  let lastDir: Point | null = null;
  return (mat: Stock, m: SimMove, f: number, from = 0) => {
    if (!m.known || m.kind === 'dwell' || m.kind === 'index' || f <= from) return 0;
    const tool = m.tool !== null ? toolMap.get(m.tool) : undefined;
    const key = m.tool ?? -1;
    if (!geoms.has(key)) geoms.set(key, toolGeometry(tool));
    const g = geoms.get(key) as ToolGeometry;
    const d: Point = [m.to[0] - m.from[0], m.to[1] - m.from[1]];
    if (Math.hypot(d[0], d[1]) > 1e-9) lastDir = d;
    const p0: Point = [m.from[0] + d[0] * from, m.from[1] + d[1] * from];
    const p1: Point = [m.from[0] + d[0] * f, m.from[1] + d[1] * f];
    const a = placeTip(p0, lastDir, m.comp, g);
    const b = placeTip(p1, lastDir, m.comp, g);
    return mat.cut(
      sweep(g.insert, a, b),
      cutMode(tool),
      OP_TAG[m.op],
      m.kind === 'thread' ? (m.pitch ?? m.feedRev ?? 0) : 0,
    ).area;
  };
}

/** Tool tip position (imaginary tip) and placed insert/holder outlines at a programmed point. */
export function toolOutline(tool: SimTool | undefined, p: Point, d: Point | null, comp: 40 | 41 | 42) {
  const g = toolGeometry(tool);
  const tip = placeTip(p, d, comp, g);
  return {
    tip,
    insert: translate(g.insert, tip),
    holder: g.holder.map((h) => translate(h, tip)),
    geometry: g,
  };
}

export { spanAt, radial };
