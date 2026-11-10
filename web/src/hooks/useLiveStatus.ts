import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { LiveStatus } from '../api/types';

/** Poll the live machine status. Network failure shows as offline (never as stale-but-ok). */
export function useLiveStatus(machineId: number | null | undefined, intervalMs = 1000) {
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!machineId) return;
    let cancelled = false;
    const tick = () => {
      api
        .get<LiveStatus>(`/machines/${machineId}/live`)
        .then((d) => {
          if (!cancelled) {
            setLive(d);
            setError(null);
          }
        })
        .catch((e: Error) => {
          if (!cancelled) {
            setError(e.message);
            setLive((prev) => (prev ? { ...prev, state: 'offline', status: null } : prev));
          }
        });
    };
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [machineId, intervalMs]);

  return { live, error };
}
