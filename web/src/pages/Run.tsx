import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Machine, ProgramSummary, RunDetail, RunSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ProvenBadge } from '../components/ProgramStatusBadge';
import { MachineLiveBadge } from '../components/StatusBadge';
import { ErrorBox } from '../components/ui';

export default function Run() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineId, setMachineId] = useState<number | null>(null);
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Machine[]>('/machines')
      .then(setMachines)
      .catch((e: Error) => setError(e.message));
    api
      .get<RunSummary[]>('/runs?limit=20')
      .then(setRuns)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!machineId) return;
    api
      .get<ProgramSummary[]>(`/programs?machine_id=${machineId}&program_status=approved`)
      .then(setPrograms)
      .catch((e: Error) => setError(e.message));
  }, [machineId]);

  async function startRun(programId: number) {
    try {
      const run = await api.post<RunDetail>('/runs', { machine_id: machineId, program_id: programId });
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Run a part</h1>
        <p className="text-sm text-gray-600">
          1. Choose a machine. 2. Choose an approved program. 3. Follow the run screen.
        </p>
      </div>
      <ErrorBox error={error} />

      <section className="space-y-2">
        <h2 className="font-semibold">1. Machine</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {machines.map((m) => (
            <button
              key={m.id}
              className={`rounded border bg-white p-3 text-left hover:border-blue-400 ${
                machineId === m.id ? 'border-blue-600 ring-2 ring-blue-200' : ''
              }`}
              onClick={() => setMachineId(m.id)}
            >
              <div className="font-medium">{m.name}</div>
              <div className="mt-1 flex items-center gap-2 text-xs text-gray-600">
                <MachineLiveBadge machineId={m.id} />
                {m.remote_control_enabled ? 'remote start on' : 'Cycle Start at machine'}
              </div>
            </button>
          ))}
        </div>
      </section>

      {machineId && (
        <section className="space-y-2">
          <h2 className="font-semibold">2. Approved program</h2>
          {programs.length === 0 && (
            <p className="text-sm text-gray-600">No approved programs for this machine.</p>
          )}
          <div className="overflow-x-auto rounded border bg-white">
            <table className="table">
              <tbody>
                {programs.map((p) => (
                  <tr key={p.id}>
                    <td className="font-mono font-medium">
                      <Link to={`/programs/${p.id}`} className="text-blue-700 hover:underline">
                        {p.name}
                      </Link>{' '}
                      v{p.version}
                    </td>
                    <td>
                      {p.title} <span className="font-mono text-xs text-gray-500">{p.part_number}</span>{' '}
                      <ProvenBadge proven={p.proven} />
                    </td>
                    <td className="text-right">
                      {hasRole('operator') ? (
                        <button className="btn-primary" onClick={() => void startRun(p.id)}>
                          Start a run
                        </button>
                      ) : (
                        <span className="text-xs text-gray-500">operators start runs</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">Recent runs</h2>
        <div className="overflow-x-auto rounded border bg-white">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Machine</th>
                <th>Program</th>
                <th>Part</th>
                <th>Status</th>
                <th>First piece</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/runs/${r.id}`} className="text-blue-700 hover:underline">
                      #{r.id}
                    </Link>
                  </td>
                  <td>{r.machine_name}</td>
                  <td className="font-mono">
                    {r.program_name} v{r.program_version}
                  </td>
                  <td className="font-mono text-xs">{r.part_number}</td>
                  <td>{r.status}</td>
                  <td>{r.first_piece_result ?? '–'}</td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-gray-500">
                    No runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
