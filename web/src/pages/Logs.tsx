import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AuditPage } from '../api/types';
import { ErrorBox } from '../components/ui';

const PAGE = 50;

export default function Logs() {
  const [data, setData] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (action.trim()) qs.set('action', action.trim());
    api
      .get<AuditPage>(`/audit-log?${qs}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [action, offset]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Audit log</h1>
          <p className="text-sm text-gray-600">
            Append-only record of every action. Entries cannot be edited.
          </p>
        </div>
        <label className="text-sm">
          Filter by action{' '}
          <input
            className="input inline-block w-48"
            placeholder="e.g. login"
            value={action}
            onChange={(e) => {
              setOffset(0);
              setAction(e.target.value);
            }}
          />
        </label>
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="overflow-x-auto rounded border bg-white">
            <table className="table">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Result</th>
                  <th>Machine</th>
                  <th>Program</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap font-mono text-xs">
                      {a.timestamp.replace('T', ' ').slice(0, 19)}
                    </td>
                    <td>{a.username ?? '–'}</td>
                    <td className="font-mono text-xs">{a.action}</td>
                    <td>
                      <span
                        className={
                          a.result === 'ok'
                            ? 'badge-green'
                            : a.result === 'requested'
                              ? 'badge-gray'
                              : 'badge-red'
                        }
                      >
                        {a.result}
                      </span>
                    </td>
                    <td>{a.machine_id ?? '–'}</td>
                    <td className="font-mono text-xs">
                      {a.program_id ?? '–'}
                      {a.program_hash && (
                        <span className="text-gray-500"> #{a.program_hash.slice(0, 8)}</span>
                      )}
                    </td>
                    <td className="max-w-md truncate font-mono text-xs" title={JSON.stringify(a.payload)}>
                      {a.error ? <span className="text-red-700">{a.error}</span> : JSON.stringify(a.payload)}
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center text-gray-500">
                      No entries.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button
              className="btn"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Newer
            </button>
            <button
              className="btn"
              disabled={offset + PAGE >= data.total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Older
            </button>
            <span className="text-gray-600">{data.total} entries</span>
          </div>
        </>
      )}
    </div>
  );
}
