/**
 * The part as the feature table describes it: process plan rows (OP10 front side, OP20 after
 * "Turn part around"), the characteristics list (every dimension with its tolerance and the
 * size the program cuts) and a turned outline for the 3D preview.
 *
 * Mirrors the program generator's rules (server/app/gcode/generator.py): Z0 is each clamping's
 * finished face, OD steps are listed from that face with their own lengths, bores largest first
 * with depths from the face, a chamfer / radius / cone sits on the front corner of the OD or bore
 * after it, and a toleranced size is cut in the middle of its tolerance band.
 */
import type { Cell, FeatureTableData } from '../api/types';

export type Op = 'OP10' | 'OP20';

export interface PlanRow {
  id: string; // F1, F2…
  feature: number; // row in the table (1-based)
  type: string; // od, bore…
  typeLabel: string;
  nominal: string;
  tol: string | null;
  zFrom: number | null;
  zTo: number | null;
  length: number | null;
}

export interface Characteristic {
  no: number;
  tag: string; // D1, D2…
  label: string; // "Ø27.00", "8.00", "1.0×45°"
  what: string; // "OD 1 diameter"
  op: Op;
  feature: number;
  nominal: number;
  upper: number | null; // tolerance, e.g. +0.000
  lower: number | null; // tolerance, e.g. -0.050
  /** The size the program cuts (middle of the tolerance band), for sizes the program writes. */
  programmed: number | null;
  /** Diameter the program writes as an X word (looked up in the program text). */
  xWord: boolean;
}

export interface PartModel {
  length: number | null;
  maxDia: number | null;
  bar: number | null;
  material: string | null;
  op10: PlanRow[];
  op20: PlanRow[];
  chars: Characteristic[];
  /** Outer and inner outline in part coordinates: p from 0 (front face) to length, r = radius. */
  outer: [number, number][];
  inner: [number, number][];
}

const TYPE_LABEL: Record<string, string> = {
  od: 'OD turn',
  bore: 'Bore',
  face: 'Face',
  chamfer: 'Chamfer',
  radius: 'Radius',
  groove: 'Groove',
  thread: 'Thread',
  drill: 'Drill',
  cone: 'Cone / countersink',
};

