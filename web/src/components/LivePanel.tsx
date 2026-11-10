import { oNumber, type LiveStatus } from '../api/types';
import { LiveBadge } from './StatusBadge';

const RUN_LABEL: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  feed_hold: 'Feed hold',
  stopped: 'Stopped (program stop)',
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

export default function LivePanel({ live, error }: { live: LiveStatus | null; error?: string | null }) {
  const s = live?.status ?? null;
  const usable = live?.state === 'online' && s;
  return (
    <section className="space-y-3 rounded border bg-white p-4" aria-label="Live machine status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Live status</h2>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <LiveBadge live={live} />
          {live?.age_s !== null && live?.age_s !== undefined && <span>updated {live.age_s} s ago</span>}
        </div>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {live?.state === 'stale' && (
        <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">
          No update from the machine for {live.age_s} s. The values below may be out of date. Check the
          machine.
        </p>
      )}
      {live?.state === 'offline' && (
        <p className="rounded bg-red-50 p-2 text-sm text-red-800">
          {live.bridge_id
            ? `The factory bridge "${live.bridge_id}" is not connected. No live data, and nothing can be sent.`
            : 'No bridge is assigned to this machine yet.'}
        </p>
      )}
      {live?.state === 'machine_unreachable' && (
        <p className="rounded bg-red-50 p-2 text-sm text-red-800">
          The bridge is online but cannot reach the machine: {live.error}
        </p>
      )}
      {s && (
        <div className={`grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 ${usable ? '' : 'opacity-50'}`}>
          <Field label="Mode" value={s.mode} />
          <Field label="Run state" value={RUN_LABEL[s.run_state] ?? s.run_state} />
          <Field label="Program" value={oNumber(s.program_number)} />
          <Field label="Block (N)" value={s.sequence_number ?? '–'} />
          <Field
            label="Spindle"
            value={s.spindle_speed !== null ? `${Math.round(s.spindle_speed)} rpm` : '–'}
          />
          <Field label="Feed override" value={s.feed_override !== null ? `${s.feed_override} %` : '–'} />
          <Field label="Part count" value={s.part_count ?? '–'} />
          <Field
            label="Emergency stop"
            value={s.emergency ? <span className="text-red-700">PRESSED</span> : 'Not pressed'}
          />
        </div>
      )}
      {s && (
        <div className="text-sm">
          <span className="text-xs text-gray-500">Alarms: </span>
          {s.alarms.length === 0 ? (
            <span>None</span>
          ) : (
            <ul className="list-inside list-disc text-red-800">
              {s.alarms.map((a) => (
                <li key={`${a.code}-${a.message}`}>
                  {a.code} {a.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {live && (
        <p className="text-xs text-gray-500">
          Remote control:{' '}
          {live.remote_control_enabled ? 'enabled' : 'off — Cycle Start is pressed at the machine'}.
        </p>
      )}
    </section>
  );
}
