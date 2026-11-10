import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Machine, ProgramDetail, ProgramSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ProgramStatusBadge, ProvenBadge } from '../components/ProgramStatusBadge';
import { ErrorBox } from '../components/ui';

export default function Programs() {
  const { hasRole } = useAuth();
  const [rows, setRows] = useState<ProgramSummary[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [params] = useSearchParams();
  const [machineId, setMachineId] = useState(params.get('machine') ?? '');
  const [part, setPart] = useState(params.get('part') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (machineId) qs.set('machine_id', machineId);
    if (part.trim()) qs.set('part_number', part.trim());
    api
      .get<ProgramSummary[]>(`/programs?${qs}`)
      .then((d) => {
        setRows(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [machineId, part]);
  useEffect(load, [load]);
  useEffect(() => {
    api
      .get<Machine[]>('/machines')
      .then(setMachines)
      .catch(() => undefined);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Programs</h1>
          <p className="text-sm text-gray-600">
            Latest version of each program. Only approved programs can be sent to a machine.
          </p>
        </div>
        {hasRole('programmer') && (
          <button className="btn" onClick={() => setShowUpload(!showUpload)}>
            {showUpload ? 'Close' : 'Upload program'}
          </button>
        )}
      </div>
      {showUpload && <UploadForm machines={machines} />}
      <div className="flex flex-wrap gap-2">
        <select
          className="input w-56"
          aria-label="Machine filter"
          value={machineId}
          onChange={(e) => setMachineId(e.target.value)}
        >
          <option value="">All machines</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input
          className="input w-56"
          placeholder="Part number"
          aria-label="Part number filter"
          value={part}
          onChange={(e) => setPart(e.target.value)}
        />
      </div>
      <ErrorBox error={error} />
      <div className="overflow-x-auto rounded border bg-white">
        <table className="table">
          <thead>
            <tr>
              <th>Program</th>
              <th>Part number</th>
              <th>Machine</th>
              <th>Version</th>
              <th>Status</th>
              <th>Checks</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link
                    to={`/programs/${p.id}`}
                    className="font-mono font-medium text-blue-700 hover:underline"
                  >
                    {p.name}
                  </Link>
                  <div className="text-xs text-gray-500">{p.title}</div>
                </td>
                <td className="font-mono text-xs">{p.part_number}</td>
                <td>{p.machine_name}</td>
                <td>v{p.version}</td>
                <td className="space-x-1 whitespace-nowrap">
                  <ProgramStatusBadge status={p.status} /> <ProvenBadge proven={p.proven} />
                </td>
                <td className="whitespace-nowrap text-xs">
                  {p.error_count > 0 ? (
                    <span className="badge-red">{p.error_count} errors</span>
                  ) : (
                    <span className="badge-green">no errors</span>
                  )}{' '}
                  {p.warning_count > 0 && <span className="badge-amber">{p.warning_count} warnings</span>}
                </td>
                <td className="text-xs text-gray-600">{p.source_note || p.source}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-gray-500">
                  No programs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UploadForm({ machines }: { machines: Machine[] }) {
  const navigate = useNavigate();
  const [machineId, setMachineId] = useState('');
  const [part, setPart] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function readFile(f: File | undefined) {
    if (!f) return;
    setText(await f.text());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const p = await api.post<ProgramDetail>('/programs', {
        machine_id: Number(machineId),
        text,
        part_number: part.trim() || null,
      });
      navigate(`/programs/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border bg-white p-4">
      <h2 className="font-semibold">Upload a program (saved as draft)</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select
          className="input"
          aria-label="Upload machine"
          value={machineId}
          onChange={(e) => setMachineId(e.target.value)}
          required
        >
          <option value="">Choose machine…</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="Part number (default: from header)"
          value={part}
          onChange={(e) => setPart(e.target.value)}
        />
        <input type="file" aria-label="Program file" onChange={(e) => void readFile(e.target.files?.[0])} />
      </div>
      <textarea
        className="input font-mono"
        rows={8}
        aria-label="Program text"
        placeholder={'%\nO1234(PART-NO NAME)\n...\nM30\n%'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        required
      />
      <ErrorBox error={error} />
      <button className="btn-primary">Upload</button>
    </form>
  );
}
