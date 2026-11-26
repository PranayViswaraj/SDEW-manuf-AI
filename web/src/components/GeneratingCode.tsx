import { CheckCircle2, FastForward, Pause, Play, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Line } from './GcodeView';

/** Lines per second at 1×: about 25, but never longer than 8 s or shorter than 1.2 s. */
function rateFor(lines: number) {
  return Math.min(Math.max(lines / 8, 24), lines / 1.2);
}

interface Section {
  title: string;
  line: number; // 0-based first line
}

/** Sections of a program: header, each operation (N-block comment), program end. */
function sectionsOf(lines: string[]): Section[] {
  const out: Section[] = [{ title: 'Header and safety blocks', line: 0 }];
  lines.forEach((ln, i) => {
    const t = ln.trim();
    const m = t.match(/^N\d+\s*\(([^)]*)\)/i) ?? t.match(/^\(([^)]*)\)\s*$/);
    if (m && i > 1) {
      const label = m[1].trim();
      if (label && !/^O\d/.test(label)) out.push({ title: label, line: i });
    }
  });
  const end = lines.findIndex((ln, i) => i > 0 && /\bM(30|02|2)\b/.test(ln.replace(/\([^)]*\)/g, '')));
  if (end > (out[out.length - 1]?.line ?? 0)) out.push({ title: 'Program end', line: end });
  return out;
}

const pretty = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * A freshly generated program being written out live, then handed over to the normal program
 * view. Purely visual: the text is already complete and checked; nothing here changes it.
 * Pause, speed (0.5× / 1× / 2×) and Show all; skipped when `animate` is false.
 */
export default function GeneratingCode({
  text,
  onDone,
  animate = true,
  label = 'Generated program text',
}: {
  text: string;
  onDone: () => void;
  animate?: boolean;
  label?: string;
}) {
  const lines = useMemo(() => text.replace(/\r\n?/g, '\n').split('\n'), [text]);
  const sections = useMemo(() => sectionsOf(lines), [lines]);
  const [pos, setPos] = useState(animate ? 0 : lines.length); // lines written (fractional)
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const finished = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const state = useRef({ paused, speed });
  state.current = { paused, speed };

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    doneRef.current();
  };

  useEffect(() => {
    if (!animate) {
      finish();
      return;
    }
    const rate = rateFor(lines.length);
    const tick = 16;
    let p = 0;
    let t = 0;
    let end = 0;
    const timer = window.setInterval(() => {
      if (state.current.paused) return;
      t += tick / 1000;
      p = Math.min(lines.length, p + (rate * state.current.speed * tick) / 1000);
      setPos(p);
      setElapsed(t);
      if (p >= lines.length) {
        window.clearInterval(timer);
        end = window.setTimeout(finish, 450);
      }
    }, tick);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(end);
    };
  }, [animate, lines.length]);

  const full = Math.floor(pos);
  const done = full >= lines.length;
  const partial = done ? '' : lines[full].slice(0, Math.floor((pos - full) * (lines[full].length + 1)));

  // keep the line being written in view inside the box (not the page)
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [full]);

  const current = sections.reduce((k, s, i) => (s.line <= full ? i : k), 0);
  const pct = lines.length ? Math.min(100, (pos / lines.length) * 100) : 100;

  return (
    <div
      className="overflow-hidden rounded-2xl bg-[#0b1020] shadow-[0_18px_50px_-20px_rgb(2_6_23/0.7)] ring-1 ring-slate-800"
      aria-busy={!done}
    >
      {/* window bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800/80 px-4 py-2.5 text-xs text-slate-300">
        <span className="flex gap-1.5" aria-hidden="true">
          <i className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <i className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <i className="h-3 w-3 rounded-full bg-[#28c840]" />
        </span>
        <span className="flex items-center gap-1.5 font-medium text-slate-100" role="status">
          {done ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4 animate-pulse text-sky-400" aria-hidden="true" />
          )}
          {done ? 'Program written' : paused ? 'Paused' : 'Generating…'}
        </span>
        <span className="tabular-nums text-slate-400">
          {Math.min(full, lines.length)} / {lines.length} lines
        </span>
        <span className="tabular-nums text-slate-500">{elapsed.toFixed(1)} s</span>
        <span className="flex-1" />
        {!done && (
          <>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-slate-800"
              onClick={() => setPaused((v) => !v)}
            >
              {paused ? (
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {paused ? 'Resume' : 'Pause'}
            </button>
            <span
              className="inline-flex rounded-md bg-slate-900 p-0.5 ring-1 ring-slate-800"
              role="group"
              aria-label="Writing speed"
            >
              {[0.5, 1, 2].map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={speed === s}
                  className={`rounded px-2 py-0.5 ${speed === s ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  onClick={() => setSpeed(s)}
                >
                  {s}x
                </button>
              ))}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-slate-800"
              onClick={() => {
                setPos(lines.length);
                finish();
              }}
            >
              <FastForward className="h-3.5 w-3.5" aria-hidden="true" /> Show all
            </button>
          </>
        )}
      </div>
      <div className="h-0.5 bg-slate-800">
        <div className="h-0.5 bg-linear-to-r from-sky-500 to-emerald-400" style={{ width: `${pct}%` }} />
      </div>

      <div className="grid md:grid-cols-[230px_minmax(0,1fr)]">
        {/* sections */}
        <ol
          className="hidden max-h-[420px] space-y-1 overflow-auto border-r border-slate-800/80 p-3 md:block"
          aria-label="Program sections"
        >
          {sections.map((s, i) => {
            const st = done || i < current ? 'done' : i === current ? 'now' : 'todo';
            return (
              <li
                key={`${s.line}-${s.title}`}
                className={`flex gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                  st === 'now'
                    ? 'bg-sky-500/10 text-slate-100 ring-1 ring-sky-500/30'
                    : st === 'done'
                      ? 'text-slate-300'
                      : 'text-slate-500'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    st === 'done'
                      ? 'bg-emerald-500/90 text-slate-950'
                      : st === 'now'
                        ? 'bg-sky-500 text-slate-950'
                        : 'ring-1 ring-slate-600'
                  }`}
                  aria-hidden="true"
                >
                  {st === 'done' ? '✓' : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">
                    {i === 0 || s.title === 'Program end' ? s.title : pretty(s.title)}
                  </span>
                  <span className="font-mono text-[10px] text-slate-500">line {s.line + 1}</span>
                </span>
              </li>
            );
          })}
        </ol>

        {/* code */}
        <div
          ref={boxRef}
          aria-label={label}
          className="gcode max-h-[420px] min-h-[220px] overflow-auto py-2 font-mono text-[13px] leading-6 text-slate-100"
        >
          {lines.slice(0, full).map((ln, i) => (
            <div
              key={i}
              className={`flex gap-4 px-3 ${i === full - 1 && !done && !partial ? 'bg-sky-500/10' : ''}`}
            >
              <span className="w-9 shrink-0 text-right text-slate-600 select-none">{i + 1}</span>
              <span className="whitespace-pre">
                <Line text={ln} />
              </span>
            </div>
          ))}
          {!done && (
            <div className="flex gap-4 border-l-2 border-sky-400 bg-sky-500/10 px-3">
              <span className="w-9 shrink-0 text-right text-sky-300 select-none">{full + 1}</span>
              <span className="whitespace-pre">
                <Line text={partial} />
                <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-sky-400 align-middle" />
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
