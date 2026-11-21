import { lazy, Suspense, useMemo, useState } from 'react';
import LatheSim3D from '../components/LatheSim3D';
import { BAD_PROGRAM, DEMO_PROGRAM, demoInput } from '../sim/lathe/demo';
import type { SimResult } from '../sim/lathe/types';

// <cnc-simulator> (three.js) loads only on this page.
const CncSimulatorView = lazy(() => import('../cnc-sim/CncSimulatorView'));

/** 3D lathe simulation on the fictional SIM Lathe, with demo programs only. */
export default function LatheSimDemo() {
  const [which, setWhich] = useState<'good' | 'bad'>('good');
  const [result, setResult] = useState<SimResult | null>(null);
  const [approved, setApproved] = useState(false);
  const input = useMemo(() => demoInput(which === 'good' ? DEMO_PROGRAM : BAD_PROGRAM), [which]);
  const blocked = !result || result.blocked;

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">O0003 · 3227C07701 BOSS-SUCTION PIPE</h2>
        <Suspense fallback={<p className="text-sm text-slate-600">Loading the simulator…</p>}>
          <CncSimulatorView programUrl={`${import.meta.env.BASE_URL}samples/O0003.nc`} speed={10} />
        </Suspense>
      </section>
      <div>
        <h1 className="text-xl font-semibold">Lathe simulation (demo)</h1>
        <p className="text-sm text-slate-600">
          Synthetic programs on the fictional <strong>SIM Lathe</strong> - not for machine use. Pick a program
          and press Play.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Demo program">
        {(['good', 'bad'] as const).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={which === k}
            className={which === k ? 'btn-primary' : 'btn'}
            onClick={() => {
              setWhich(k);
              setResult(null);
              setApproved(false);
            }}
          >
            {k === 'good' ? 'O9100 demo part (face … part-off)' : 'O9101 deliberately bad program'}
          </button>
        ))}
      </div>
      <LatheSim3D input={input} onResult={setResult} />
      <div className="space-y-1 rounded border bg-white p-4">
        <button
          className="btn-primary"
          disabled={blocked || approved}
          onClick={() => setApproved(true)}
          data-testid="demo-approve"
        >
          {approved ? 'Approved (demo only, nothing saved)' : 'Approve program'}
        </button>
        {result?.blocked && (
          <p className="text-sm text-rose-800">
            Approval blocked: the simulation found{' '}
            {result.checks.filter((c) => c.severity === 'error').length} error(s).
          </p>
        )}
      </div>
    </div>
  );
}
