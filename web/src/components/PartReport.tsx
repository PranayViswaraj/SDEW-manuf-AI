import { Check, CircleAlert, Minus } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { type Characteristic, type PartModel, type PlanRow, xWords } from '../lib/partModel';

const PartPreview3D = lazy(() => import('./PartPreview3D'));

const fmt3 = (v: number | null) => (v === null ? '–' : v.toFixed(3));
const tolFmt = (v: number | null) => (v === null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`);
const zFmt = (v: number | null) => (v === null ? '–' : v.toFixed(3));

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
};

/** 2D section of the part: outer outline mirrored about the axis, bores dashed. */
function ProfileSvg({ model }: { model: PartModel }) {
  const { outer, inner } = model;
  if (outer.length < 2) return null;
  const L = outer[outer.length - 1][0];
  const R = Math.max(...outer.map((o) => o[1]), 1);
  const W = 640;
  const H = 150;
  const pad = 14;
  const s = Math.min((W - 2 * pad) / L, (H - 2 * pad) / (2 * R));
  const cx = (W - L * s) / 2;
  const cy = H / 2;
  const x = (p: number) => cx + p * s;
  const top = outer.map(([p, r]) => `${x(p).toFixed(1)},${(cy - r * s).toFixed(1)}`);
  const bot = [...outer].reverse().map(([p, r]) => `${x(p).toFixed(1)},${(cy + r * s).toFixed(1)}`);
  const holes = inner.filter(([, r]) => r > 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Part profile">
      <line x1={0} x2={W} y1={cy} y2={cy} stroke="#94a3b8" strokeDasharray="8 4 2 4" strokeWidth={0.8} />
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
    </svg>
  );
}

function Band({ c }: { c: Characteristic }) {
  const tol = c.upper !== null && c.lower !== null;
  const span = tol ? Math.max(c.upper! - c.lower!, 1e-6) : 1;
  const prog = c.programmed !== null && tol ? (c.programmed - c.nominal - c.lower!) / span : 0.5;
  const pos = Math.max(0, Math.min(1, prog));
  return (
    <div className="relative h-3 w-28" aria-hidden="true">
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-slate-200" />
      {tol && (
        <div className="absolute inset-y-[3px] left-[12%] right-[12%] rounded-full bg-emerald-300/70" />
      )}
      {!tol && <div className="absolute inset-y-0 left-1/2 w-px bg-slate-400" />}
      {(c.programmed !== null || !tol) && (
        <div
          className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white ${
            tol ? 'bg-emerald-600' : 'bg-slate-400'
          }`}
          style={{ left: `${12 + pos * 76}%` }}
        />
      )}
    </div>
  );
}

