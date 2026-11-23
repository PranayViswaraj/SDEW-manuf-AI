import { useEffect, useRef } from 'react';
import { defineCncSimulator, type CncSimulator } from './element';
import type { SimCheck } from './job';

defineCncSimulator();

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'cnc-simulator': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        'program-url'?: string;
        speed?: string | number;
        autoplay?: boolean;
      };
    }
  }
}

/** React wrapper for <cnc-simulator>. Events: progress, line, operation, finished, warning, checks. */
export default function CncSimulatorView({
  programUrl,
  programText,
  speed = 10,
  autoplay = false,
  height = 680,
  stock,
  onEvent,
  onChecks,
}: {
  /** Fetch the program from a URL... */
  programUrl?: string;
  /** ...or give its text directly (e.g. a program just generated). */
  programText?: string;
  speed?: number;
  autoplay?: boolean;
  height?: number;
  /** The part's bar (diameter) and finished length, mm: the simulation cuts this bar. */
  stock?: { diameter?: number | null; length?: number | null };
  onEvent?: (type: string, detail: unknown) => void;
  /** Safety checks once the program is simulated. */
  onChecks?: (checks: SimCheck[], errors: number) => void;
}) {
  const ref = useRef<CncSimulator | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onEvent) return;
    const types = ['progress', 'line', 'operation', 'finished', 'warning', 'checks'];
    const fns = types.map((t) => {
      const fn = (e: Event) => onEvent(t, (e as CustomEvent).detail);
      el.addEventListener(t, fn);
      return fn;
    });
    return () => types.forEach((t, k) => el.removeEventListener(t, fns[k]));
  }, [onEvent]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onChecks) return;
    const fn = (e: Event) => {
      const d = (e as CustomEvent<{ checks: SimCheck[]; errors: number }>).detail;
      onChecks(d.checks, d.errors);
    };
    el.addEventListener('checks', fn);
    return () => el.removeEventListener('checks', fn);
  }, [onChecks]);
  // before the program effect, so the first run already cuts the right bar
  const dia = stock?.diameter ?? null;
  const len = stock?.length ?? null;
  useEffect(() => {
    ref.current?.setStock?.({ diameter: dia, length: len });
  }, [dia, len]);
  useEffect(() => {
    if (programText) void ref.current?.loadProgram(programText);
  }, [programText]);
  return (
    <div style={{ height, minHeight: 520 }}>
      <cnc-simulator
        ref={ref as unknown as React.Ref<HTMLElement>}
        program-url={programUrl || undefined}
        speed={String(speed)}
        {...(autoplay ? { autoplay: true } : {})}
      />
    </div>
  );
}
