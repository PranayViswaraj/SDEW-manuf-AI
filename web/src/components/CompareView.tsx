import { motion } from 'framer-motion';
import { GitCompareArrows } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Toolpath, ToolpathSegment } from './ToolpathView';

type Seg = ToolpathSegment & { op?: number };

/** Deepest Z any cutting move reaches: drills, bores and part-off all show up here. */
function deepest(segs: Seg[]): number | null {
  const zs = segs.filter((s) => s.kind === 'feed').flatMap((s) => s.points.map(([z]) => z));
  return zs.length ? Math.min(...zs) : null;
}

const fmt = (v: number | null) => (v === null ? '–' : v.toFixed(2));

function Delta({ a, b }: { a: number | null; b: number | null }) {
  if (a === null || b === null) return <span className="text-slate-400">–</span>;
  const d = a - b;
  const abs = Math.abs(d);
  const cls = abs <= 0.1 ? 'badge-green' : abs <= 0.5 ? 'badge-amber' : 'badge-red';
  return <span className={cls}>{abs < 0.005 ? 'same' : `${d > 0 ? '+' : ''}${d.toFixed(2)}`}</span>;
}

function pathOf(s: Seg): string {
  return s.points.map(([z, r], i) => `${i ? 'L' : 'M'}${z.toFixed(3)},${(-r).toFixed(3)}`).join(' ');
}

/** Generated cutting path laid over the shop's proven program, per clamping, with measured facts. */
export default function CompareView({ generated, provenName }: { generated: Toolpath; provenName: string }) {
  const [proven, setProven] = useState<Toolpath | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [op, setOp] = useState(1);

  useEffect(() => {
    api
      .get<Toolpath>(`/generator/library/${provenName}/toolpath`)
      .then(setProven)
      .catch((e: Error) => setError(e.message));
  }, [provenName]);

  const gen = useMemo(() => (generated.segments as Seg[]).filter((s) => (s.op ?? 1) === op), [generated, op]);
  const ref = useMemo(
    () => ((proven?.segments ?? []) as Seg[]).filter((s) => (s.op ?? 1) === op),
    [proven, op],
  );
  const ops = useMemo(() => {
    const all = new Set<number>(
      [...generated.segments, ...(proven?.segments ?? [])].map((s) => (s as Seg).op ?? 1),
    );
    return [...all].sort();
  }, [generated, proven]);

  const view = useMemo(() => {
    const pts = [...gen, ...ref].filter((s) => s.kind === 'feed').flatMap((s) => s.points);
    if (!pts.length) return null;
    const zs = pts.map(([z]) => z);
    const rs = pts.map(([, r]) => r);
    const zMin = Math.min(...zs, 0) - 2;
    const zMax = Math.max(...zs, 0) + 2;
    const rMax = Math.max(...rs) + 2;
    return { x: zMin, y: -rMax, w: zMax - zMin, h: rMax + 1 };
  }, [gen, ref]);

  if (error) return <p className="text-sm text-rose-800">{error}</p>;
  const dg = deepest(gen);
  const dp = deepest(ref);

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="card space-y-3 p-4"
      aria-label="Compare with proven program"
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitCompareArrows className="h-5 w-5 text-brand-600" aria-hidden="true" />
        <h3 className="font-semibold">Compare with proven program {provenName}</h3>
        <div className="ml-auto flex rounded-lg bg-slate-100 p-0.5" role="group" aria-label="Clamping">
          {ops.map((o) => (
            <button
              key={o}
              className={`relative rounded-md px-3 py-1 text-xs font-semibold transition ${
                op === o ? 'text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
              aria-pressed={op === o}
              onClick={() => setOp(o)}
            >
              {op === o && (
                <motion.span layoutId="cmp-op" className="absolute inset-0 rounded-md bg-brand-600" />
              )}
              <span className="relative">{o === 1 ? '1st clamping' : '2nd clamping'}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-slate-600">
        Cutting moves only, top half of the part (Z across, radius up). Blue = generated from the drawing,
        amber dashed = {provenName} as the shop runs it. Each clamping is drawn from its own Z0.
      </p>
      {!proven ? (
        <div className="skeleton h-48 w-full rounded-xl" />
      ) : view ? (
        <div className="space-y-3">
          <svg
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            className="h-64 w-full rounded-xl bg-slate-50 ring-1 ring-slate-200"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`Generated and ${provenName} cutting paths, clamping ${op}`}
          >
            <line
              x1={view.x}
              x2={view.x + view.w}
              y1={0}
              y2={0}
              stroke="#94a3b8"
              strokeWidth={0.15}
              strokeDasharray="1 1"
            />
            <line x1={0} x2={0} y1={view.y} y2={1} stroke="#94a3b8" strokeWidth={0.15} />
            {ref
              .filter((s) => s.kind === 'feed')
              .map((s, i) => (
                <path
                  key={`p${i}`}
                  d={pathOf(s)}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={0.45}
                  strokeDasharray="1.2 0.8"
                />
              ))}
            {gen
              .filter((s) => s.kind === 'feed')
              .map((s, i) => (
                <motion.path
                  key={`g${op}-${i}`}
                  d={pathOf(s)}
                  fill="none"
                  stroke="#2c579c"
                  strokeWidth={0.3}
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.6, delay: Math.min(i * 0.02, 0.8) }}
                />
              ))}
          </svg>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 text-slate-700">
              <span className="h-0.5 w-5 rounded bg-brand-600" aria-hidden="true" /> Generated
            </span>
            <span className="inline-flex items-center gap-1.5 text-slate-700">
              <span className="h-0 w-5 border-t-2 border-dashed border-amber-500" aria-hidden="true" />{' '}
              {provenName}
            </span>
            <span className="ml-auto text-slate-700">
              Deepest cut: <span className="font-mono">{fmt(dg)}</span> vs{' '}
              <span className="font-mono">{fmt(dp)}</span> <Delta a={dg} b={dp} />
            </span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-600">No cutting moves in this clamping.</p>
      )}
    </motion.section>
  );
}
