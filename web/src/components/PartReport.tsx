import { Check, CircleAlert, FileSearch, Minus, Sparkles } from 'lucide-react';
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { type Characteristic, type PartModel, type PlanRow, xWords } from '../lib/partModel';
import { cutters, describeSolid } from '../lib/solidCuts';

const PartPreview3D = lazy(() => import('./PartPreview3D'));

/** Two readings within this are the same value written with different rounding. */
const ROUND = 0.005;

const f3 = (v: number | null) => (v === null ? '–' : v.toFixed(3));
const f4 = (v: number | null) => (v === null ? '–' : v.toFixed(4));
const signed = (v: number | null, d = 3) =>
  v === null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

const TYPE_TONE: Record<string, string> = {
  od: 'bg-sky-50 text-sky-800 ring-sky-200',
  taper: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  bore: 'bg-violet-50 text-violet-800 ring-violet-200',
  drill: 'bg-violet-50 text-violet-800 ring-violet-200',
  chamfer: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  radius: 'bg-amber-50 text-amber-800 ring-amber-200',
  cone: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  groove: 'bg-rose-50 text-rose-800 ring-rose-200',
  thread: 'bg-teal-50 text-teal-800 ring-teal-200',
  face: 'bg-slate-100 text-slate-700 ring-slate-200',
  shoulder: 'bg-slate-100 text-slate-700 ring-slate-200',
};

type Verdict = 'in tolerance' | 'matches' | 'matches (rounding)' | 'readings differ' | 'general';

/** How the engineer's value and the AI's independent reading of the same dimension compare. */
function verdictOf(c: Characteristic): { verdict: Verdict; dev: number | null } {
  const tol = c.upper !== null && c.lower !== null;
  const dev = c.ai !== null && !c.pending ? c.ai - c.nominal : null;
  if (dev !== null && Math.abs(dev) > ROUND) return { verdict: 'readings differ', dev };
  if (tol) return { verdict: 'in tolerance', dev };
  if (dev === null) return { verdict: 'general', dev };
  return { verdict: Math.abs(dev) < 1e-9 ? 'matches' : 'matches (rounding)', dev };
}

/** 2D section of the part: outline mirrored about the axis, bores dashed, the selection in blue. */
function ProfileSvg({ model, highlight }: { model: PartModel; highlight: [number, number] | null }) {
  const { outer, inner } = model;
  if (outer.length < 2) return null;
  const L = outer[outer.length - 1][0];
  const R = Math.max(...outer.map((o) => o[1]), 1);
  const W = 640;
  const H = 170;
  const pad = 16;
  const s = Math.min((W - 2 * pad) / L, (H - 2 * pad) / (2 * R));
  const cx = (W - L * s) / 2;
  const cy = H / 2;
  const x = (p: number) => cx + p * s;
  const top = outer.map(([p, r]) => `${x(p).toFixed(1)},${(cy - r * s).toFixed(1)}`);
  const bot = [...outer].reverse().map(([p, r]) => `${x(p).toFixed(1)},${(cy + r * s).toFixed(1)}`);
  const holes = inner.filter(([, r]) => r > 0);
  const hx0 = highlight ? x(highlight[0]) : 0;
  const hx1 = highlight ? x(highlight[1]) : 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Part profile">
      <line x1={0} x2={W} y1={cy} y2={cy} stroke="#94a3b8" strokeDasharray="10 4 2 4" strokeWidth={0.8} />
      <polygon points={[...top, ...bot].join(' ')} fill="#e2e8f0" stroke="#334155" strokeWidth={1.2} />
      {holes.length > 0 &&
        [-1, 1].map((sg) => (
          <polyline
            key={sg}
            points={inner.map(([p, r]) => `${x(p).toFixed(1)},${(cy + sg * r * s).toFixed(1)}`).join(' ')}
            fill="none"
            stroke="#475569"
            strokeDasharray="4 3"
            strokeWidth={1}
          />
        ))}
      {highlight && (
        <g aria-hidden="true">
          {hx1 - hx0 > 1.5 ? (
            <rect
              x={hx0}
              y={pad / 2}
              width={hx1 - hx0}
              height={H - pad}
              rx={3}
              fill="rgb(14 165 233 / 0.18)"
              stroke="#0284c7"
              strokeWidth={1.2}
            />
          ) : (
            <line x1={hx0} x2={hx0} y1={pad / 2} y2={H - pad / 2} stroke="#0284c7" strokeWidth={2.5} />
          )}
        </g>
      )}
    </svg>
  );
}

