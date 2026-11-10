import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

interface Row {
  machine_id: number;
  machine_name: string;
  live_state: string;
  verdict: 'capable' | 'not_capable' | 'unknown';
  summary: string;
  reasons: { check: string; status: 'pass' | 'fail' | 'unknown'; message: string }[];
  excluded_because?: string[];
}

export interface CapabilityResponse {
  part_number: string;
  available: Row[];
  excluded: Row[];
}

const VERDICT_CLS: Record<Row['verdict'], string> = {
  capable: 'badge-green',
  not_capable: 'badge-red',
  unknown: 'badge-amber',
};

export default function CapablePanel({ featureTableId }: { featureTableId: number }) {
  const [data, setData] = useState<CapabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .get<CapabilityResponse>(`/capability?feature_table_id=${featureTableId}`)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [featureTableId]);

  return (
    <section className="space-y-3 rounded border bg-white p-4" aria-label="Machines for this part">
      <div>
        <h2 className="font-semibold">Machines for this part</h2>
        <p className="text-xs text-gray-500">
          Rules only: machine limits, tool list, and live status. Unknown limits are never treated as capable.
        </p>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {data && (
        <>
          <div>
            <h3 className="text-sm font-semibold text-green-800">Capable, online and idle</h3>
            {data.available.length === 0 ? (
              <p className="text-sm text-gray-600">No machine is available for this part right now.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {data.available.map((r) => (
                  <li key={r.machine_id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="badge-green">available</span>
                    <span className="font-medium">{r.machine_name}</span>
                    <Link
                      className="text-blue-700 underline"
                      to={`/programs?machine=${r.machine_id}&part=${encodeURIComponent(data.part_number)}`}
                    >
                      programs
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-700">Not offered</h3>
            <ul className="mt-1 space-y-2">
              {data.excluded.map((r) => (
                <li key={r.machine_id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.machine_name}</span>
                    <span className={VERDICT_CLS[r.verdict]}>{r.verdict.replace('_', ' ')}</span>
                    <span className="text-xs text-gray-500">{r.live_state.replace('_', ' ')}</span>
                  </div>
                  <ul className="ml-4 list-disc text-gray-700">
                    {(r.excluded_because ?? []).map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
