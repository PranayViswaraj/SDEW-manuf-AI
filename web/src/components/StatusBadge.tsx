import type { LiveState, LiveStatus } from '../api/types';
import { useLiveStatus } from '../hooks/useLiveStatus';

const LABEL: Record<LiveState, string> = {
  online: 'Online',
  machine_unreachable: 'Machine unreachable',
  stale: 'Stale',
  offline: 'Offline',
};
const CLS: Record<LiveState, string> = {
  online: 'badge-green',
  machine_unreachable: 'badge-red',
  stale: 'badge-amber',
  offline: 'badge-red',
};

export function LiveBadge({ live }: { live: LiveStatus | null }) {
  if (!live) return <span className="badge-gray">Checking…</span>;
  const title =
    live.state === 'stale'
      ? `No update for ${live.age_s ?? '?'} s (limit ${live.stale_after_s} s)`
      : live.state === 'offline'
        ? live.bridge_id
          ? `Bridge "${live.bridge_id}" is not connected`
          : 'No bridge assigned to this machine'
        : (live.error ?? '');
  return (
    <span className="inline-flex items-center gap-1">
      <span className={CLS[live.state]} title={title} data-testid="live-badge">
        {LABEL[live.state]}
      </span>
      {live.driver === 'simulated' && live.state !== 'offline' && (
        <span className="badge-blue" title="This machine is driven by the simulator, not a real CNC">
          SIMULATED
        </span>
      )}
    </span>
  );
}

export function MachineLiveBadge({ machineId }: { machineId: number }) {
  const { live } = useLiveStatus(machineId, 2000);
  return <LiveBadge live={live} />;
}