/** Tolerance band: green band = toleranced range, tick = nominal, dot = the AI's reading
 *  (else the size the program cuts); red when the reading is off. */
function Band({ c, dev }: { c: Characteristic; dev: number | null }) {
  const tol = c.upper !== null && c.lower !== null;
  let pos = 0.5;
  let nominalAt = 0.5;
  let bad = false;
  let show = true;
  if (tol) {
    const lo = c.nominal + c.lower!;
    const hi = c.nominal + c.upper!;
    const span = Math.max(hi - lo, 1e-6);
    const v = c.ai !== null && !c.pending ? c.ai : c.programmed;
    show = v !== null;
    const t = v === null ? 0.5 : (v - lo) / span;
    bad = t < -1e-6 || t > 1 + 1e-6;
    pos = Math.max(-0.25, Math.min(1.25, t));
    nominalAt = (c.nominal - lo) / span;
  } else if (dev !== null) {
    const t = dev / (ROUND * 2); // the grey band is ± one rounding step
    bad = Math.abs(dev) > ROUND;
    pos = Math.max(-0.25, Math.min(1.25, 0.5 + t / 2));
  }
  const at = (t: number) => `${20 + t * 60}%`;
  return (
    <div className="relative h-4 w-32" aria-hidden="true">
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-slate-100" />
      <div
        className={`absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full ${tol ? 'bg-emerald-300' : 'bg-slate-300'}`}
        style={{ left: '20%', right: '20%' }}
      />
      <div
        className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-slate-500"
        style={{ left: at(Math.max(0, Math.min(1, nominalAt))) }}
      />
      {show && (
        <div
          className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white ${
            bad ? 'bg-rose-500' : tol ? 'bg-emerald-500' : 'bg-emerald-500'
          }`}
          style={{ left: at(pos) }}
        />
      )}
    </div>
  );
}

function ResultPill({ verdict, c }: { verdict: Verdict; c: Characteristic }) {
  if (verdict === 'readings differ')
    return (
      <div className="space-y-1">
        <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-800 ring-1 ring-rose-200">
          <CircleAlert className="h-3 w-3" aria-hidden="true" /> readings differ
        </span>
        <label className="flex items-center gap-1.5 text-xs text-slate-700">
          <input type="checkbox" checked={c.confirmed} readOnly className="h-3.5 w-3.5 accent-brand-600" />
          {c.confirmed ? 'engineer value checked on the drawing' : 'check it on the drawing'}
        </label>
      </div>
    );
  if (verdict === 'general')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">
        <Minus className="h-3 w-3" aria-hidden="true" /> general tolerance
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
      <Check className="h-3 w-3" aria-hidden="true" /> {verdict}
    </span>
  );
}

function Characteristics({
  chars,
  programText,
  selected,
  onSelect,
  empty,
}: {
  chars: Characteristic[];
  programText: string | null;
  selected: number | null;
  onSelect: (no: number | null) => void;
  empty: string;
}) {
  const words = useMemo(() => xWords(programText), [programText]);
  const anyAi = chars.some((c) => c.ai !== null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">
          Characteristics: every drawing dimension{anyAi ? ', read twice (engineer and AI)' : ''}
        </h3>
        <span className="text-xs text-slate-500">
          Select a row to show it on the part · values in mm, angles in degrees
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[1080px] text-sm" aria-label="Characteristics">
          <thead className="bg-slate-50/80 text-left text-[11px] tracking-wider text-slate-500 uppercase">
            <tr>
              <th className="px-3 py-2.5 font-medium">No.</th>
              <th className="px-3 py-2.5 font-medium">Drawing</th>
              <th className="px-3 py-2.5 text-right font-medium">Nominal</th>
              <th className="px-3 py-2.5 text-right font-medium">Upper</th>
              <th className="px-3 py-2.5 text-right font-medium">Lower</th>
              <th
                className="px-3 py-2.5 text-right font-medium"
                title="The AI agents' own reading of the drawing"
              >
                AI read
              </th>
              <th className="px-3 py-2.5 text-right font-medium">Deviation</th>
              <th className="px-3 py-2.5 text-right font-medium">Programmed</th>
              <th className="px-3 py-2.5 font-medium">Tolerance band</th>
              <th className="px-3 py-2.5 font-medium">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {chars.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-500">
                  {empty}
                </td>
              </tr>
            )}
            {chars.map((c) => {
              const { verdict, dev } = verdictOf(c);
              const tol = c.upper !== null && c.lower !== null;
              const line = c.xWord && c.programmed !== null ? words.get(c.programmed.toFixed(3)) : undefined;
              const showProg = c.programmed !== null && (tol || c.xWord);
              const isSel = selected === c.no;
              return (
                <tr
                  key={c.no}
                  aria-selected={isSel}
                  title={c.what}
                  className={`cursor-pointer transition-colors ${
                    isSel
                      ? 'bg-sky-50 shadow-[inset_3px_0_0_#0284c7]'
                      : verdict === 'readings differ'
                        ? 'bg-rose-50/40 hover:bg-rose-50'
                        : 'hover:bg-slate-50'
                  }`}
                  onClick={() => onSelect(isSel ? null : c.no)}
                >
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full font-mono text-[11px] ${
                        isSel ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {c.no}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="text-[15px] font-medium text-slate-900">{c.label}</span>{' '}
                    <span className="font-mono text-[11px] text-slate-400">{c.tag}</span>
                    {c.pending && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-800 ring-1 ring-amber-200">
                        <Sparkles className="h-2.5 w-2.5" aria-hidden="true" /> AI suggestion
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">{f3(c.nominal)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-600 tabular-nums">
                    {signed(c.upper)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-600 tabular-nums">
                    {signed(c.lower)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                    {c.ai !== null && !c.pending ? f4(c.ai) : '–'}
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right font-mono tabular-nums ${
                      dev === null
                        ? 'text-slate-400'
                        : Math.abs(dev) > ROUND
                          ? 'font-semibold text-rose-700'
                          : Math.abs(dev) > 1e-9
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                    }`}
                  >
                    {signed(dev, 4)}
                  </td>
                  <td
                    className="px-3 py-2.5 text-right font-mono font-semibold text-brand-700 tabular-nums"
                    title={line ? `Cut by line ${line} of the program` : undefined}
                  >
                    {showProg ? f3(c.programmed) : <span className="font-normal text-slate-400">–</span>}
                    {showProg && programText && c.xWord && (
                      <span
                        className={`block text-[10px] font-normal ${line ? 'text-slate-500' : 'text-amber-700'}`}
                      >
                        {line ? `line ${line}` : 'not in program'}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Band c={c} dev={dev} />
                  </td>
                  <td className="px-3 py-2.5">
                    <ResultPill verdict={verdict} c={c} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanTable({
  op,
  title,
  sub,
  rows,
  selectedFeature,
  onPick,
}: {
  op: string;
  title: string;
  sub: string;
  rows: PlanRow[];
  selectedFeature: number | null;
  onPick: (r: PlanRow) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-3">
        <span
          className={`rounded-lg px-2 py-1 text-xs font-bold text-white ${op === 'OP10' ? 'bg-brand-700' : 'bg-indigo-700'}`}
        >
          {op}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">{title}</p>
          <p className="text-xs text-slate-600">{sub}</p>
        </div>
        <span className="rounded-full bg-white px-2.5 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">
          {rows.length} feature{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm" aria-label={`${op} features`}>
          <thead className="text-left text-[11px] tracking-wider text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-2 font-medium">Feature</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Nominal</th>
              <th className="px-4 py-2 font-medium">Tolerance</th>
              <th className="px-4 py-2 text-right font-medium">Z from</th>
              <th className="px-4 py-2 text-right font-medium">Z to</th>
              <th className="px-4 py-2 text-right font-medium">Length</th>
              <th className="px-4 py-2 font-medium">Drawing</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const sel = selectedFeature === r.feature && !r.derived;
              return (
                <tr
                  key={r.id}
                  className={`cursor-pointer ${sel ? 'bg-sky-50 shadow-[inset_3px_0_0_#0284c7]' : 'hover:bg-slate-50'}`}
                  onClick={() => onPick(r)}
                >
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">{r.id}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs ring-1 ${TYPE_TONE[r.type] ?? TYPE_TONE.face}`}
                    >
                      {r.typeLabel}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-medium">{r.nominal || '–'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">{r.tol ?? '–'}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{f3(r.zFrom)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{f3(r.zTo)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">
                    {r.length === null ? '–' : f3(r.length)}
                  </td>
                  <td
                    className={`px-4 py-2 text-xs ${r.derived ? 'text-slate-500 italic' : 'text-slate-700'}`}
                  >
                    {r.drawing}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Step 2 report from the feature table: the part (3D + profile + summary), every drawing dimension
 * with its tolerance, the AI's independent reading and the size the program cuts, and the process
 * plan by operation. Selecting a dimension or a plan row shows where it is on the part.
 */
export default function PartReport({
  model,
  partNumber,
  drawingRef,
  programText,
  aiOn = false,
  nonTurned = [],
}: {
  model: PartModel;
  partNumber: string;
  drawingRef: string;
  programText: string | null;
  /** The AI reader is switched on (it fills the table when it reads a drawing). */
  aiOn?: boolean;
  /** Features a lathe alone cannot make (flats, cross holes…), from the AI's 3D analysis. */
  nonTurned?: string[];
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [planPick, setPlanPick] = useState<PlanRow | null>(null);
  const [pointPick, setPointPick] = useState<number | null>(null);
  const turned = model.op10.length + model.op20.length;
  const toleranced = model.chars.filter((c) => c.upper !== null && c.lower !== null).length;
  const aiRead = model.chars.filter((c) => c.ai !== null).length;
  const differ = model.chars.filter((c) => verdictOf(c).verdict === 'readings differ').length;
  const ticked = model.chars.filter((c) => c.confirmed).length;
  const has3d = model.outer.length >= 2;
  // the off-lathe features: as geometry when the AI gave it (also drawn in 3D), else as text
  const skipped = new Set(cutters(model.solid, model.outer, model.length ?? 0).skipped);
  const offLathe = model.solid.length
    ? model.solid.map((f, k) => ({ text: describeSolid(f), evidence: f.evidence, notDrawn: skipped.has(k) }))
    : nonTurned.map((x) => ({ text: x, evidence: '', notDrawn: false }));
  const sel = model.chars.find((c) => c.no === selected) ?? null;
  const pickedPoint = pointPick !== null ? model.contour?.outer[pointPick] : undefined;
  const highlight =
    sel?.span ??
    planPick?.span ??
    (pickedPoint ? ([pickedPoint.z, pickedPoint.z] as [number, number]) : null);
  const selFeature = sel?.feature ?? planPick?.feature ?? null;

  const empty = model.chars.length === 0 && !has3d;
  const stat = (label: string, value: ReactNode, tone = '') => (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`mt-0.5 font-medium [overflow-wrap:anywhere] ${tone}`}>{value}</dd>
    </div>
  );

  return (
    <div className="@container space-y-6">
      {empty ? (
        <div className="flex flex-col gap-4 rounded-xl border border-dashed border-slate-300 bg-linear-to-br from-slate-50 to-white p-5 @xl:flex-row @xl:items-center">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white text-slate-500 shadow-sm ring-1 ring-slate-200">
            <FileSearch className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-slate-900">Nothing read from this drawing yet</p>
            <p className="mt-0.5 text-sm text-slate-600">
              {aiOn
                ? 'The two AI agents fill the dimensions when they read the drawing; then the part, every dimension and the process plan appear here.'
                : 'The AI reader is off on this server. Enter the values in the feature table below; the part, every dimension and the process plan build up here as you type.'}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-white px-2.5 py-1 text-slate-700 ring-1 ring-slate-200 [overflow-wrap:anywhere]">
                Part <b className="font-semibold">{partNumber}</b>
              </span>
              {drawingRef && (
                <span className="rounded-full bg-white px-2.5 py-1 text-slate-700 ring-1 ring-slate-200 [overflow-wrap:anywhere]">
                  Drawing <b className="font-semibold">{drawingRef}</b>
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-linear-to-b from-slate-50 to-slate-100">
              {has3d ? (
                <Suspense fallback={<div className="h-[260px]" />}>
                  <PartPreview3D outer={model.outer} inner={model.inner} solid={model.solid} height={260} />
                </Suspense>
              ) : (
                <p className="flex h-[120px] items-center justify-center p-4 text-sm text-slate-500">
                  Enter the overall length and the OD steps to see the part.
                </p>
              )}
              {has3d && (
                <p className="px-3 pb-2 text-xs text-slate-500">
                  Built from the table · L {model.length?.toFixed(3) ?? '?'} · Ø
                  {model.maxDia?.toFixed(3) ?? '?'} max · drag to turn
                </p>
              )}
            </div>
            {has3d && (
              <div className="rounded-xl border border-slate-200 bg-white p-2">
                <ProfileSvg model={model} highlight={highlight} />
                <p className="px-1 pb-0.5 text-xs text-slate-500" aria-live="polite">
                  {sel
                    ? `${sel.tag} ${sel.label}: ${sel.what}, ${sel.op}`
                    : planPick
                      ? `${planPick.id} ${planPick.typeLabel} ${planPick.nominal}`
                      : pickedPoint
                        ? `P${(pointPick ?? 0) + 1}: ${pickedPoint.z.toFixed(3)} mm from the front face, Ø${pickedPoint.d.toFixed(3)}`
                        : 'Select a dimension, a plan row or a contour point to see where it is.'}
                </p>
              </div>
            )}
          </div>
          <dl className="grid min-w-0 grid-cols-2 content-start gap-x-6 gap-y-4 rounded-xl border border-slate-200 bg-white p-5 text-sm shadow-sm @2xl:grid-cols-3 @4xl:grid-cols-2">
            <div className="col-span-full min-w-0 border-b border-slate-100 pb-3">
              <dt className="text-xs text-slate-500">Part</dt>
              <dd className="mt-0.5 text-lg font-semibold [overflow-wrap:anywhere]">{partNumber}</dd>
              {drawingRef && (
                <dd className="mt-0.5 text-xs text-slate-600 [overflow-wrap:anywhere]">{drawingRef}</dd>
              )}
            </div>
            {stat('Overall length', model.length !== null ? `${model.length} mm` : '–')}
            {stat('Largest diameter', model.maxDia !== null ? `Ø${model.maxDia} mm` : '–')}
            {stat('Dimensions', `${model.chars.length} · ${toleranced} toleranced`)}
            {stat(
              'Features',
              `${turned} turned${model.op20.length ? ` · OP10 ${model.op10.length} · OP20 ${model.op20.length}` : ''}`,
            )}
            {stat(
              'Read by the AI',
              aiRead
                ? `${aiRead} / ${model.chars.length}${differ ? ` · ${differ} differ` : ' · all agree'}`
                : 'not yet',
              differ ? 'text-rose-700' : aiRead ? '' : 'text-slate-500',
            )}
            {stat(
              'Checked by the engineer',
              `${ticked} / ${model.chars.length}`,
              model.chars.length && ticked === model.chars.length ? 'text-emerald-700' : 'text-amber-700',
            )}
            {stat(
              'Bar',
              model.bar !== null ? `Ø${model.bar} mm` : 'not entered',
              model.bar === null ? 'text-slate-500' : '',
            )}
            {stat('Material', model.material ?? '–')}
          </dl>
        </div>
      )}

      {!empty && (
        <Characteristics
          chars={model.chars}
          programText={programText}
          selected={selected}
          empty={
            empty
              ? 'No dimensions yet: each one appears here with its tolerance band, the size the program cuts and its check result.'
              : 'No dimensions in the table yet.'
          }
          onSelect={(no) => {
            setSelected(no);
            setPlanPick(null);
          }}
        />
      )}

      {model.contour && model.contour.outer.length > 1 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold">The part point by point: mm from the front face</h3>
            {model.contourCheck.length === 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
                <Check className="h-3 w-3" aria-hidden="true" /> agrees with the feature table to 0.02 mm
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-800 ring-1 ring-rose-200">
                <CircleAlert className="h-3 w-3" aria-hidden="true" /> {model.contourCheck.length}{' '}
                {model.contourCheck.length === 1 ? 'difference' : 'differences'} with the feature table
              </span>
            )}
          </div>
          {model.contourCheck.length > 0 && (
            <ul className="list-disc rounded-xl bg-rose-50/60 py-2 pr-3 pl-8 text-sm text-rose-900">
              {model.contourCheck.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[640px] text-sm" aria-label="Contour points">
              <thead className="bg-slate-50/80 text-left text-[11px] tracking-wider text-slate-500 uppercase">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Point</th>
                  <th className="px-3 py-2.5 text-right font-medium">Z from front (mm)</th>
                  <th className="px-3 py-2.5 text-right font-medium">Diameter (mm)</th>
                  <th className="px-3 py-2.5 font-medium">Reached by</th>
                  <th className="px-3 py-2.5 font-medium">From the drawing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {model.contour.outer.map((pt, i) => (
                  <tr
                    key={`${i}-${pt.z}-${pt.d}`}
                    aria-selected={pointPick === i}
                    className={`cursor-pointer ${pointPick === i ? 'bg-sky-50 shadow-[inset_3px_0_0_#0284c7]' : 'hover:bg-slate-50'}`}
                    onClick={() => {
                      setPointPick(pointPick === i ? null : i);
                      setSelected(null);
                      setPlanPick(null);
                    }}
                  >
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">P{i + 1}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{pt.z.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">Ø{pt.d.toFixed(3)}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {pt.segment === 'start'
                        ? 'start (front face)'
                        : pt.segment === 'arc'
                          ? `arc R${pt.radius ?? '?'}`
                          : 'straight line'}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">{pt.evidence || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {turned === 0 && !empty && (
        <div className="space-y-3">
          <h3 className="font-semibold">Process plan: every feature in an operation</h3>
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-6 text-center text-sm text-slate-500">
            OP10 (front side) and OP20 (after "Turn part around") are planned here from the feature table,
            with Z from / Z to for every feature.
          </div>
        </div>
      )}
      {turned > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold">Process plan: every feature in an operation</h3>
            <span className="text-xs text-slate-500">
              Z from the clamping&apos;s finished face (Z0), negative toward the chuck
            </span>
          </div>
          <PlanTable
            op="OP10"
            title={model.op20.length ? 'Turn the front side' : 'Turn the part'}
            sub="Lathe, from bar · Z0 = front face of the part"
            rows={model.op10}
            selectedFeature={selFeature}
            onPick={(r) => {
              setPlanPick(r);
              setSelected(null);
            }}
          />
          {model.op20.length > 0 && (
            <PlanTable
              op="OP20"
              title="Turn the back side"
              sub="Same lathe, part turned round, held on its turned diameter (soft jaws) · Z0 = finished back face"
              rows={model.op20}
              selectedFeature={selFeature}
              onPick={(r) => {
                setPlanPick(r);
                setSelected(null);
              }}
            />
          )}
          {offLathe.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-violet-200 bg-white shadow-sm">
              <div className="flex items-center gap-3 border-b border-violet-200 bg-violet-50/70 px-4 py-3">
                <span className="rounded-lg bg-violet-700 px-2 py-1 text-xs font-bold text-white">Extra</span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-slate-900">Not in the generated lathe program</p>
                  <p className="text-xs text-slate-600">
                    From the AI&apos;s 3D analysis of the drawing · face grooves need a face-grooving tool;
                    holes, flats and slots need drilling or milling
                  </p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">
                  {offLathe.length} feature{offLathe.length === 1 ? '' : 's'}
                </span>
              </div>
              <ol className="divide-y divide-slate-100 text-sm" aria-label="OP30 features">
                {offLathe.map((x, k) => (
                  <li key={`${k}-${x.text}`} className="flex gap-4 px-4 py-2">
                    <span className="font-mono text-xs text-slate-500">N{k + 1}</span>
                    <span className="min-w-0 flex-1 text-slate-800">
                      {x.text}
                      {x.evidence && <span className="block text-xs text-slate-500">{x.evidence}</span>}
                    </span>
                    {x.notDrawn && (
                      <span className="self-start rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800 ring-1 ring-amber-200">
                        size missing: not in 3D
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