function Characteristics({ chars, programText }: { chars: Characteristic[]; programText: string | null }) {
  const words = useMemo(() => xWords(programText), [programText]);
  const [sel, setSel] = useState<number | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Characteristics: every dimension, its tolerance and the size cut</h3>
        <span className="text-xs text-slate-500">values in mm, angles in degrees</span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[860px] text-sm" aria-label="Characteristics">
          <thead className="bg-slate-50 text-left text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">No.</th>
              <th className="px-3 py-2 font-medium">Drawing</th>
              <th className="px-3 py-2 font-medium">Where</th>
              <th className="px-3 py-2 text-right font-medium">Nominal</th>
              <th className="px-3 py-2 text-right font-medium">Upper</th>
              <th className="px-3 py-2 text-right font-medium">Lower</th>
              <th className="px-3 py-2 text-right font-medium">Programmed</th>
              <th className="px-3 py-2 font-medium">Tolerance band</th>
              <th className="px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {chars.map((c) => {
              const tol = c.upper !== null && c.lower !== null;
              const inBand =
                tol && c.programmed !== null
                  ? c.programmed >= c.nominal + c.lower! - 1e-9 && c.programmed <= c.nominal + c.upper! + 1e-9
                  : null;
              const line = c.xWord && c.programmed !== null ? words.get(c.programmed.toFixed(3)) : undefined;
              return (
                <tr
                  key={c.no}
                  className={`cursor-pointer transition-colors ${sel === c.no ? 'bg-sky-50' : 'hover:bg-slate-50'}`}
                  onClick={() => setSel(sel === c.no ? null : c.no)}
                >
                  <td className="px-3 py-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 font-mono text-xs text-slate-600">
                      {c.no}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="text-base font-medium text-slate-900">{c.label}</span>{' '}
                    <span className="font-mono text-[11px] text-slate-400">{c.tag}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {c.what} · {c.op}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt3(c.nominal)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600 tabular-nums">
                    {tolFmt(c.upper)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600 tabular-nums">
                    {tolFmt(c.lower)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold text-brand-700 tabular-nums">
                    {c.programmed !== null && (tol || c.xWord) ? fmt3(c.programmed) : '–'}
                  </td>
                  <td className="px-3 py-2">
                    <Band c={c} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {inBand === true ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800 ring-1 ring-emerald-200">
                        <Check className="h-3 w-3" aria-hidden="true" /> cut mid-tolerance
                      </span>
                    ) : inBand === false ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-800 ring-1 ring-rose-200">
                        <CircleAlert className="h-3 w-3" aria-hidden="true" /> outside tolerance
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-0.5 text-slate-600 ring-1 ring-slate-200">
                        <Minus className="h-3 w-3" aria-hidden="true" />{' '}
                        {tol ? 'toleranced, cut as drawn' : 'general tolerance'}
                      </span>
                    )}
                    {programText && c.xWord && c.programmed !== null && (
                      <span className={`mt-1 block ${line ? 'text-emerald-700' : 'text-amber-700'}`}>
                        {line ? `X${c.programmed} on line ${line}` : `X${c.programmed} not in the program`}
                      </span>
                    )}
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

function PlanTable({ op, title, sub, rows }: { op: string; title: string; sub: string; rows: PlanRow[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200">
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
        <table className="w-full min-w-[720px] text-sm" aria-label={`${op} features`}>
          <thead className="text-left text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-2 font-medium">Feature</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Nominal</th>
              <th className="px-4 py-2 font-medium">Tolerance</th>
              <th className="px-4 py-2 text-right font-medium">Z from</th>
              <th className="px-4 py-2 text-right font-medium">Z to</th>
              <th className="px-4 py-2 text-right font-medium">Length</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id}>
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
                <td className="px-4 py-2 text-right font-mono tabular-nums">{zFmt(r.zFrom)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{zFmt(r.zTo)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">
                  {r.length === null ? '–' : r.length.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Step 2 report from the feature table: the part (3D + profile + summary), every dimension with
 * its tolerance and the size the program cuts, and the process plan by operation.
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
  const turned = model.op10.length + model.op20.length;
  const toleranced = model.chars.filter((c) => c.upper !== null && c.lower !== null).length;
  const has3d = model.outer.length >= 2;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
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
              <ProfileSvg model={model} />
            </div>
          )}
        </div>
        <dl className="grid grid-cols-2 content-start gap-x-6 gap-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <div>
            <dt className="text-xs text-slate-500">Part</dt>
            <dd className="font-medium">{partNumber}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Drawing</dt>
            <dd className="font-medium break-words">{drawingRef || '–'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Overall length</dt>
            <dd className="font-medium">{model.length !== null ? `${model.length} mm` : '–'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Largest diameter</dt>
            <dd className="font-medium">{model.maxDia !== null ? `Ø${model.maxDia} mm` : '–'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Bar</dt>
            <dd className="font-medium">{model.bar !== null ? `Ø${model.bar} mm` : 'not entered'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Material</dt>
            <dd className="font-medium">{model.material ?? '–'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Dimensions</dt>
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
        </dl>
      </div>

      {model.chars.length > 0 && <Characteristics chars={model.chars} programText={programText} />}

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
          />
          {model.op20.length > 0 && (
            <PlanTable
              op="OP20"
              title="Turn the back side"
              sub="Same lathe, part turned round, held on its turned diameter (soft jaws) · Z0 = finished back face"
              rows={model.op20}
            />
          )}
        </div>
      )}
    </div>
  );
}
