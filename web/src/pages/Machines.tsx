import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Machine } from '../api/types';
import { ErrorBox, NotEntered } from '../components/ui';
import { MachineLiveBadge } from '../components/StatusBadge';

export default function Machines() {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Machine[]>('/machines')
      .then(setMachines)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Machines</h1>
        <p className="text-sm text-gray-600">
          Machine register. Open a machine to see its limits, turret tools and live status.
        </p>
      </div>
      <ErrorBox error={error} />
      {machines && (
        <div className="overflow-x-auto rounded border bg-white">
          <table className="table">
            <thead>
              <tr>
                <th>Machine</th>
                <th>Controller</th>
                <th>IP address</th>
                <th>Live status</th>
                <th>Limits</th>
                <th>Tools</th>
                <th>Remote control</th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link to={`/machines/${m.id}`} className="font-medium text-blue-700 hover:underline">
                      {m.name}
                    </Link>
                    <div className="text-xs text-gray-500">
                      {m.key} · {m.status.replace('_', ' ')}
                    </div>
                  </td>
                  <td>{m.controller}</td>
                  <td className="font-mono text-xs">
                    {m.ip_address ? `${m.ip_address}:${m.focas_port}` : <NotEntered />}
                  </td>
                  <td>
                    <MachineLiveBadge machineId={m.id} />
                  </td>
                  <td>
                    {m.limits_missing.length === 0 ? (
                      <span className="badge-green">All entered</span>
                    ) : (
                      <span className="badge-amber">
                        {m.limits_missing.length === 7
                          ? 'Not entered – from nameplate'
                          : `${m.limits_missing.length} missing`}
                      </span>
                    )}
                  </td>
                  <td>{m.tools.length || <NotEntered what="None" />}</td>
                  <td>
                    {m.remote_control_enabled ? (
                      <span className="badge-amber">Enabled</span>
                    ) : (
                      <span className="badge-gray">Off</span>
                    )}
                  </td>
                </tr>
              ))}
              {machines.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-gray-500">
                    No machines.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
