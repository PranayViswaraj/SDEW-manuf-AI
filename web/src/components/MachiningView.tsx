import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useA11y } from '../a11y/A11yContext';
import {
  Material,
  blockEndTime,
  buildTimeline,
  classifyTool,
  positionAt,
  samplesAlong,
  stockFor,
  type Point,
  type SimSegment,
  type Timeline,
  type ToolInfo,
} from '../sim/machining';

interface Toolpath {
  segments: SimSegment[];
  blocks: { index: number; line: number; text: string }[];
}

interface Chip {
  z: number;
  y: number;
  vz: number;
  vy: number;
  life: number;
}

const SPEEDS = [1, 2, 5, 10];

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function ToolShape({ point, tool }: { point: Point; tool: ToolInfo }) {
  const [z, r] = point;
  const y = -Math.abs(r);
  const body = 'fill-slate-700';
  if (tool.kind === 'drill') {
    const h = Math.max((tool.size ?? 6) / 2, 0.8);
    return (
      <g aria-hidden="true">
        <polygon
          points={`${z},0 ${z + 1.2},${-h} ${z + 60},${-h} ${z + 60},${h} ${z + 1.2},${h}`}
          className={body}
          opacity={0.85}
        />
      </g>
    );
  }
  if (tool.kind === 'internal') {
    return (
      <g aria-hidden="true">
        <rect x={z + 0.8} y={y} width={60} height={1.8} className={body} />
        <polygon
          points={`${z},${y} ${z + 1.6},${y - 0.6} ${z + 1.6},${y + 1.4}`}
          className="fill-slate-500"
        />
      </g>
    );
  }
  if (tool.kind === 'groove') {
    const w = tool.size ?? 3;
    return (
      <g aria-hidden="true">
        <rect x={z - w} y={y - 40} width={w} height={40} className={body} />
      </g>
    );
  }
  return (
    <g aria-hidden="true">
      <rect x={z + 1.2} y={y - 40} width={4} height={36} className={body} />
      <polygon
        points={`${z},${y} ${z + 3.2},${y - 1.4} ${z + 2.2},${y - 4.6} ${z - 0.4},${y - 2.6}`}
        className="fill-slate-500"
      />
    </g>
  );
}

