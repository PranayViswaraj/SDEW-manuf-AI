import { useEffect, useRef } from 'react';
import { defineCncSimulator, type CncSimulator } from './element';

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

/** React wrapper for <cnc-simulator>. Events: progress, line, operation, finished, warning. */
export default function CncSimulatorView({
  programUrl,
  speed = 10,
  autoplay = false,
  height = 680,
  onEvent,
}: {
  programUrl: string;
  speed?: number;
  autoplay?: boolean;
  height?: number;
  onEvent?: (type: string, detail: unknown) => void;
}) {
  const ref = useRef<CncSimulator | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onEvent) return;
    const types = ['progress', 'line', 'operation', 'finished', 'warning'];
    const fns = types.map((t) => {
      const fn = (e: Event) => onEvent(t, (e as CustomEvent).detail);
      el.addEventListener(t, fn);
      return fn;
    });
    return () => types.forEach((t, k) => el.removeEventListener(t, fns[k]));
  }, [onEvent]);
  return (
    <div style={{ height, minHeight: 520 }}>
      <cnc-simulator
        ref={ref as unknown as React.Ref<HTMLElement>}
        program-url={programUrl}
        speed={String(speed)}
        {...(autoplay ? { autoplay: true } : {})}
      />
    </div>
  );
}
