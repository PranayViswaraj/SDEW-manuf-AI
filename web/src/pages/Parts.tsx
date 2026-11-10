import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { FeatureTable, FeatureTableSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox } from '../components/ui';

export default function Parts() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const isEngineer = hasRole('engineer');
  const [rows, setRows] = useState<FeatureTableSummary[]>([]);
  const [part, setPart] = useState('');
  const [drawing, setDrawing] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<FeatureTableSummary[]>('/feature-tables')
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      let ft: FeatureTable;
      if (file) {
        const fd = new FormData();
        fd.append('part_number', part);
        fd.append('file', file);
        ft = await api.post<FeatureTable>('/feature-tables/from-drawing', fd);
      } else {
        ft = await api.post<FeatureTable>('/feature-tables', { part_number: part, drawing_ref: drawing });
      }
      navigate(`/parts/${ft.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Parts (feature tables)</h1>
        <p className="text-sm text-gray-600">
          A part&apos;s dimensions as a table. An engineer must enter and confirm every value before any
          program for that part can be sent to a machine.
        </p>
      </div>
      <ErrorBox error={error} />
      <div className="overflow-x-auto rounded border bg-white">
        <table className="table">
          <thead>
            <tr>
              <th>Part number</th>
              <th>Material</th>
              <th>Features</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/parts/${r.id}`} className="font-mono font-medium text-blue-700 hover:underline">
                    {r.part_number}
                  </Link>
                  {r.drawing_ref && <div className="text-xs text-gray-500">{r.drawing_ref}</div>}
                </td>
                <td>
                  {r.material_grade ?? '–'} {r.bar_diameter ? `Ø${r.bar_diameter}` : ''}
                </td>
                <td>{r.features}</td>
                <td>
                  {r.status === 'confirmed' ? (
                    <span className="badge-green">confirmed by {r.confirmed_by_name}</span>
                  ) : (
                    <span className="badge-amber">draft · {r.unconfirmed} values to confirm</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center text-gray-500">
                  No feature tables yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {isEngineer && (
        <form onSubmit={create} className="max-w-2xl space-y-2 rounded border bg-white p-4">
          <h2 className="font-semibold">New feature table</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              className="input"
              placeholder="Part number, e.g. 3773480M01"
              aria-label="New part number"
              value={part}
              onChange={(e) => setPart(e.target.value)}
              required
            />
            <input
              className="input"
              placeholder="Drawing reference (optional)"
              aria-label="Drawing reference"
              value={drawing}
              onChange={(e) => setDrawing(e.target.value)}
            />
          </div>
          <label className="block text-sm">
            <span className="text-gray-700">
              Drawing file (optional) — the AI drawing reader is not available yet;
            </span>{' '}
            <span className="text-gray-500">all values will be empty and must be entered by hand.</span>
            <input
              type="file"
              className="mt-1 block"
              aria-label="Drawing file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button className="btn-primary">Create</button>
        </form>
      )}
    </div>
  );
}
