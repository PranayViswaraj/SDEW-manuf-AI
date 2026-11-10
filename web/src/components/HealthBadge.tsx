import { useEffect, useState } from 'react';
import { getHealth, type Health } from '../api/client';

type State = { kind: 'loading' } | { kind: 'ok'; health: Health } | { kind: 'error' };

export default function HealthBadge() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((health) => !cancelled && setState({ kind: 'ok', health }))
      .catch(() => !cancelled && setState({ kind: 'error' }));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <span className="rounded bg-gray-200 px-2 py-1 text-sm text-gray-700">Checking server…</span>;
  }
  if (state.kind === 'error' || state.health.status !== 'ok') {
    return (
      <span role="status" className="rounded bg-red-100 px-2 py-1 text-sm text-red-800">
        Server unreachable or database down
      </span>
    );
  }
  return (
    <span role="status" className="rounded bg-green-100 px-2 py-1 text-sm text-green-800">
      Server OK · v{state.health.version}
    </span>
  );
}