export default function MachiningView({ programId }: { programId: number }) {
  const { prefs } = useA11y();
  const calm = prefs.reduceMotion || prefersReducedMotion();
  const [data, setData] = useState<Toolpath | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [op, setOp] = useState(1);
  const [bar, setBar] = useState('');
  const [speed, setSpeed] = useState(2);
  const [playing, setPlaying] = useState(false);
  const [, setFrame] = useState(0);

  const tRef = useRef(0);
  const matRef = useRef<Material | null>(null);
  const appliedRef = useRef({ move: 0, frac: 0 });
  const chipsRef = useRef<Chip[]>([]);

  useEffect(() => {
    api
      .get<Toolpath>(`/programs/${programId}/toolpath`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [programId]);

  const ops = useMemo(() => {
    const set = new Set((data?.segments ?? []).map((s) => s.op ?? 1));
    return [...set].sort((a, b) => a - b);
  }, [data]);

  const segs = useMemo(() => (data?.segments ?? []).filter((s) => (s.op ?? 1) === op), [data, op]);
  const timeline: Timeline = useMemo(() => buildTimeline(segs), [segs]);
  const barDia = bar.trim() && Number(bar) > 0 ? Number(bar) : null;
  const stock = useMemo(() => stockFor(segs, barDia), [segs, barDia]);
  const tools = useMemo(() => {
    const m = new Map<SimSegment, ToolInfo>();
    for (const s of segs) m.set(s, classifyTool(s.label ?? ''));
    return m;
  }, [segs]);

  /** Apply all cutting between the last applied position and time t. Returns removed area. */
  const advanceTo = useCallback(
    (t: number) => {
      const mat = matRef.current;
      if (!mat || timeline.moves.length === 0) return 0;
      const pos = positionAt(timeline, t);
      if (!pos) return 0;
      const targetMove = timeline.moves.indexOf(pos.move);
      const span = pos.move.t1 - pos.move.t0;
      const targetFrac = span > 0 ? Math.min(1, Math.max(0, (t - pos.move.t0) / span)) : 1;
      let removed = 0;
      let { move, frac } = appliedRef.current;
      while (move <= targetMove) {
        const m = timeline.moves[move];
        const end = move === targetMove ? targetFrac : 1;
        if (end > frac && m.seg.kind === 'feed') {
          const a: Point = [
            m.from[0] + (m.to[0] - m.from[0]) * frac,
            m.from[1] + (m.to[1] - m.from[1]) * frac,
          ];
          const b: Point = [m.from[0] + (m.to[0] - m.from[0]) * end, m.from[1] + (m.to[1] - m.from[1]) * end];
          const tool = tools.get(m.seg) ?? classifyTool('');
          for (const p of samplesAlong(a, b)) removed += mat.cut(p[0], p[1], tool);
        }
        if (move === targetMove) {
          frac = Math.max(frac, end);
          break;
        }
        move += 1;
        frac = 0;
      }
      appliedRef.current = { move, frac };
      return removed;
    },
    [timeline, tools],
  );

  const resetTo = useCallback(
    (t: number) => {
      matRef.current = new Material(stock.zMin, stock.zMax, stock.barR, stock.zFront);
      appliedRef.current = { move: 0, frac: 0 };
      chipsRef.current = [];
      tRef.current = Math.max(0, Math.min(t, timeline.duration));
      advanceTo(tRef.current);
      setFrame((f) => f + 1);
    },
    [stock, timeline.duration, advanceTo],
  );

  // New operation / bar size: fresh stock at the start.
  useEffect(() => {
    setPlaying(false);
    resetTo(0);
  }, [resetTo]);

  // Animation loop.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = Math.min(timeline.duration, tRef.current + dt * speed);
      tRef.current = t;
      const removed = advanceTo(t);
      if (!calm) {
        const pos = positionAt(timeline, t);
        const chips = chipsRef.current;
        if (removed > 0 && pos && chips.length < 60) {
          for (let k = 0; k < 2; k++) {
            chips.push({
              z: pos.point[0],
              y: -Math.abs(pos.point[1]),
              vz: 8 + Math.random() * 14,
              vy: -(10 + Math.random() * 14),
              life: 0.7,
            });
          }
        }
        for (const c of chips) {
          c.z += c.vz * dt;
          c.y += c.vy * dt;
          c.vy += 60 * dt;
          c.life -= dt;
        }
        chipsRef.current = chips.filter((c) => c.life > 0);
      }
      setFrame((f) => f + 1);
      if (t >= timeline.duration) {
        chipsRef.current = [];
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, timeline, advanceTo, calm]);

  if (error) return <p className="text-sm text-rose-800">{error}</p>;
  if (!data) return null;
  if (timeline.moves.length === 0) return null;

  const t = tRef.current;
  const pos = positionAt(timeline, t);
  const mat = matRef.current;
  const currentBlock = pos?.move.seg.block;
  const blockIdx = Math.max(0, timeline.blocks.indexOf(currentBlock ?? -1));
  const blockInfo = data.blocks.find((b) => b.index === currentBlock);
  const tool = pos ? (tools.get(pos.move.seg) ?? classifyTool('')) : null;
  const done = t >= timeline.duration - 1e-6;
  const pct = timeline.duration ? Math.round((t / timeline.duration) * 1000) : 0;

  const R = Math.max(stock.barR, ...segs.flatMap((s) => s.points.map((p) => Math.abs(p[1])))) + 4;
  const zLo = stock.zMin - 2;
  const zHi = Math.max(stock.zMax, ...segs.flatMap((s) => s.points.map((p) => p[0]))) + 3;
  const vb = `${zLo} ${-R} ${zHi - zLo} ${2 * R}`;
  const path = mat?.toPath() ?? '';
  const trail = timeline.moves.filter((m) => m.t1 <= t);

  function seekBlock(dir: -1 | 1) {
    setPlaying(false);
    const next = blockIdx + dir;
    if (next < 0) {
      resetTo(0);
      return;
    }
    const target = timeline.blocks[Math.min(next, timeline.blocks.length - 1)];
    resetTo(blockEndTime(timeline, target));
  }

  return (
    <section className="space-y-3 rounded border bg-white p-4" aria-labelledby="mach-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="mach-title" className="font-semibold">
            Machining simulation
          </h2>
          <p className="text-xs text-slate-600">
            Watch the bar being cut, block by block. Visual aid only: tool shapes and stock are approximate,
            and it does not prove the program is safe.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {ops.length > 1 && (
            <label className="text-sm">
              <span className="block text-xs font-medium text-slate-700">Operation</span>
              <select
                className="input mt-1 w-40"
                value={op}
                onChange={(e) => setOp(Number(e.target.value))}
                aria-label="Operation"
              >
                {ops.map((o) => (
                  <option key={o} value={o}>
                    {o === 1 ? '1st' : o === 2 ? '2nd' : o === 3 ? '3rd' : `${o}th`} operation
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="text-sm">
            <span className="block text-xs font-medium text-slate-700">Bar Ø (mm)</span>
            <input
              className="input mt-1 w-28"
              inputMode="decimal"
              placeholder={`${(stock.barR * 2).toFixed(0)} est.`}
              aria-label="Bar diameter for simulation"
              value={bar}
              onChange={(e) => setBar(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        <svg
          viewBox={vb}
          className="h-80 w-full sm:h-96"
          role="img"
          aria-label="Machining simulation of the bar being cut"
        >
          <defs>
            <pattern
              id="hatch"
              width="1.6"
              height="1.6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="1.6" height="1.6" className="fill-slate-200" />
              <line x1="0" y1="0" x2="0" y2="1.6" className="stroke-slate-400" strokeWidth="0.35" />
            </pattern>
          </defs>
          {/* chuck jaws behind the part */}
          <rect
            x={zLo}
            y={-stock.barR - 3}
            width={stock.zMin - zLo + 2}
            height={3}
            className="fill-slate-400"
          />
          <rect x={zLo} y={stock.barR} width={stock.zMin - zLo + 2} height={3} className="fill-slate-400" />
          {/* material, upper half and mirrored lower half */}
          <path
            d={path}
            fill="url(#hatch)"
            className="stroke-slate-500"
            strokeWidth="0.15"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path}
            fill="url(#hatch)"
            className="stroke-slate-500"
            strokeWidth="0.15"
            vectorEffect="non-scaling-stroke"
            transform="scale(1,-1)"
          />
          {/* spindle axis */}
          <line
            x1={zLo}
            x2={zHi}
            y1={0}
            y2={0}
            className="stroke-slate-500"
            strokeDasharray="4 1.5 1 1.5"
            strokeWidth="0.25"
          />
          {/* path travelled so far */}
          {trail.map((m, k) => (
            <line
              key={k}
              x1={m.from[0]}
              y1={-Math.abs(m.from[1])}
              x2={m.to[0]}
              y2={-Math.abs(m.to[1])}
              className={m.seg.kind === 'rapid' ? 'stroke-slate-400' : 'stroke-brand-600'}
              strokeWidth={m.seg.kind === 'rapid' ? 0.15 : 0.25}
              strokeDasharray={m.seg.kind === 'rapid' ? '1 1' : undefined}
              opacity={0.7}
            />
          ))}
          {/* chips */}
          {chipsRef.current.map((c, k) => (
            <circle
              key={k}
              cx={c.z}
              cy={c.y}
              r={0.3}
              className="fill-slate-600"
              opacity={Math.max(0, c.life / 0.7)}
            />
          ))}
          {pos && tool && <ToolShape point={pos.point} tool={tool} />}
          {pos && (
            <circle cx={pos.point[0]} cy={-Math.abs(pos.point[1])} r={0.45} className="fill-brand-600" />
          )}
        </svg>
      </div>

      {/* readout */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4" aria-live="off">
        <div>
          <span className="block text-xs text-slate-600">Block</span>
          <span className="font-medium tabular-nums" data-testid="sim-block">
            {blockIdx + 1} / {timeline.blocks.length}
          </span>
        </div>
        <div>
          <span className="block text-xs text-slate-600">Tool</span>
          <span className="font-medium">
            {pos?.move.seg.tool ? `T${String(pos.move.seg.tool).padStart(2, '0')}` : '–'}{' '}
            <span className="text-slate-600">{pos?.move.seg.label || ''}</span>
          </span>
        </div>
        <div>
          <span className="block text-xs text-slate-600">Position</span>
          <span className="font-mono text-xs font-medium tabular-nums">
            {pos ? `X${(Math.abs(pos.point[1]) * 2).toFixed(3)} Z${pos.point[0].toFixed(3)}` : '–'}
          </span>
        </div>
        <div>
          <span className="block text-xs text-slate-600">Move</span>
          <span className={pos?.move.seg.kind === 'feed' ? 'badge-blue' : 'badge-gray'}>
            {pos?.move.seg.kind === 'feed' ? 'Cutting (feed)' : 'Rapid'}
          </span>
        </div>
      </div>
      {blockInfo && (
        <p className="truncate font-mono text-xs text-slate-700">
          line {blockInfo.line}: <span className="rounded bg-slate-100 px-1">{blockInfo.text}</span>
        </p>
      )}

      {/* controls */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-primary"
          onClick={() => {
            if (done) resetTo(0);
            setPlaying((p) => !p);
          }}
          aria-label={playing ? 'Pause simulation' : 'Play simulation'}
        >
          {playing ? (
            <Pause className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
          {playing ? 'Pause' : done ? 'Play again' : 'Play'}
        </button>
        <button className="btn" onClick={() => seekBlock(-1)} aria-label="Previous block">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button className="btn" onClick={() => seekBlock(1)} aria-label="Next block">
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          className="btn"
          onClick={() => {
            setPlaying(false);
            resetTo(0);
          }}
          aria-label="Restart simulation"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </button>
        <div
          className="ml-1 flex rounded-lg border border-slate-300 p-0.5"
          role="radiogroup"
          aria-label="Simulation speed"
        >
          {SPEEDS.map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={speed === s}
              className={`min-h-9 rounded-md px-2.5 text-sm font-medium ${speed === s ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
        <input
          type="range"
          className="min-w-40 flex-1 accent-brand-600"
          min={0}
          max={1000}
          value={pct}
          aria-label="Simulation progress"
          aria-valuetext={`Block ${blockIdx + 1} of ${timeline.blocks.length}`}
          onChange={(e) => {
            setPlaying(false);
            resetTo((Number(e.target.value) / 1000) * timeline.duration);
          }}
        />
      </div>
      <p className="text-xs text-slate-600">
        {stock.estimated ? 'Bar size estimated from the cuts; enter the real bar Ø above. ' : ''}
        {op > 1
          ? 'Shown on a fresh bar: cuts from the earlier operation are not carried over after re-clamping. '
          : ''}
        Drills, boring bars and parting tools are recognised from the tool names in the program comments.
      </p>
    </section>
  );
}
