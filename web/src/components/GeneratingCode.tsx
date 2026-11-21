import { FileCode2, FastForward } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Line } from './GcodeView';

/**
 * Shows a freshly generated program being written out, line by line, then hands over to the
 * normal program view. Purely visual: the text is already complete and checked; nothing here
 * changes it. Fast (at most ~3 s) and skippable; skipped entirely when `animate` is false.
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
  const [shown, setShown] = useState(animate ? 0 : lines.length);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const boxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!animate) {
      doneRef.current();
      return;
    }
    const total = Math.min(3000, Math.max(700, lines.length * 22));
    const frames = Math.max(1, Math.round(total / 16));
    let frame = 0;
    let finish = 0;
    const timer = window.setInterval(() => {
      frame++;
      const n = Math.min(lines.length, Math.ceil((frame / frames) * lines.length));
      setShown(n);
      if (n >= lines.length) {
        window.clearInterval(timer);
        finish = window.setTimeout(() => doneRef.current(), 250);
      }
    }, 16);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(finish);
    };
  }, [animate, lines.length]);

  // Keep the newest line in view inside the box (not the page).
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [shown]);

  // The operation being written: the last block comment like N2(FINISH OD).
  const current = useMemo(() => {
    for (let i = Math.min(shown, lines.length) - 1; i >= 0; i--) {
      const m = lines[i].match(/^N\d+\s*\(([^)]*)\)/);
      if (m) return m[1].trim();
    }
    return 'program header';
  }, [shown, lines]);

  const pct = lines.length ? Math.round((Math.min(shown, lines.length) / lines.length) * 100) : 100;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-950" aria-busy={pct < 100}>
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-xs text-slate-200">
        <FileCode2 className="h-4 w-4 text-sky-400" aria-hidden="true" />
        <span className="font-medium" role="status">
          {pct < 100 ? `Writing program… ${current}` : 'Program written'}
        </span>
        <span className="ml-auto tabular-nums text-slate-400">
          {Math.min(shown, lines.length)} / {lines.length} lines
        </span>
        {pct < 100 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-slate-100 hover:bg-slate-700"
            onClick={() => {
              setShown(lines.length);
              doneRef.current();
            }}
          >
            <FastForward className="h-3.5 w-3.5" aria-hidden="true" /> Show all
          </button>
        )}
      </div>
      <div className="h-1 bg-slate-800">
        <div className="h-1 bg-sky-500 transition-[width] duration-100" style={{ width: `${pct}%` }} />
      </div>
      <pre
        ref={boxRef}
        aria-label={label}
        className="gcode max-h-96 overflow-auto p-3 font-mono text-xs leading-5 text-slate-100"
      >
        {lines.slice(0, shown).map((ln, i) => (
          <div key={i} className="flex gap-3">
            <span className="w-8 shrink-0 select-none text-right text-slate-500">{i + 1}</span>
            <span>
              <Line text={ln} />
              {i === shown - 1 && pct < 100 && (
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-sky-400 align-middle" />
              )}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}
