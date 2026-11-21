/**
 * FANUC 0i-TF style lathe program interpreter for the 3D simulation (deterministic, no AI).
 *
 * Turns the program into straight moves in the (z, r) plane with real times. Canned cycles
 * (G70/G71/G72/G74/G75/G76, G90/G92/G94, G83) are expanded into the passes the control runs.
 * X is a diameter in the program; moves are stored as radius. Nothing is guessed: a position the
 * program does not give (after G28 with no known home) stays unknown and is shown as a jump.
 */

import type { MoveKind, OpKind, Point, SimCheck, SimMachine, SimMove, SimTool } from './types';

const EPS = 1e-6;
const ARC_STEP_DEG = 6;
/** Animation-only speeds where the real value is unknown (never counted as real time). */
const ANIM_RAPID = 10000; // mm/min
const ANIM_FEED = 150; // mm/min
const ANIM_JUMP = 0.3; // s
const ANIM_INDEX = 0.6; // s

// ------------------------------------------------------------------ blocks

export interface Word {
  letter: string;
  value: number;
  decimal: boolean;
}

export interface Block {
  index: number;
  line: number;
  raw: string;
  words: Word[];
  comment: string;
  seq: number | null;
}

const WORD = /(,?[A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;

export function parseBlocks(text: string): { lines: string[]; blocks: Block[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  lines.forEach((rawLine, k) => {
    let code = '';
    const comments: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of rawLine) {
      if (ch === '(') {
        depth++;
        cur = '';
      } else if (ch === ')' && depth > 0) {
        depth--;
        comments.push(cur.trim());
      } else if (depth > 0) cur += ch;
      else code += ch;
    }
    code = code.replace(/;.*$/, '').toUpperCase().replace(/\s+/g, '');
    if (code.startsWith('/')) code = code.slice(1); // block skip: run as written (switch unknown)
    const words: Word[] = [];
    if (!code.startsWith('%') && !/^O\d/.test(code)) {
      for (const m of code.matchAll(WORD)) {
        words.push({ letter: m[1], value: Number(m[2]), decimal: m[2].includes('.') });
      }
    }
    const n = words.find((w) => w.letter === 'N');
    blocks.push({
      index: blocks.length,
      line: k + 1,
      raw: rawLine,
      words,
      comment: comments.join(' '),
      seq: n ? Math.round(n.value) : null,
    });
  });
  return { lines, blocks };
}

const get = (b: Block, l: string): Word | undefined => b.words.find((w) => w.letter === l);
const num = (b: Block, l: string): number | null => get(b, l)?.value ?? null;
const has = (b: Block, l: string): boolean => b.words.some((w) => w.letter === l);
const gCodes = (b: Block): number[] => b.words.filter((w) => w.letter === 'G').map((w) => w.value);
const mCodes = (b: Block): number[] =>
  b.words.filter((w) => w.letter === 'M').map((w) => Math.round(w.value));
/** Cycle depths (P/Q) without a decimal point are in microns on FANUC. */
const micro = (b: Block, l: string): number | null => {
  const w = get(b, l);
  if (!w) return null;
  return w.decimal ? w.value : w.value / 1000;
};
const hasMove = (b: Block): boolean => has(b, 'X') || has(b, 'Z') || has(b, 'U') || has(b, 'W');

// ------------------------------------------------------------------ geometry helpers

export function arcCentre(s: Point, e: Point, radius: number, clockwise: boolean): Point | null {
  const [z1, r1] = s;
  const [z2, r2] = e;
  const dz = z2 - z1;
  const dr = r2 - r1;
  const chord = Math.hypot(dz, dr);
  const rad = Math.abs(radius);
  if (chord < EPS || chord > 2 * rad + 1e-4) return null;
  const h = Math.sqrt(Math.max(rad * rad - (chord / 2) ** 2, 0));
  const mz = (z1 + z2) / 2;
  const mr = (r1 + r2) / 2;
  const nz = -dr / chord;
  const nr = dz / chord;
  let sign = clockwise ? -1 : 1;
  if (radius < 0) sign = -sign;
  return [mz + sign * h * nz, mr + sign * h * nr];
}

export function arcPoints(s: Point, e: Point, c: Point, clockwise: boolean): Point[] {
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
  let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
  const rad = Math.hypot(s[0] - c[0], s[1] - c[1]);
  if (clockwise) while (a1 > a0 - EPS) a1 -= 2 * Math.PI;
  else while (a1 < a0 + EPS) a1 += 2 * Math.PI;
  const steps = Math.max(2, Math.floor(Math.abs(((a1 - a0) * 180) / Math.PI) / ARC_STEP_DEG) + 1);
  const pts: Point[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = a0 + ((a1 - a0) * k) / steps;
    pts.push([c[0] + rad * Math.cos(a), c[1] + rad * Math.sin(a)]);
  }
  pts[pts.length - 1] = e;
  return pts;
}

function firstCrossing(prof: Point[], level: number, axis: 0 | 1): number | null {
  const other = axis === 0 ? 1 : 0;
  for (let i = 0; i + 1 < prof.length; i++) {
    const p = prof[i];
    const q = prof[i + 1];
    const a0 = p[axis];
    const a1 = q[axis];
    if ((a0 - level) * (a1 - level) <= 0 && Math.abs(a1 - a0) > EPS) {
      const t = (level - a0) / (a1 - a0);
      return p[other] + t * (q[other] - p[other]);
    }
    if (Math.abs(a0 - level) < EPS) return p[other];
  }
  return null;
}

// ------------------------------------------------------------------ interpreter

export interface Interpreted {
  lines: string[];
  moves: SimMove[];
  checks: SimCheck[];
  /** Tool numbers in the order they were first called. */
  toolsUsed: number[];
  /** Name of each tool from the program comment at its first call, e.g. N1(16.5 DRILL). */
  toolLabels: Record<number, string>;
}

interface State {
  x: number | null; // diameter
  z: number | null;
  motion: number;
  feedMode: 98 | 99;
  f: number | null;
  css: boolean;
  s: number | null; // rpm (G97) or Vc (G96)
  g50: number | null;
  spindle: 'cw' | 'ccw' | 'off';
  coolant: boolean;
  tool: number | null;
  comp: 40 | 41 | 42;
  drill83: boolean;
}

type ToolLookup = (n: number) => SimTool | undefined;

/** True when a block ends a program section (M30 / M02, or M99 without a jump target). */
function endsSection(b: Block): boolean {
  const ms = mCodes(b);
  return ms.includes(30) || ms.includes(2) || (ms.includes(99) && !has(b, 'P'));
}

export interface Section {
  index: number;
  /** 1-based first line of the section. */
  line: number;
  label: string;
}

/** Sections of a multi-operation file (one per clamping), split at M30 / M02. Only sections
 * that move the tool are listed. */
export function listSections(text: string): Section[] {
  const { blocks } = parseBlocks(text);
  const out: Section[] = [];
  let index = 0;
  let start: Block | null = null;
  let label = '';
  let moves = false;
  const flush = () => {
    if (start && moves) out.push({ index, line: start.line, label: label || `Operation ${index + 1}` });
  };
  for (const b of blocks) {
    if (!start && (b.words.length || b.comment)) start = b;
    if (!label && b.comment && !/^O\d/.test(b.raw.trim()) && (b.seq !== null || !b.words.length))
      label = b.comment;
    if (hasMove(b)) moves = true;
    if (endsSection(b)) {
      flush();
      index++;
      start = null;
      label = '';
      moves = false;
    }
  }
  flush();
  return out;
}

export function interpret(text: string, machine: SimMachine, section = 0): Interpreted {
  const { lines, blocks } = parseBlocks(text);
  const moves: SimMove[] = [];
  const checks: SimCheck[] = [];
  const toolsUsed: number[] = [];
  const toolLabels: Record<number, string> = {};
  let pendingLabel = '';
  let curLabel = '';
  const st: State = {
    x: null,
    z: null,
    motion: 0,
    feedMode: 99,
    f: null,
    css: false,
    s: null,
    g50: null,
    spindle: 'off',
    coolant: false,
    tool: null,
    comp: 40,
    drill83: false,
  };
  let cur: Block = blocks[0];
  let cycleName = '';
  let g96Warned = false;
  let rough: { d: number; e: number } = { d: 1, e: 0.5 };
  let roughSeen = false;
  let g74e = 0.5;
  let g75e = 0.5;
  let g76: { m: number; a: number; qmin: number; fin: number } = { m: 1, a: 60, qmin: 0, fin: 0 };
  /** Blocks consumed by a G71/G72 profile: not run again in the main flow. */
  const skip = new Set<number>();

  const note = (severity: 'error' | 'warning', code: SimCheck['code'], message: string) => {
    if (checks.some((c) => c.code === code && c.line === cur.line && c.message === message)) return;
    checks.push({ severity, code, message, line: cur.line, move: moves.length, time: null });
  };

  const known = () => st.x !== null && st.z !== null;
  const point = (): Point => [st.z as number, (st.x as number) / 2];

  const capRpm = (): number => Math.min(st.g50 ?? Infinity, machine.maxRpm ?? Infinity);
  const rpmAt = (r: number): number | null => {
    if (st.spindle === 'off' || st.s === null) return st.spindle === 'off' ? 0 : null;
    if (!st.css) return Math.min(st.s, machine.maxRpm ?? Infinity);
    const d = Math.max(Math.abs(2 * r), 0.01);
    const rpm = Math.min((1000 * st.s) / (Math.PI * d), capRpm());
    return Number.isFinite(rpm) ? rpm : null;
  };

  function emit(kind: MoveKind, from: Point | null, to: Point, cycle?: string, pitch?: number) {
    const tool = st.tool;
    const z0 = from ?? to;
    const len = from ? Math.hypot(to[0] - from[0], to[1] - from[1]) : 0;
    let realTime: number | null = null;
    let anim = 0;
    let feedRev: number | null = null;
    let feedMin: number | null = null;
    const rpm0 = rpmAt(z0[1]);
    if (!from) {
      anim = ANIM_JUMP;
    } else if (kind === 'rapid') {
      const axis = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
      realTime = machine.rapidRate ? axis / (machine.rapidRate / 60) : null;
      anim = realTime ?? axis / (ANIM_RAPID / 60);
    } else if (kind === 'feed' || kind === 'thread') {
      const perRev = kind === 'thread' ? (pitch ?? st.f) : st.feedMode === 99 ? st.f : null;
      feedRev = perRev;
      if (kind !== 'thread' && st.feedMode === 98) feedMin = st.f;
      else if (perRev !== null && rpm0) feedMin = perRev * rpm0;
      // Integrate along the move: under G96 the spindle speed changes with the diameter.
      const n = st.css && Math.abs(to[1] - from[1]) > EPS ? 24 : 1;
      let t = 0;
      let ok = true;
      for (let k = 0; k < n; k++) {
        const r = from[1] + ((to[1] - from[1]) * (k + 0.5)) / n;
        const rpm = rpmAt(r);
        const fpm =
          kind !== 'thread' && st.feedMode === 98 ? st.f : perRev !== null && rpm ? perRev * rpm : null;
        if (!fpm || fpm <= 0) {
          ok = false;
          break;
        }
        t += len / n / (fpm / 60);
      }
      realTime = ok ? t : null;
      anim = realTime ?? len / (ANIM_FEED / 60);
    }
    const rpm = rpm0;
    moves.push({
      index: moves.length,
      line: cur.line,
      kind,
      from: from ?? to,
      to,
      known: from !== null,
      tool,
      op: 'Other',
      cycle: cycle ?? cycleName,
      feedRev,
      feedMin,
      rpm,
      vc: rpm ? (Math.PI * Math.abs(2 * z0[1]) * rpm) / 1000 : null,
      css: st.css,
      spindle: st.spindle,
      coolant: st.coolant,
      comp: st.comp,
      pitch,
      label: pendingLabel || curLabel,
      realTime,
      t0: 0,
      t1: anim,
    });
  }

  function emitTimed(kind: 'dwell' | 'index', seconds: number | null, animFallback: number, cycle: string) {
    const p: Point | null = known() ? point() : null;
    const at: Point = p ?? [NaN, NaN];
    moves.push({
      index: moves.length,
      line: cur.line,
      kind,
      from: at,
      to: at,
      known: p !== null,
      tool: st.tool,
      op: 'Other',
      cycle,
      feedRev: null,
      feedMin: null,
      rpm: rpmAt(p ? p[1] : 0),
      vc: null,
      css: st.css,
      spindle: st.spindle,
      coolant: st.coolant,
      comp: st.comp,
      label: pendingLabel || curLabel,
      realTime: seconds,
      t0: 0,
      t1: seconds ?? animFallback,
    });
  }

  /** Straight move to absolute (x diameter, z). */
  function moveTo(x: number | null, z: number | null, kind: MoveKind, cycle?: string, pitch?: number) {
    const start = known() ? point() : null;
    if (x !== null) st.x = x;
    if (z !== null) st.z = z;
    if (!known()) return;
    const end = point();
    if (start && Math.abs(start[0] - end[0]) < EPS && Math.abs(start[1] - end[1]) < EPS) return;
    emit(kind, start, end, cycle, pitch);
  }

  function target(b: Block): [number | null, number | null] {
    let x = num(b, 'X');
    let z = num(b, 'Z');
    const u = num(b, 'U');
    const w = num(b, 'W');
    if (u !== null) {
      if (st.x === null) note('warning', 'program', 'U move from an unknown X position: shown as a jump.');
      else x = st.x + u;
    }
    if (w !== null) {
      if (st.z === null) note('warning', 'program', 'W move from an unknown Z position: shown as a jump.');
      else z = st.z + w;
    }
    // A-angle (direct drawing dimension input) on G01 with one end coordinate.
    const a = num(b, 'A');
    if (a !== null && known() && st.motion === 1) {
      const rad = (a * Math.PI) / 180;
      const dz = Math.cos(rad);
      const dr = Math.sin(rad);
      if (x !== null && z === null && Math.abs(dr) > EPS)
        z = (st.z as number) + (((x - (st.x as number)) / 2) * dz) / dr;
      else if (z !== null && x === null && Math.abs(dz) > EPS)
        x = (st.x as number) + 2 * (((z - (st.z as number)) * dr) / dz);
    }
    return [x, z];
  }

  function arc(b: Block, x: number | null, z: number | null, clockwise: boolean, kind: MoveKind = 'feed') {
    if (!known()) {
      moveTo(x, z, kind);
      return;
    }
    const s = point();
    const ex = x ?? (st.x as number);
    const ez = z ?? (st.z as number);
    const e: Point = [ez, ex / 2];
    const rw = num(b, 'R');
    const iw = num(b, 'I');
    const kw = num(b, 'K');
    let c: Point | null = null;
    if (iw !== null || kw !== null) c = [s[0] + (kw ?? 0), s[1] + (iw ?? 0)];
    else if (rw !== null) c = arcCentre(s, e, rw, clockwise);
    if (!c) {
      note('warning', 'program', 'Arc without a valid R or I/K: drawn as a straight line.');
      moveTo(ex, ez, kind);
      return;
    }
    const pts = arcPoints(s, e, c, clockwise);
    const name = clockwise ? 'G02' : 'G03';
    for (let k = 1; k < pts.length; k++) emit(kind, pts[k - 1], pts[k], cycleName || name);
    st.x = ex;
    st.z = ez;
  }

  function motion(b: Block) {
    const [x, z] = target(b);
    const m = st.motion;
    if (m === 0) moveTo(x, z, 'rapid', cycleName || 'G00');
    else if (m === 1) moveTo(x, z, 'feed', cycleName || 'G01');
    else if (m === 32) {
      const lead = num(b, 'F') ?? st.f ?? undefined;
      moveTo(x, z, 'thread', 'G32 thread', lead);
    } else if (m === 2 || m === 3) {
      const save = cycleName;
      cycleName = save || (m === 2 ? 'G02' : 'G03');
      arc(b, x, z, m === 2);
      cycleName = save;
    } else if (m === 90 || m === 92 || m === 94) box(b, x, z, m);
  }

  // -------------------------------------------------- single cycles

  function box(b: Block, x: number | null, z: number | null, g: number) {
    if (!known() || x === null || z === null) {
      note('warning', 'program', `G${g} cycle from an unknown position was not run.`);
      return;
    }
    const x0 = st.x as number;
    const z0 = st.z as number;
    if (g === 94) {
      const name = 'G94 face';
      moveTo(null, z, 'rapid', name);
      moveTo(x, null, 'feed', name);
      moveTo(null, z0, 'feed', name);
      moveTo(x0, null, 'rapid', name);
    } else {
      const thread = g === 92;
      const name = thread ? 'G92 thread' : 'G90 turn';
      const lead = thread ? (num(b, 'F') ?? st.f ?? undefined) : undefined;
      moveTo(x, null, 'rapid', name);
      moveTo(null, z, thread ? 'thread' : 'feed', name, lead);
      moveTo(x0, null, thread ? 'rapid' : 'feed', name);
      moveTo(null, z0, 'rapid', name);
    }
  }

  function peck(zTarget: number, step: number | null, retract: number, name: string) {
    const z0 = st.z as number;
    if (step === null || step <= EPS) moveTo(null, zTarget, 'feed', name);
    else {
      let depth = z0;
      let guard = 0;
      while (depth - step > zTarget + EPS && guard++ < 2000) {
        depth -= step;
        moveTo(null, depth, 'feed', name);
        moveTo(null, depth + retract, 'rapid', name);
        moveTo(null, depth, 'rapid', name);
      }
      moveTo(null, zTarget, 'feed', name);
    }
    moveTo(null, z0, 'rapid', name);
  }

  function g74(b: Block) {
    if (!has(b, 'Z') && !has(b, 'W')) {
      g74e = num(b, 'R') ?? g74e;
      return;
    }
    if (!known()) {
      note('warning', 'program', 'G74 from an unknown position was not run.');
      return;
    }
    const [x, z] = target(b);
    const x0 = st.x as number;
    const name = 'G74 peck';
    const di = micro(b, 'P');
    const xs: number[] = [x0];
    if (x !== null && Math.abs(x - x0) > EPS && di && di > EPS) {
      const dir = x < x0 ? -1 : 1;
      let xx = x0;
      while ((x - xx) * dir > EPS && xs.length < 500) {
        xx = (x - xx) * dir > 2 * di ? xx + dir * 2 * di : x;
        xs.push(xx);
      }
    }
    for (const xx of xs) {
      moveTo(xx, null, 'rapid', name);
      peck(z as number, micro(b, 'Q'), g74e, name);
    }
    moveTo(x0, null, 'rapid', name);
  }

  function g75(b: Block) {
    if (!has(b, 'X') && !has(b, 'U')) {
      g75e = num(b, 'R') ?? g75e;
      return;
    }
    if (!known()) {
      note('warning', 'program', 'G75 from an unknown position was not run.');
      return;
    }
    const [x, z] = target(b);
    const x0 = st.x as number;
    const z0 = st.z as number;
    const xT = x as number;
    const zT = z ?? z0;
    const di = micro(b, 'P'); // radial peck (radius)
    const dk = micro(b, 'Q'); // Z shift
    const name = 'G75 groove';
    const zs: number[] = [z0];
    if (Math.abs(zT - z0) > EPS) {
      const dir = zT < z0 ? -1 : 1;
      const stepZ = dk && dk > EPS ? dk : Math.abs(zT - z0);
      let zz = z0;
      while ((zT - zz) * dir > EPS && zs.length < 1000) {
        zz = (zT - zz) * dir > stepZ + EPS ? zz + dir * stepZ : zT;
        zs.push(zz);
      }
    }
    for (const zz of zs) {
      moveTo(null, zz, 'rapid', name);
      const dirX = xT < x0 ? -1 : 1;
      if (di && di > EPS) {
        let xx = x0;
        let guard = 0;
        while ((xT - xx) * dirX > 2 * di + EPS && guard++ < 2000) {
          xx += dirX * 2 * di;
          moveTo(xx, null, 'feed', name);
          moveTo(xx - dirX * 2 * g75e, null, 'rapid', name);
          moveTo(xx, null, 'rapid', name);
        }
      }
      moveTo(xT, null, 'feed', name);
      moveTo(x0, null, 'rapid', name);
    }
    moveTo(null, z0, 'rapid', name);
  }

  function g83(b: Block) {
    if (!known()) {
      note('warning', 'program', 'G83 from an unknown position was not run.');
      return;
    }
    const [x, z] = target(b);
    if (x !== null) moveTo(x, null, 'rapid', 'G83 peck');
    if (z === null) return;
    peck(z, micro(b, 'Q'), 1, 'G83 peck');
    note('warning', 'program', 'G83 run from the start point; the R point depends on machine parameters.');
  }

  function g76run(b: Block) {
    if (!has(b, 'X') && !has(b, 'U')) {
      const p = get(b, 'P');
      if (p) {
        const digits = String(Math.round(p.value)).padStart(6, '0');
        g76 = { ...g76, m: Number(digits.slice(0, 2)) || 1, a: Number(digits.slice(4, 6)) };
      }
      const q = micro(b, 'Q');
      if (q !== null) g76.qmin = q;
      const r = num(b, 'R');
      if (r !== null) g76.fin = r;
      return;
    }
    if (!known()) {
      note('warning', 'program', 'G76 from an unknown position was not run.');
      return;
    }
    const [x, z] = target(b);
    const k = micro(b, 'P');
    const dd = micro(b, 'Q');
    const lead = num(b, 'F') ?? st.f;
    if (x === null || z === null || !k || !dd || !lead) {
      note('warning', 'program', 'G76 needs X, Z, P (height), Q (first depth) and F (lead): not run.');
      return;
    }
    const x0 = st.x as number;
    const z0 = st.z as number;
    const outside = x0 > x;
    const sgn = outside ? 1 : -1;
    const name = 'G76 thread';
    const roughDepth = Math.max(k - g76.fin, 0);
    const depths: number[] = [];
    let n = 1;
    let prev = 0;
    while (depths.length < 300) {
      let d = dd * Math.sqrt(n);
      if (d - prev < g76.qmin) d = prev + g76.qmin;
      if (d >= roughDepth - EPS) break;
      depths.push(d);
      prev = d;
      n++;
    }
    depths.push(roughDepth);
    for (let i = 0; i < g76.m; i++) depths.push(k);
    for (const d of depths) {
      moveTo(x + sgn * 2 * (k - d), null, 'rapid', name);
      moveTo(null, z, 'thread', name, lead);
      moveTo(x0, null, 'rapid', name);
      moveTo(null, z0, 'rapid', name);
    }
  }

  // -------------------------------------------------- G70 / G71 / G72

  const findSeq = (from: number, seq: number): number | null => {
    for (let j = from; j < blocks.length; j++) if (blocks[j].seq === seq) return j;
    return null;
  };

  /** Run the P..Q blocks on a scratch state: the finish profile from `start`. */
  function profile(iNs: number, iNf: number, start: Point): { pts: Point[]; feeds: (number | null)[] } {
    const save = { ...st };
    const saveCur = cur;
    const n0 = moves.length;
    const saveChecks = checks.length;
    st.x = start[1] * 2;
    st.z = start[0];
    const feeds: (number | null)[] = [];
    for (let j = iNs; j <= iNf; j++) {
      const blk = blocks[j];
      cur = blk;
      for (const g of gCodes(blk)) if ([0, 1, 2, 3].includes(g)) st.motion = g;
      const f = num(blk, 'F');
      if (f !== null) st.f = f;
      const before = moves.length;
      if (hasMove(blk)) motion(blk);
      for (let k = before; k < moves.length; k++) feeds.push(f ?? null);
    }
    const pts: Point[] = [start, ...moves.slice(n0).map((m) => m.to)];
    moves.length = n0;
    checks.length = saveChecks;
    Object.assign(st, save);
    cur = saveCur;
    return { pts, feeds };
  }

  function finishCycle(i: number) {
    const b = blocks[i];
    const p = num(b, 'P');
    const q = num(b, 'Q');
    if (p === null || q === null || !known()) {
      note('warning', 'program', 'G70 needs P, Q and a known start: not run.');
      return;
    }
    const iNs = findSeq(0, Math.round(p));
    const iNf = findSeq(0, Math.round(q));
    if (iNs === null || iNf === null || iNf < iNs) {
      note('warning', 'program', `G70 profile N${p}..N${q} not found.`);
      return;
    }
    const start = point();
    const prof = profile(iNs, iNf, start);
    const name = 'G70 finish';
    const saveF = st.f;
    // The P..Q blocks' own G00/G01 and F words apply in G70.
    const kinds = profileKinds(iNs, iNf, start);
    for (let k = 1; k < prof.pts.length; k++) {
      if (prof.feeds[k - 1] !== null) st.f = prof.feeds[k - 1];
      emit(kinds[k - 1] ?? 'feed', prof.pts[k - 1], prof.pts[k], name);
    }
    st.f = saveF;
    const end = prof.pts[prof.pts.length - 1];
    st.z = end[0];
    st.x = end[1] * 2;
    moveTo(start[1] * 2, start[0], 'rapid', name);
  }

  /** Rapid or feed for each profile move (the profile's own G00/G01). */
  function profileKinds(iNs: number, iNf: number, start: Point): MoveKind[] {
    const save = { ...st };
    const saveCur = cur;
    const n0 = moves.length;
    const saveChecks = checks.length;
    st.x = start[1] * 2;
    st.z = start[0];
    for (let j = iNs; j <= iNf; j++) {
      const blk = blocks[j];
      cur = blk;
      for (const g of gCodes(blk)) if ([0, 1, 2, 3].includes(g)) st.motion = g;
      if (hasMove(blk)) motion(blk);
    }
    const kinds = moves.slice(n0).map((m) => m.kind);
    moves.length = n0;
    checks.length = saveChecks;
    Object.assign(st, save);
    cur = saveCur;
    return kinds;
  }

  function roughCycle(i: number, g: 71 | 72): void {
    const b = blocks[i];
    if (!has(b, 'P')) {
      const d = g === 71 ? num(b, 'U') : num(b, 'W');
      rough = { d: d ?? rough.d, e: num(b, 'R') ?? rough.e };
      roughSeen = true;
      return;
    }
    if (!roughSeen)
      note('warning', 'program', `G${g} without its first block (depth, retract): FANUC defaults unknown.`);
    const p = Math.round(num(b, 'P') ?? 0);
    const q = Math.round(num(b, 'Q') ?? 0);
    const iNs = findSeq(i + 1, p);
    const iNf = findSeq(i + 1, q);
    if (iNs === null || iNf === null || iNf < iNs) {
      note('warning', 'program', `G${g} profile N${p}..N${q} not found after the cycle block.`);
      return;
    }
    for (let j = iNs; j <= iNf; j++) skip.add(j);
    if (!known()) {
      note('warning', 'program', `G${g} from an unknown start position was not run.`);
      return;
    }
    const f = num(b, 'F');
    if (f !== null) st.f = f;
    const du = num(b, 'U') ?? 0;
    const dw = num(b, 'W') ?? 0;
    const start = point();
    const prof = profile(iNs, iNf, start).pts;
    const shifted: Point[] = prof.map(([z, r]) => [z + dw, r + du / 2]);
    const name = g === 71 ? 'G71 rough' : 'G72 rough';
    const along = g === 71;
    const a: 0 | 1 = along ? 1 : 0;
    const depth = Math.abs(rough.d);
    const retract = rough.e;
    const body = shifted.slice(1);
    const first = body.length ? body[0][a] - start[a] : 0;
    if (depth <= EPS || body.length < 2 || Math.abs(first) < EPS) {
      note('warning', 'program', `G${g} passes could not be worked out; only the contour pass is run.`);
    } else {
      const dir = first < 0 ? -1 : 1;
      const values = body.map((pt) => pt[a]);
      const limit = dir < 0 ? Math.min(...values) : Math.max(...values);
      let level = start[a] + dir * depth;
      let count = 0;
      while ((level - limit) * dir < -EPS && count < 1000) {
        const end = firstCrossing(body, level, a);
        const otherStart = start[1 - a];
        const otherEnd = end ?? body[body.length - 1][1 - a];
        const p1: Point = along ? [otherStart, level] : [level, otherStart];
        const p2: Point = along ? [otherEnd, level] : [level, otherEnd];
        const back: Point = along
          ? [otherEnd + retract, level - dir * retract]
          : [level - dir * retract, otherEnd + retract];
        const ret: Point = along ? [otherStart, back[1]] : [back[0], otherStart];
        moveTo(p1[1] * 2, p1[0], 'rapid', name);
        moveTo(p2[1] * 2, p2[0], 'feed', name);
        moveTo(back[1] * 2, back[0], 'rapid', name);
        moveTo(ret[1] * 2, ret[0], 'rapid', name);
        level += dir * depth;
        count++;
      }
    }
    // Contour pass with the finish allowance, then back to the start point.
    moveTo(body.length ? body[0][1] * 2 : null, body.length ? body[0][0] : null, 'rapid', name);
    for (let k = 1; k < body.length; k++) {
      emit('feed', body[k - 1], body[k], name);
      st.z = body[k][0];
      st.x = body[k][1] * 2;
    }
    moveTo(start[1] * 2, start[0], 'rapid', name);
  }

  // -------------------------------------------------- main loop

  let sectionAt = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (sectionAt < section) {
      if (endsSection(blocks[i])) sectionAt++;
      continue;
    }
    if (skip.has(i)) continue;
    const b = blocks[i];
    cur = b;
    if (!b.words.length) continue;
    const gs = gCodes(b);
    const ms = mCodes(b);
    cycleName = '';

    // Modal codes first.
    for (const g of gs) {
      if (g === 98 || g === 99) st.feedMode = g;
      if (g === 96) st.css = true;
      if (g === 97) st.css = false;
      if (g === 40 || g === 41 || g === 42) st.comp = g;
      if (g === 80) st.drill83 = false;
      if (g === 83) st.drill83 = true;
      if ([0, 1, 2, 3, 32, 90, 92, 94].includes(g)) {
        st.motion = g;
        if (g <= 3) st.drill83 = false;
      }
    }
    const f = num(b, 'F');
    if (f !== null && !gs.includes(76)) st.f = f;
    const s = num(b, 'S');
    if (s !== null) {
      if (gs.includes(50)) st.g50 = s;
      else st.s = s;
    }
    if (st.css && !g96Warned && st.g50 === null && (gs.includes(96) || (s !== null && !gs.includes(50)))) {
      note('warning', 'g96-no-g50', 'G96 constant surface speed without a G50 S max-rpm limit before it.');
      g96Warned = true;
    }
    if (ms.includes(3)) st.spindle = 'cw';
    if (ms.includes(4)) st.spindle = 'ccw';
    if (ms.includes(8)) st.coolant = true;

    if (b.seq !== null && b.comment) pendingLabel = b.comment;
    const t = get(b, 'T');
    if (t) {
      const digits = String(Math.round(t.value));
      const n = digits.length >= 3 ? Number(digits.slice(0, -2)) : Number(digits);
      if (n > 0) curLabel = (b.comment || pendingLabel).trim();
      if (n > 0 && n !== st.tool) {
        st.tool = n;
        if (!toolsUsed.includes(n)) toolsUsed.push(n);
        if (toolLabels[n] === undefined) toolLabels[n] = curLabel;
        emitTimed('index', machine.indexTime ?? null, ANIM_INDEX, `T${String(n).padStart(2, '0')} index`);
      }
    }

    if (gs.includes(4)) {
      const sec = has(b, 'P') ? (num(b, 'P') as number) / 1000 : (num(b, 'X') ?? num(b, 'U') ?? 0);
      emitTimed('dwell', sec, sec, 'G04 dwell');
    } else if (gs.includes(71) || gs.includes(72)) {
      roughCycle(i, gs.includes(71) ? 71 : 72);
    } else if (gs.includes(70)) {
      finishCycle(i);
    } else if (gs.includes(74)) {
      g74(b);
    } else if (gs.includes(75)) {
      g75(b);
    } else if (gs.includes(76)) {
      g76run(b);
    } else if (gs.includes(28) || gs.includes(30)) {
      const g30 = gs.includes(30);
      const home = g30 ? (machine.home30 ?? machine.home) : machine.home;
      const hname = g30 ? 'G30 home' : 'G28 home';
      if (known()) {
        const [x, z] = target(b); // intermediate point (G28 U0 W0 = where it is)
        moveTo(x, z, 'rapid', hname);
      }
      if (home) {
        if (!known()) {
          st.x = home.x;
          st.z = home.z;
          emit('rapid', null, point(), hname);
        } else
          moveTo(
            has(b, 'U') || has(b, 'X') ? home.x : null,
            has(b, 'W') || has(b, 'Z') ? home.z : null,
            'rapid',
            hname,
          );
      } else {
        if (has(b, 'U') || has(b, 'X')) st.x = null;
        if (has(b, 'W') || has(b, 'Z')) st.z = null;
      }
    } else if (gs.includes(50) && (has(b, 'X') || has(b, 'Z'))) {
      note('warning', 'program', 'G50 coordinate setting: position becomes unknown.');
      st.x = st.z = null;
    } else if (st.drill83 && (has(b, 'Z') || has(b, 'W'))) {
      g83(b);
    } else if (hasMove(b)) {
      const wasKnown = known();
      const [x, z] = target(b);
      if (!wasKnown) {
        if (x !== null) st.x = x;
        if (z !== null) st.z = z;
        if (known()) emit('rapid', null, point(), st.motion === 0 ? 'G00' : 'jump');
      } else motion(b);
    }

    if (ms.includes(5)) st.spindle = 'off';
    if (ms.includes(9)) st.coolant = false;
    if (ms.includes(98)) note('warning', 'program', 'M98 sub-program call is not followed.');
    if (ms.includes(99) && has(b, 'P'))
      note(
        'warning',
        'program',
        `M99 P${num(b, 'P')} jump is not followed: every block of this operation is shown.`,
      );
    if (endsSection(b)) break;
  }

  // Positions never known: park the tool clear of the part for display (not a real position).
  const pts = moves.filter((m) => m.known && Number.isFinite(m.to[0])).flatMap((m) => [m.from, m.to]);
  const park: Point = pts.length
    ? [Math.max(...pts.map((p) => p[0])) + 40, Math.max(...pts.map((p) => Math.abs(p[1]))) + 40]
    : [60, 60];
  let last: Point = park;
  for (const m of moves) {
    if (!Number.isFinite(m.to[0])) {
      m.from = last;
      m.to = last;
    } else if (!m.known) {
      m.from = last;
    }
    last = m.to;
  }
  return { lines, moves, checks, toolsUsed, toolLabels };
}

/** Name the operation of each move from the tool and the cycle. Non-cutting moves take the op of
 * the next cutting move of the same tool. */
export function classifyOps(moves: SimMove[], toolOf: ToolLookup): void {
  const cutting = (m: SimMove) => m.kind === 'feed' || m.kind === 'thread';
  for (const m of moves) {
    if (!cutting(m)) continue;
    const tool = m.tool !== null ? toolOf(m.tool) : undefined;
    const role = tool?.role ?? 'unknown';
    const name = (m.label || tool?.name || '').toUpperCase();
    let op: OpKind = 'Other';
    if (role === 'drill') op = 'Drill';
    else if (role === 'part') op = 'Part-off';
    else if (role === 'groove') op = 'Groove';
    else if (role === 'thread' || m.kind === 'thread') op = 'Thread';
    else if (role === 'bore') op = 'Bore';
    else if (role === 'od' || role === 'unknown') {
      const dz = Math.abs(m.to[0] - m.from[0]);
      const dr = Math.abs(m.to[1] - m.from[1]);
      if (m.cycle.startsWith('G94')) op = 'Face';
      else if (m.cycle.startsWith('G70')) op = 'Finish';
      else if (/FAC/.test(name) && !m.cycle.startsWith('G71')) op = 'Face';
      else if (m.cycle.startsWith('G71') || m.cycle.startsWith('G72') || m.cycle.startsWith('G90'))
        op = 'Rough';
      else if (m.cycle.startsWith('G74') || m.cycle.startsWith('G83')) op = 'Drill';
      else if (m.cycle.startsWith('G75')) op = 'Groove';
      else if (dr > 2 * dz && Math.min(m.to[1], m.from[1]) <= 1.5) op = 'Face';
      else if (/FIN/.test(name)) op = 'Finish';
      else op = 'Rough';
    }
    m.op = op;
  }
  // Non-cutting moves: next cutting op of the same tool, else the previous op.
  let next: OpKind | null = null;
  let nextTool: number | null = null;
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i];
    if (cutting(m)) {
      next = m.op;
      nextTool = m.tool;
    } else if (next !== null && nextTool === m.tool) m.op = next;
  }
  let prev: OpKind = 'Other';
  let prevTool: number | null = null;
  for (const m of moves) {
    if (cutting(m) || m.op !== 'Other') {
      prev = m.op;
      prevTool = m.tool;
    } else if (prevTool === m.tool) m.op = prev;
  }
}
