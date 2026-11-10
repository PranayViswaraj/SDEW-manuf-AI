import { useEffect, useState } from 'react';
import { getHealth, type Health } from '../api/client';
import { PulseDot } from './motion';

type State = { kind: 'loading' } | { kind: 'ok'; health: Health } | { kind: 'error' };

export default function HealthBadge() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      getHealth()
        .then((health) => !cancelled && setState({ kind: 'ok', health }))
        .catch(() => !cancelled && setState({ kind: 'error' }));
    check();
    const t = window.setInterval(check, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  if (state.kind === 'loading') {
    return <span className="badge-gray">Checking server…</span>;
  }
  if (state.kind === 'error' || state.health.status !== 'ok') {
    return (
      <span role="status" className="badge-red">
        <PulseDot tone="red" />
        Server unreachable or database down
      </span>
    );
  }
  return (
    <span role="status" className="badge-green">
      <PulseDot tone="green" />
      Server OK · v{state.health.version}
    </span>
  );
}
