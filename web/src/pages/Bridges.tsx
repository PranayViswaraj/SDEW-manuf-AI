import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { BridgeInfo } from '../api/types';
import { ErrorBox, Notice } from '../components/ui';

interface Secrets {
  name: string;
  bridge_token: string;
  signing_key: string;
  note: string;
}

export default function Bridges() {
  const [items, setItems] = useState<BridgeInfo[]>([]);
  const [name, setName] = useState('');
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<BridgeInfo[]>('/bridges')
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 3000);
    return () => window.clearInterval(id);
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      setSecrets(await api.post<Secrets>('/bridges', { name }));
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Bridges</h1>
        <p className="text-sm text-gray-600">
          A bridge runs on a factory PC and connects out to ManufAI. Assign machines to a bridge with the
          machine&apos;s &quot;bridge id&quot;.
        </p>
      </div>
      <ErrorBox error={error} />
      <div className="overflow-x-auto rounded border bg-white">
        <table className="table">
          <thead>
            <tr>
              <th>Bridge</th>
              <th>Connection</th>
              <th>Machines assigned in ManufAI</th>
              <th>Machines reported by the bridge</th>
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.id}>
                <td className="font-mono">{b.name}</td>
                <td>
                  {b.connected ? (
                    <span className="badge-green">Connected</span>
                  ) : (
                    <span className="badge-red">Offline</span>
                  )}
                  {b.bridge_version && (
                    <span className="ml-2 text-xs text-gray-500">v{b.bridge_version}</span>
                  )}
                </td>
                <td className="font-mono text-xs">{b.assigned_machines.join(', ') || '–'}</td>
                <td className="font-mono text-xs">
                  {b.reported_machines.map((m) => `${m.id} (${m.driver})`).join(', ') || '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={create} className="flex max-w-lg gap-2">
        <input
          className="input"
          placeholder="new-bridge-name"
          aria-label="Bridge name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button className="btn-primary whitespace-nowrap">Create bridge</button>
      </form>
      {secrets && (
        <Notice tone="warn">
          <div className="font-medium">{secrets.note}</div>
          <pre className="mt-2 overflow-x-auto rounded bg-white p-2 text-xs">
            {`bridge_token: ${secrets.bridge_token}\nsigning_key: ${secrets.signing_key}`}
          </pre>
        </Notice>
      )}
    </div>
  );
}