const val = (c: Cell | undefined) => (c ? c.value : null);
function num(c: Cell | undefined): number | null {
  const v = val(c);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** Middle of the tolerance band, else the nominal (as the generator cuts it). */
export function midTol(nominal: number, plus: number | null, minus: number | null): number {
  return plus !== null && minus !== null ? r3(nominal + (plus + minus) / 2) : nominal;
}
const f2 = (v: number) => v.toFixed(2);
const tolText = (p: number | null, m: number | null) =>
  p === null && m === null ? null : `${sign(p ?? 0)} / ${sign(m ?? 0)}`;
const sign = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;

export function buildPartModel(data: FeatureTableData | null | undefined): PartModel {
  const h = data?.header ?? {};
  const length = num(h.overall_length);
  const bar = num(h.bar_diameter);
  const mat = val(h.material_grade);
  const out: PartModel = {
    length,
    maxDia: null,
    bar,
    material: typeof mat === 'string' && mat ? mat : null,
    op10: [],
    op20: [],
    chars: [],
    outer: [],
    inner: [],
  };
  const feats = data?.features ?? [];
  const flip = feats.findIndex((f) => f.type === 'flip');
  const sides: { op: Op; from: number; list: typeof feats }[] = [
    { op: 'OP10', from: 0, list: flip >= 0 ? feats.slice(0, flip) : feats },
  ];
  if (flip >= 0) sides.push({ op: 'OP20', from: flip + 1, list: feats.slice(flip + 1) });

  let fId = 0;
  let dNo = 0;
  const addChar = (c: Omit<Characteristic, 'no' | 'tag'>) => {
    dNo++;
    out.chars.push({ ...c, no: dNo, tag: `D${dNo}` });
  };
  if (length !== null)
    addChar({
      label: f2(length),
      what: 'Overall length',
      op: flip >= 0 ? 'OP20' : 'OP10',
      feature: 0,
      nominal: length,
      upper: null,
      lower: null,
      programmed: length,
      xWord: false,
    });

  // turned intervals, part coordinates (p from the front face), for the outline
  const odSpans: { p0: number; p1: number; r: number }[] = [];
  const holeSpans: { p0: number; p1: number; r: number }[] = [];

  for (const side of sides) {
    const rows = side.op === 'OP10' ? out.op10 : out.op20;
    const toPart = (z: number) => (side.op === 'OP10' ? -z : length !== null ? length + z : -z);
    let zOd = 0;
    let boreDepth = 0;
    let pending: { row: PlanRow; axial: number } | null = null;
    // Z of the OD step with a given nominal diameter (for threads)
    const odAt: { nom: number; z: number }[] = [];
    side.list.forEach((f, k) => {
      const n = side.from + k + 1;
      const c = f.fields;
      const tp = num(c.tol_plus);
      const tm = num(c.tol_minus);
      const row: PlanRow = {
        id: `F${++fId}`,
        feature: n,
        type: f.type,
        typeLabel: TYPE_LABEL[f.type] ?? f.type,
        nominal: '',
        tol: tolText(tp, tm),
        zFrom: null,
        zTo: null,
        length: null,
      };
      const place = (z0: number, z1: number) => {
        row.zFrom = r3(z0);
        row.zTo = r3(z1);
        row.length = Math.abs(z1 - z0) > 1e-9 ? r3(Math.abs(z1 - z0)) : null;
        if (pending) {
          pending.row.zFrom = r3(z0);
          pending.row.zTo = r3(z0 - pending.axial);
          pending.row.length = pending.axial || null;
          pending = null;
        }
      };
      if (f.type === 'chamfer') {
        const s = num(c.size);
        const a = num(c.angle);
        row.nominal = s !== null ? `${s} × ${a ?? 45}°` : '';
        if (s !== null)
          addChar({
            label: `${f2(s)}×${a ?? 45}°`,
            what: `Chamfer (row ${n})`,
            op: side.op,
            feature: n,
            nominal: s,
            upper: tp,
            lower: tm,
            programmed: null,
            xWord: false,
          });
        pending = { row, axial: s ?? 0 };
      } else if (f.type === 'radius') {
        const r = num(c.radius);
        row.nominal = r !== null ? `R${r}` : '';
        if (r !== null)
          addChar({
            label: `R${r}`,
            what: `Radius (row ${n})`,
            op: side.op,
            feature: n,
            nominal: r,
            upper: tp,
            lower: tm,
            programmed: null,
            xWord: false,
          });
        pending = { row, axial: r ?? 0 };
      } else if (f.type === 'cone') {
        const d = num(c.diameter);
        const a = num(c.angle);
        row.nominal = d !== null ? `Ø${d} mouth, ${a ?? '?'}° from axis` : '';
        if (d !== null)
          addChar({
            label: `Ø${f2(d)}`,
            what: `Cone mouth (row ${n})`,
            op: side.op,
            feature: n,
            nominal: d,
            upper: tp,
            lower: tm,
            programmed: midTol(d, tp, tm),
            xWord: true,
          });
        if (a !== null)
          addChar({
            label: `${a}°`,
            what: `Cone angle (row ${n})`,
            op: side.op,
            feature: n,
            nominal: a,
            upper: null,
            lower: null,
            programmed: null,
            xWord: false,
          });
        pending = { row, axial: 0 };
      } else if (f.type === 'od') {
        const d = num(c.diameter);
        const ln = num(c.length) ?? 0;
        row.nominal = d !== null ? `Ø${d} × ${ln}` : '';
        place(-zOd, -(zOd + ln));
        if (d !== null) {
          const cut = midTol(d, tp, tm);
          addChar({
            label: `Ø${f2(d)}`,
            what: `OD (row ${n})`,
            op: side.op,
            feature: n,
            nominal: d,
            upper: tp,
            lower: tm,
            programmed: cut,
            xWord: true,
          });
          odAt.push({ nom: d, z: -zOd });
          odSpans.push(span(toPart(-zOd), toPart(-(zOd + ln)), cut / 2));
          out.maxDia = Math.max(out.maxDia ?? 0, d);
        }
        if (ln)
          addChar({
            label: f2(ln),
            what: `OD length (row ${n})`,
            op: side.op,
            feature: n,
            nominal: ln,
            upper: null,
            lower: null,
            programmed: null,
            xWord: false,
          });
        zOd += ln;
      } else if (f.type === 'bore') {
        const d = num(c.diameter);
        const depth = num(c.depth) ?? boreDepth;
        row.nominal = d !== null ? `Ø${d} to depth ${depth}` : '';
        place(-boreDepth, -depth);
        if (d !== null) {
          const cut = midTol(d, tp, tm);
          addChar({
            label: `Ø${f2(d)}`,
            what: `Bore (row ${n})`,
            op: side.op,
            feature: n,
            nominal: d,
            upper: tp,
            lower: tm,
            programmed: cut,
            xWord: true,
          });
          holeSpans.push(span(toPart(-boreDepth), toPart(-depth), cut / 2));
        }
        addChar({
          label: f2(depth),
          what: `Bore depth (row ${n})`,
          op: side.op,
          feature: n,
          nominal: depth,
          upper: null,
          lower: null,
          programmed: null,
          xWord: false,
        });
        boreDepth = depth;
      } else if (f.type === 'drill') {
        const d = num(c.diameter);
        const depth = num(c.depth);
        row.nominal = d !== null ? `Ø${d} drill${depth !== null ? `, depth ${depth}` : ''}` : '';
        place(0, -(depth ?? 0));
        if (d !== null) {
          addChar({
            label: `Ø${f2(d)}`,
            what: `Drill (row ${n})`,
            op: side.op,
            feature: n,
            nominal: d,
            upper: tp,
            lower: tm,
            programmed: null,
            xWord: false,
          });
          if (depth !== null) holeSpans.push(span(toPart(0), toPart(-depth), d / 2));
        }
      } else if (f.type === 'groove') {
        const d = num(c.diameter);
        const w = num(c.width) ?? 0;
        const pos = num(c.position) ?? 0;
        row.nominal = d !== null ? `Ø${d} × ${w} wide` : '';
        place(-pos, -(pos + w));
        if (d !== null) {
          addChar({
            label: `Ø${f2(d)}`,
            what: `Groove (row ${n})`,
            op: side.op,
            feature: n,
            nominal: d,
            upper: tp,
            lower: tm,
            programmed: midTol(d, tp, tm),
            xWord: true,
          });
          odSpans.push(span(toPart(-pos), toPart(-(pos + w)), midTol(d, tp, tm) / 2));
        }
        if (w)
          addChar({
            label: f2(w),
            what: `Groove width (row ${n})`,
            op: side.op,
            feature: n,
            nominal: w,
            upper: null,
            lower: null,
            programmed: null,
            xWord: false,
          });
      } else if (f.type === 'thread') {
        const size = String(val(c.size) ?? '');
        const pitch = num(c.pitch);
        const ln = num(c.length) ?? 0;
        row.nominal = `${size}${pitch ? ` × ${pitch}` : ''}${val(c.tol_class) ? ` ${val(c.tol_class)}` : ''}`;
        const major = Number(size.toUpperCase().match(/M(\d+(?:\.\d+)?)/)?.[1]);
        const at = odAt.find((o) => Math.abs(o.nom - major) < 0.011);
        if (at) place(at.z, at.z - ln);
      } else if (f.type === 'face') {
        const pos = num(c.position) ?? 0;
        row.nominal = pos ? `at ${pos}` : side.op === 'OP10' ? 'front face' : 'back face';
        place(-pos, -pos);
        row.length = null;
      } else return;
      rows.push(row);
    });
  }

  out.outer = outline(odSpans, length, (bar ?? out.maxDia ?? 0) / 2, 'outer');
  out.inner = outline(holeSpans, length, 0, 'inner');
  return out;
}

function span(a: number, b: number, r: number) {
  return { p0: Math.min(a, b), p1: Math.max(a, b), r };
}

/** Stepped outline over the part length: turned spans, gaps at the bar (outer) or axis (inner). */
function outline(
  spans: { p0: number; p1: number; r: number }[],
  length: number | null,
  gap: number,
  side: 'outer' | 'inner',
): [number, number][] {
  const L = length ?? Math.max(0, ...spans.map((s) => s.p1));
  if (!L) return [];
  const cuts = new Set([0, L]);
  for (const s of spans) {
    if (s.p0 > 0 && s.p0 < L) cuts.add(s.p0);
    if (s.p1 > 0 && s.p1 < L) cuts.add(s.p1);
  }
  const ps = [...cuts].sort((a, b) => a - b);
  const pts: [number, number][] = [];
  for (let i = 0; i < ps.length - 1; i++) {
    const mid = (ps[i] + ps[i + 1]) / 2;
    const cover = spans.filter((s) => s.p0 <= mid && s.p1 >= mid);
    let r = gap;
    if (cover.length)
      r = side === 'outer' ? Math.min(...cover.map((s) => s.r)) : Math.max(...cover.map((s) => s.r));
    pts.push([ps[i], r], [ps[i + 1], r]);
  }
  return pts;
}

/** X words of a program (diameters), to show which sizes it really cuts and on which line. */
export function xWords(text: string | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  if (!text) return m;
  text.split(/\r?\n/).forEach((ln, i) => {
    const code = ln.replace(/\([^)]*\)/g, '');
    for (const x of code.matchAll(/X(-?\d*\.?\d+)/gi)) {
      const key = Number(x[1]).toFixed(3);
      if (!m.has(key)) m.set(key, i + 1);
    }
  });
  return m;
}
