import { Check, CircleAlert, Minus, Sparkles } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { type Characteristic, type PartModel, type PlanRow, xWords } from '../lib/partModel';

const PartPreview3D = lazy(() => import('./PartPreview3D'));

/** Two readings within this are the same value written with different rounding. */
const ROUND = 0.005;

const f3 = (v: number | null) => (v === null ? '–' : v.toFixed(3));
const f4 = (v: number | null) => (v === null ? '–' : v.toFixed(4));
const signed = (v: number | null, d = 3) =>
  v === null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

const TYPE_TONE: Record<string, string> = {
  od: 'bg-sky-50 text-sky-800 ring-sky-200',
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
}: {
  chars: Characteristic[];
  programText: string | null;
  selected: number | null;
  onSelect: (no: number | null) => void;
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
}: {
  model: PartModel;
  partNumber: string;
  drawingRef: string;
  programText: string | null;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [planPick, setPlanPick] = useState<PlanRow | null>(null);
  const turned = model.op10.length + model.op20.length;
  const toleranced = model.chars.filter((c) => c.upper !== null && c.lower !== null).length;
  const aiRead = model.chars.filter((c) => c.ai !== null).length;
  const differ = model.chars.filter((c) => verdictOf(c).verdict === 'readings differ').length;
  const ticked = model.chars.filter((c) => c.confirmed).length;
  const has3d = model.outer.length >= 2;
  const sel = model.chars.find((c) => c.no === selected) ?? null;
  const highlight = sel?.span ?? planPick?.span ?? null;
  const selFeature = sel?.feature ?? planPick?.feature ?? null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-linear-to-b from-slate-50 to-slate-100">
            {has3d ? (
              <Suspense fallback={<div className="h-[260px]" />}>
                <PartPreview3D outer={model.outer} inner={model.inner} height={260} />
              </Suspense>
            ) : (
              <p className="flex h-[160px] items-center justify-center p-4 text-sm text-slate-500">
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
                    : 'Select a dimension or a plan row to see where it is.'}
              </p>
            </div>
          )}
        </div>
        <dl className="grid grid-cols-2 content-start gap-x-6 gap-y-4 rounded-xl border border-slate-200 bg-white p-5 text-sm shadow-sm">
          <div>
            <dt className="text-xs text-slate-500">Part</dt>
            <dd className="text-base font-medium">{partNumber}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Drawing</dt>
            <dd className="font-medium break-words">{drawingRef || '–'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Overall length</dt>
            <dd className="text-base font-medium">{model.length !== null ? `${model.length} mm` : '–'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Largest diameter</dt>
            <dd className="text-base font-medium">{model.maxDia !== null ? `Ø${model.maxDia} mm` : '–'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Drawing dimensions</dt>
            <dd className="font-medium">
              {model.chars.length} · {toleranced} toleranced
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Features</dt>
            <dd className="font-medium">
              {turned} turned
              {model.op20.length ? ` · ${model.op10.length} OP10 · ${model.op20.length} OP20` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Read by the AI</dt>
            <dd className={`font-medium ${differ ? 'text-rose-700' : ''}`}>
              {aiRead
                ? `${aiRead} / ${model.chars.length}${differ ? ` · ${differ} differ` : ' · all agree'}`
                : 'not yet (entered by hand)'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Checked by the engineer</dt>
            <dd
              className={`font-medium ${ticked === model.chars.length ? 'text-emerald-700' : 'text-amber-700'}`}
            >
              {ticked} / {model.chars.length}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Bar</dt>
            <dd className="font-medium">{model.bar !== null ? `Ø${model.bar} mm` : 'not entered'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Material</dt>
            <dd className="font-medium">{model.material ?? '–'}</dd>
          </div>
        </dl>
      </div>

      {model.chars.length > 0 && (
        <Characteristics
          chars={model.chars}
          programText={programText}
          selected={selected}
          onSelect={(no) => {
            setSelected(no);
            setPlanPick(null);
          }}
        />
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
        </div>
      )}
    </div>
  );
}
