import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Circle,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useA11y } from '../a11y/A11yContext';
import { simulate } from '../sim/lathe/client';
import { makeStepper, materialAt } from '../sim/lathe/engine';
import type { ColourMode, LatheScene, ViewName } from '../sim/lathe/scene';
import { Stock } from '../sim/lathe/stock';
import type { Point, SimCheck, SimInput, SimMove, SimResult } from '../sim/lathe/types';

const SPEEDS = [0.5, 1, 2, 5, 10, 25, 50];
const VIEWS: { key: ViewName; label: string }[] = [
  { key: 'iso', label: 'Iso' },
  { key: 'front', label: 'Front' },
  { key: 'top', label: 'Top' },
  { key: 'section', label: 'Section' },
  { key: 'follow', label: 'Follow tool' },
];
const OP_SWATCH: Record<string, string> = {
  Face: '#e5e7eb',
  Rough: '#cbd5e1',
  Finish: '#f8fafc',
  Groove: '#fcd34d',
  Thread: '#a5f3fc',
  Drill: '#c4b5fd',
  Bore: '#93c5fd',
  'Part-off': '#fca5a5',
  Other: '#d1d5db',
};

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m ? `${m}:${sec.toFixed(1).padStart(4, '0')}` : `${sec.toFixed(1)} s`;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Index of the move active at timeline time t. */
function moveIndexAt(moves: SimMove[], t: number): number {
  let lo = 0;
  let hi = moves.length - 1;
  if (hi < 0) return -1;
  if (t >= moves[hi].t1) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (moves[mid].t1 <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const GcodeLine = memo(function GcodeLine({
  n,
  text,
  active,
  mark,
  onClick,
}: {
  n: number;
  text: string;
  active: boolean;
  mark: 'error' | 'warning' | null;
  onClick: (n: number) => void;
}) {
  return (
    <button
      type="button"
      data-line={n}
      onClick={() => onClick(n)}
      className={`flex w-full gap-2 px-2 text-left font-mono text-xs leading-5 ${
        active ? 'bg-amber-300 text-slate-900' : 'text-slate-200 hover:bg-slate-700'
      }`}
      aria-current={active ? 'true' : undefined}
    >
      <span className="w-8 shrink-0 text-right text-slate-500">{n}</span>
      <span className="truncate">{text || ' '}</span>
      {mark && (
        <span className={`ml-auto shrink-0 ${mark === 'error' ? 'text-rose-400' : 'text-amber-400'}`}>●</span>
      )}
    </button>
  );
});

export interface LatheSim3DProps {
  input: SimInput;
  /** Told when the simulation result is ready (approval uses `blocked`). */
  onResult?: (r: SimResult) => void;
  title?: string;
}

export default function LatheSim3D({ input, onResult, title = '3D machining simulation' }: LatheSim3DProps) {
  const { prefs } = useA11y();
  const calm = prefs.reduceMotion || prefersReducedMotion();
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [view, setView] = useState<ViewName>('iso');
  const [section, setSection] = useState(false);
  const [colour, setColour] = useState<ColourMode>('ops');
  const [showPath, setShowPath] = useState(true);
  const [recording, setRecording] = useState(false);
  const [hud, setHud] = useState({ t: 0, move: 0 });
  const [gotoLine, setGotoLine] = useState('');

  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<LatheScene | null>(null);
  const tRef = useRef(0);
  const matRef = useRef<Stock | null>(null);
  const verRef = useRef(0);
  const appliedRef = useRef({ move: 0, frac: 0 });
  const stepperRef = useRef<ReturnType<typeof makeStepper> | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  // Run the simulation (worker).
  useEffect(() => {
    let alive = true;
    setResult(null);
    setError(null);
    setPlaying(false);
    simulate(input)
      .then((r) => {
        if (!alive) return;
        setResult(r);
        onResultRef.current?.(r);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [input]);

  /** Put the material and time at t (from the nearest snapshot). */
  const seek = useCallback(
    (t: number) => {
      if (!result) return;
      const tt = Math.max(0, Math.min(t, result.duration));
      tRef.current = tt;
      const i = moveIndexAt(result.moves, tt);
      const m = result.moves[i];
      const f = m && m.t1 > m.t0 ? Math.min(1, Math.max(0, (tt - m.t0) / (m.t1 - m.t0))) : 1;
      const g = result.grid;
      const mat = matRef.current ?? new Stock(g.zMin, g.zMax, g.res, g.barR, g.faceZ);
      matRef.current = materialAt(result, input, Math.max(0, i), f, mat);
      appliedRef.current = { move: Math.max(0, i), frac: f };
      stepperRef.current = makeStepper(input);
      verRef.current++;
      sceneRef.current?.resetDrop();
      setHud({ t: tt, move: Math.max(0, i) });
    },
    [result, input],
  );

  // New result: start at the beginning.
  useEffect(() => {
    if (!result) return;
    matRef.current = null;
    seek(0);
  }, [result, seek]);

  // 3D scene (three.js loads only now).
  useEffect(() => {
    if (!result || !viewRef.current) return;
    let disposed = false;
    let scene: LatheScene | null = null;
    let ro: ResizeObserver | null = null;
    import('../sim/lathe/scene')
      .then(({ LatheScene }) => {
        if (disposed || !viewRef.current) return;
        try {
          scene = new LatheScene(viewRef.current);
        } catch {
          setGlError(
            'The 3D view needs WebGL, which this browser does not offer. Checks and times below still apply.',
          );
          return;
        }
        scene.calm = calm;
        scene.setResult(result, input);
        sceneRef.current = scene;
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(() => scene?.resize());
          ro.observe(viewRef.current);
        }
      })
      .catch(() => setGlError('The 3D view could not be loaded.'));
    return () => {
      disposed = true;
      ro?.disconnect();
      scene?.dispose();
      sceneRef.current = null;
    };
  }, [result, input, calm]);

  useEffect(() => {
    sceneRef.current?.setView(view);
    if (view === 'section') setSection(true);
  }, [view, glError]);
  useEffect(() => sceneRef.current?.setSection(section), [section]);
  useEffect(() => sceneRef.current?.setColourMode(colour), [colour]);
  useEffect(() => sceneRef.current?.setPathVisible(showPath), [showPath]);

  // Render / play loop.
  useEffect(() => {
    if (!result) return;
    let raf = 0;
    let last = performance.now();
    let lastHud = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      let removed = 0;
      if (playing) {
        const t = Math.min(result.duration, tRef.current + dt * speed);
        tRef.current = t;
        const target = moveIndexAt(result.moves, t);
        const tm = result.moves[target];
        const tf = tm && tm.t1 > tm.t0 ? Math.min(1, (t - tm.t0) / (tm.t1 - tm.t0)) : 1;
        const mat = matRef.current;
        const step = stepperRef.current;
        if (mat && step) {
          let { move, frac } = appliedRef.current;
          while (move <= target) {
            const end = move === target ? tf : 1;
            removed += step(mat, result.moves[move], end, frac);
            if (move === target) {
              frac = Math.max(frac, end);
              break;
            }
            move++;
            frac = 0;
          }
          appliedRef.current = { move, frac };
          if (removed > 0) verRef.current++;
        }
        if (t >= result.duration) setPlaying(false);
      }
      const t = tRef.current;
      const i = Math.max(0, moveIndexAt(result.moves, t));
      const m = result.moves[i] ?? null;
      let pos: Point | null = null;
      if (m) {
        const f = m.t1 > m.t0 ? Math.min(1, Math.max(0, (t - m.t0) / (m.t1 - m.t0))) : 1;
        pos = [m.from[0] + (m.to[0] - m.from[0]) * f, m.from[1] + (m.to[1] - m.from[1]) * f];
      }
      if (sceneRef.current && matRef.current)
        sceneRef.current.frame(
          {
            mat: matRef.current,
            matVersion: verRef.current,
            move: m,
            pos,
            cutting: !!m && (m.kind === 'feed' || m.kind === 'thread'),
            removed,
            playing,
            speed,
          },
          dt,
        );
      if (now - lastHud > 110 || !playing) {
        lastHud = now;
        setHud((h) => (h.t === t && h.move === i ? h : { t, move: i }));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [result, playing, speed]);

  // Keep the running line in view inside the code pane (not the page).
  const move = result?.moves[hud.move];
  const activeLine = move?.line ?? null;
  useEffect(() => {
    const pane = codeRef.current;
    if (!pane || activeLine === null) return;
    const el = pane.querySelector<HTMLElement>(`[data-line="${activeLine}"]`);
    if (!el) return;
    const top = el.offsetTop - pane.offsetTop;
    if (top < pane.scrollTop || top > pane.scrollTop + pane.clientHeight - 24)
      pane.scrollTop = Math.max(0, top - pane.clientHeight / 3);
  }, [activeLine]);

  const lineMarks = useMemo(() => {
    const map = new Map<number, 'error' | 'warning'>();
    for (const c of result?.checks ?? [])
      if (c.line !== null && map.get(c.line) !== 'error') map.set(c.line, c.severity);
    return map;
  }, [result]);

  const jumpLine = useCallback(
    (line: number) => {
      if (!result) return;
      setPlaying(false);
      const m = result.moves.find((x) => x.line >= line);
      if (m) seek(m.t0 + 1e-9);
    },
    [result, seek],
  );

  const jumpCheck = (c: SimCheck) => {
    setPlaying(false);
    if (c.time !== null) seek(c.time + 1e-9);
  };

  function step(dir: -1 | 1) {
    if (!result) return;
    setPlaying(false);
    const i = moveIndexAt(result.moves, tRef.current);
    const next = Math.max(0, Math.min(result.moves.length - 1, i + dir));
    seek(dir > 0 ? result.moves[next].t1 : result.moves[next].t0 + 1e-9);
  }

  function screenshot() {
    const c = sceneRef.current?.canvas();
    if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = 'lathe-simulation.png';
    a.click();
  }

  function toggleRecord() {
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    const c = sceneRef.current?.canvas();
    if (!c || typeof MediaRecorder === 'undefined' || !c.captureStream) return;
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      a.download = 'lathe-simulation.webm';
      a.click();
      recRef.current = null;
      setRecording(false);
    };
    rec.start();
    recRef.current = rec;
    setRecording(true);
  }

  if (error) return <p className="text-sm text-rose-800">Simulation failed: {error}</p>;
  if (!result) return <p className="text-sm text-slate-600">Simulating the program…</p>;

  const errors = result.checks.filter((c) => c.severity === 'error');
  const warnings = result.checks.filter((c) => c.severity === 'warning');
  const t = hud.t;
  const done = t >= result.duration - 1e-6;
  const elapsedReal = result.moves.slice(0, hud.move).reduce((s, m) => s + (m.realTime ?? 0), 0);
  const tool = move?.tool != null ? input.tools.find((x) => x.number === move.tool) : undefined;
  const g = result.grid;
  let pos: Point | null = null;
  if (move) {
    const f = move.t1 > move.t0 ? Math.min(1, Math.max(0, (t - move.t0) / (move.t1 - move.t0))) : 1;
    pos = [move.from[0] + (move.to[0] - move.from[0]) * f, move.from[1] + (move.to[1] - move.from[1]) * f];
  }
  const unk = (v: string | number | null | undefined, unit = '') =>
    v === null || v === undefined || v === '' ? (
      <span className="font-semibold text-amber-700">unknown</span>
    ) : (
      `${v}${unit}`
    );
  const hudItem = (label: string, value: React.ReactNode) => (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="font-mono text-xs text-white tabular-nums">{value}</div>
    </div>
  );

  return (
    <section className="space-y-3 rounded border bg-white p-4" aria-labelledby="sim3d-title" ref={wrapRef}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="sim3d-title" className="font-semibold">
            {title}
          </h2>
          <p className="text-xs text-slate-600">
            {input.machine.name} · {result.moves.length} moves · cycle time{' '}
            <strong>
              {result.realTimePartial ? '≥ ' : ''}
              {fmtTime(result.realTime)}
            </strong>
          </p>
        </div>
        <p
          role="status"
          data-testid="sim-verdict"
          className={errors.length ? 'badge-red' : warnings.length ? 'badge-amber' : 'badge-green'}
        >
          {errors.length
            ? `${errors.length} simulation error${errors.length > 1 ? 's' : ''}: approval blocked`
            : warnings.length
              ? `No errors · ${warnings.length} warning${warnings.length > 1 ? 's' : ''}`
              : 'No simulation errors or warnings'}
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
        {/* 3D view + HUD */}
        <div className="relative overflow-hidden rounded-lg bg-slate-900" style={{ aspectRatio: '16 / 9' }}>
          <div ref={viewRef} className="absolute inset-0" data-testid="sim-canvas" />
          {glError && (
            <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-slate-200">
              {glError}
            </p>
          )}
          <div className="pointer-events-none absolute left-2 top-2 grid grid-cols-3 gap-x-4 gap-y-1 rounded bg-slate-900/75 p-2 sm:grid-cols-6">
            {hudItem('Line', move ? move.line : '–')}
            {hudItem('Tool', move?.tool != null ? `T${String(move.tool).padStart(2, '0')}` : '–')}
            {hudItem('X (Ø)', pos ? (pos[1] * 2).toFixed(3) : '–')}
            {hudItem('Z', pos ? pos[0].toFixed(3) : '–')}
            {hudItem('rpm', move?.rpm != null ? Math.round(move.rpm) : '–')}
            {hudItem('Vc m/min', move?.vc != null ? Math.round(move.vc) : '–')}
            {hudItem('mm/rev', move?.feedRev != null ? move.feedRev.toFixed(3) : '–')}
            {hudItem('mm/min', move?.feedMin != null ? Math.round(move.feedMin) : '–')}
            {hudItem('Coolant', move?.coolant ? 'ON' : 'off')}
            {hudItem('Cycle', move?.cycle ?? '–')}
            {hudItem('Op', move?.op ?? '–')}
            {hudItem(
              'Time',
              `${fmtTime(elapsedReal)} / ${result.realTimePartial ? '≥' : ''}${fmtTime(result.realTime)}`,
            )}
          </div>
          <div className="absolute right-2 top-2 flex gap-1">
            <button
              className="rounded bg-slate-800/80 p-1.5 text-white hover:bg-slate-700"
              onClick={screenshot}
              aria-label="Screenshot"
              title="Screenshot"
            >
              <Camera className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              className={`rounded p-1.5 text-white ${recording ? 'bg-rose-600' : 'bg-slate-800/80 hover:bg-slate-700'}`}
              onClick={toggleRecord}
              aria-label={recording ? 'Stop recording' : 'Record video'}
              title={recording ? 'Stop recording' : 'Record video'}
            >
              {recording ? (
                <Square className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Circle className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
            <button
              className="rounded bg-slate-800/80 p-1.5 text-white hover:bg-slate-700"
              onClick={() => void wrapRef.current?.requestFullscreen?.()}
              aria-label="Fullscreen"
              title="Fullscreen"
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {move && !move.known && (
            <p className="absolute bottom-2 left-2 rounded bg-amber-500/90 px-2 py-0.5 text-xs text-slate-900">
              Start position unknown (before the first known point): tool shown parked
            </p>
          )}
          {g.chuckZ === null && (
            <p className="absolute bottom-2 right-2 rounded bg-amber-500/90 px-2 py-0.5 text-xs text-slate-900">
              Chuck position unknown (shown faded)
            </p>
          )}
        </div>

        {/* G-code pane */}
        <div
          ref={codeRef}
          className="relative h-64 overflow-auto rounded-lg bg-slate-800 py-1 lg:h-auto lg:max-h-[min(60vh,520px)]"
          aria-label="Program"
        >
          {result.lines.map((text, k) => (
            <GcodeLine
              key={k}
              n={k + 1}
              text={text}
              active={activeLine === k + 1}
              mark={lineMarks.get(k + 1) ?? null}
              onClick={jumpLine}
            />
          ))}
        </div>
      </div>

      {/* controls */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-primary"
          onClick={() => {
            if (done) seek(0);
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
        <button className="btn" onClick={() => step(-1)} aria-label="Previous move">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button className="btn" onClick={() => step(1)} aria-label="Next move">
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          className="btn"
          onClick={() => {
            setPlaying(false);
            seek(0);
          }}
          aria-label="Restart simulation"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </button>
        <label className="text-sm">
          <span className="sr-only">Speed</span>
          <select
            className="input w-24"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            aria-label="Simulation speed"
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(gotoLine);
            if (n > 0) jumpLine(n);
          }}
        >
          <input
            className="input w-24"
            inputMode="numeric"
            placeholder="Line"
            aria-label="Jump to line"
            value={gotoLine}
            onChange={(e) => setGotoLine(e.target.value)}
          />
          <button className="btn" type="submit">
            Go
          </button>
        </form>
        <div
          className="flex flex-wrap rounded-lg border border-slate-300 p-0.5"
          role="radiogroup"
          aria-label="Camera"
        >
          {VIEWS.map((v) => (
            <button
              key={v.key}
              role="radio"
              aria-checked={view === v.key}
              className={`min-h-8 rounded-md px-2 text-xs font-medium ${view === v.key ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={section} onChange={(e) => setSection(e.target.checked)} /> Half
          section
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={showPath} onChange={(e) => setShowPath(e.target.checked)} /> Tool
          path
        </label>
        {result.compare && (
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={colour === 'compare'}
              onChange={(e) => setColour(e.target.checked ? 'compare' : 'ops')}
            />{' '}
            Compare with drawing
          </label>
        )}
      </div>

      {/* scrub bar with check markers */}
      <div className="relative pt-3">
        <div className="absolute inset-x-0 top-0 h-3">
          {result.checks
            .filter((c) => c.time !== null)
            .map((c, k) => (
              <button
                key={k}
                type="button"
                title={`line ${c.line}: ${c.message}`}
                aria-label={`${c.severity} at line ${c.line}: ${c.message}`}
                onClick={() => jumpCheck(c)}
                className={`absolute top-0 h-3 w-1.5 -translate-x-1/2 rounded-sm ${c.severity === 'error' ? 'bg-rose-600' : 'bg-amber-500'}`}
                style={{ left: `${((c.time as number) / Math.max(result.duration, 1e-9)) * 100}%` }}
                data-testid={`marker-${c.severity}`}
              />
            ))}
        </div>
        <input
          type="range"
          className="w-full accent-brand-600"
          min={0}
          max={1000}
          value={result.duration ? Math.round((t / result.duration) * 1000) : 0}
          aria-label="Simulation progress"
          aria-valuetext={`Line ${activeLine ?? '-'}, ${fmtTime(elapsedReal)}`}
          onChange={(e) => {
            setPlaying(false);
            seek((Number(e.target.value) / 1000) * result.duration);
          }}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {/* operations */}
        <div>
          <h3 className="mb-1 text-sm font-semibold">Operations</h3>
          <ul className="space-y-1 text-sm">
            {result.ops
              .filter((o) => o.op !== 'Other' || o.time > 0.5)
              .map((o, k) => (
                <li key={k}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-slate-100 ${
                      hud.move >= o.firstMove && hud.move <= o.lastMove ? 'bg-slate-100 font-medium' : ''
                    }`}
                    onClick={() => {
                      setPlaying(false);
                      seek(result.moves[o.firstMove].t0 + 1e-9);
                    }}
                  >
                    <span
                      className="inline-block h-3 w-3 rounded-sm border"
                      style={{ background: OP_SWATCH[o.op] }}
                    />
                    <span>{o.op}</span>
                    <span className="text-xs text-slate-500">
                      {o.tool !== null ? `T${String(o.tool).padStart(2, '0')}` : ''}
                    </span>
                    <span className="ml-auto tabular-nums text-slate-700">
                      {o.partial ? '≥ ' : ''}
                      {fmtTime(o.time)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
        {/* checks */}
        <div className="md:col-span-2">
          <h3 className="mb-1 text-sm font-semibold">
            Checks{' '}
            <span className="text-xs font-normal text-slate-600">
              ({errors.length} error{errors.length === 1 ? '' : 's'}, {warnings.length} warning
              {warnings.length === 1 ? '' : 's'})
            </span>
          </h3>
          {result.checks.length === 0 ? (
            <p className="text-sm text-emerald-800">No problems found by the simulation.</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-auto text-xs" data-testid="sim-checks">
              {result.checks.map((c, k) => (
                <li key={k}>
                  <button
                    type="button"
                    disabled={c.time === null}
                    onClick={() => jumpCheck(c)}
                    className={`flex w-full gap-2 rounded border px-2 py-1 text-left ${
                      c.severity === 'error'
                        ? 'border-rose-200 bg-rose-50 text-rose-900'
                        : 'border-amber-200 bg-amber-50 text-amber-900'
                    }`}
                  >
                    <span className="shrink-0 font-semibold uppercase">{c.severity}</span>
                    {c.line !== null && <span className="shrink-0 font-mono">line {c.line}</span>}
                    <span>{c.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {result.compare && (
            <p className="mt-1 text-xs text-slate-700">Drawing compare: {result.compare.summary}</p>
          )}
        </div>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Setup used by the simulation</summary>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            <dt>Bar Ø</dt>
            <dd>{unk(input.stock.diameter, ' mm')}</dd>
            <dt>Bar length</dt>
            <dd>{unk(input.stock.length, ' mm')}</dd>
            <dt>Stick-out</dt>
            <dd>{unk(input.stock.stickOut, ' mm')}</dd>
            <dt>Bar face Z</dt>
            <dd>{unk(input.stock.faceZ)}</dd>
            <dt>Material</dt>
            <dd>{unk(input.material)}</dd>
            <dt>X travel (Ø)</dt>
            <dd>{unk(input.machine.travelX?.join(' … '))}</dd>
            <dt>Z travel</dt>
            <dd>{unk(input.machine.travelZ?.join(' … '))}</dd>
            <dt>Max rpm</dt>
            <dd>{unk(input.machine.maxRpm)}</dd>
            <dt>Rapid rate</dt>
            <dd>{unk(input.machine.rapidRate, ' mm/min')}</dd>
          </dl>
          <table className="text-xs">
            <thead>
              <tr className="text-left text-slate-600">
                <th className="pr-2">T</th>
                <th className="pr-2">Tool</th>
                <th className="pr-2">Insert</th>
                <th className="pr-2">r</th>
                <th>Holder</th>
              </tr>
            </thead>
            <tbody>
              {input.tools.map((x) => (
                <tr key={x.number} className={tool?.number === x.number ? 'bg-amber-50' : ''}>
                  <td className="pr-2 font-mono">T{String(x.number).padStart(2, '0')}</td>
                  <td className="pr-2">
                    {x.name} <span className="text-slate-500">({x.role})</span>
                  </td>
                  <td className="pr-2">
                    {x.role === 'drill'
                      ? unk(x.drillDiameter, ' mm drill')
                      : x.role === 'groove' || x.role === 'part'
                        ? unk(x.width, ' mm wide')
                        : x.role === 'thread'
                          ? unk(x.threadAngle, '°')
                          : unk(x.shape)}
                  </td>
                  <td className="pr-2">{x.role === 'od' || x.role === 'bore' ? unk(x.noseRadius) : '–'}</td>
                  <td>{unk(x.holder)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="rounded bg-slate-50 p-2 text-xs text-slate-600" data-testid="sim-disclaimer">
        Advisory only. This simulation is a visual and arithmetic aid: the bar is modelled as a turned
        profile, nose radius compensation is approximated and machine dynamics are ignored. It never changes
        the program and never sends anything to the machine. Simulation errors block approval; a clean
        simulation does not prove the program is safe - prove out the first part at the machine.
      </p>
    </section>
  );
}
