import { ArrowRight, Cpu, Play, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { oNumber, type Machine, type ProgramSummary, type RunDetail, type RunSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ProvenBadge } from '../components/ProgramStatusBadge';
import { LiveBadge } from '../components/StatusBadge';
import { ErrorBox } from '../components/ui';
import { useLiveStatus } from '../hooks/useLiveStatus';

const ACTIVE: RunSummary['status'][] = ['checklist', 'send_failed', 'sent', 'running', 'completed'];
const NEXT: Partial<Record<RunSummary['status'], string>> = {
  checklist: 'finish the checklist and send',
  send_failed: 'sending failed, try again',
  sent: 'start the machine',
  running: 'running now',
  completed: 'record the first piece',
};
const RUN_STATE: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  feed_hold: 'Feed hold',
  stopped: 'Program stop',
};

export default function Run() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const isOperator = hasRole('operator');
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineId, setMachineId] = useState<number | null>(null);
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Machine[]>('/machines')
      .then((ms) => {
        setMachines(ms);
        if (ms.length === 1) setMachineId(ms[0].id); // one machine: nothing to choose
      })
      .catch((e: Error) => setError(e.message));
    api
      .get<RunSummary[]>('/runs?limit=20')
      .then(setRuns)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!machineId) return;
    setQuery('');
    api
      .get<ProgramSummary[]>(`/programs?machine_id=${machineId}&program_status=approved`)
      .then(setPrograms)
      .catch((e: Error) => setError(e.message));
  }, [machineId]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return programs;
    return programs.filter((p) => `${p.name} ${p.title} ${p.part_number}`.toLowerCase().includes(q));
  }, [programs, query]);

  async function startRun(programId: number) {
    try {
      const run = await api.post<RunDetail>('/runs', { machine_id: machineId, program_id: programId });
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const open = runs.filter((r) => ACTIVE.includes(r.status));
  // One open run per machine (the server refuses a second one): offer to continue it instead.
  const selectedName = machines.find((m) => m.id === machineId)?.name;
  const busyRun = open.find((r) => r.machine_name === selectedName);

  return (
    <div className="space-y-6">
      <div>
        <h1>Run a part</h1>
        <p className="text-sm text-slate-600">
          1. Choose a machine. 2. Choose an approved program. 3. Follow the run screen.
        </p>
      </div>
      <ErrorBox error={error} />

      {open.length > 0 && (
        <section aria-label="Open runs" className="space-y-2">
          {open.map((r) => (
            <Link
              key={r.id}
              to={`/runs/${r.id}`}
              className="flex items-center gap-4 rounded-2xl border-2 border-brand-300 bg-brand-50 p-4 transition hover:border-brand-500"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
                <Play className="h-6 w-6" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-bold">
                  Continue run #{r.id}: {r.program_name} on {r.machine_name}
                </span>
                <span className="block text-sm text-slate-700">
                  Part {r.part_number} · next: {NEXT[r.status]}
                </span>
              </span>
              <ArrowRight className="h-6 w-6 shrink-0 text-brand-700" aria-hidden="true" />
            </Link>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">1. Machine</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {machines.map((m) => (
            <MachineTile
              key={m.id}
              machine={m}
              selected={machineId === m.id}
              onSelect={() => setMachineId(m.id)}
            />
          ))}
          {machines.length === 0 && <p className="text-sm text-slate-600">No machines in the register.</p>}
        </div>
      </section>

      {machineId && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-lg font-semibold">2. Approved program</h2>
            {programs.length > 4 && (
              <label className="relative w-full sm:w-72">
                <span className="sr-only">Find a program</span>
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500"
                  aria-hidden="true"
                />
                <input
                  className="input pl-9"
                  placeholder="Find by O-number, name or part"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            )}
          </div>
          {programs.length === 0 && (
            <p className="text-sm text-slate-600">No approved programs for this machine.</p>
          )}
          {programs.length > 0 && shown.length === 0 && (
            <p className="text-sm text-slate-600">No program matches “{query}”.</p>
          )}
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {shown.map((p) => (
              <li key={p.id} className="card flex items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/programs/${p.id}`}
                      className="font-mono text-lg font-bold text-brand-700 hover:underline"
                    >
                      {p.name}
                    </Link>
                    <span className="text-sm text-slate-500">v{p.version}</span>
                    <ProvenBadge proven={p.proven} />
                  </div>
                  <div className="truncate text-sm text-slate-700">{p.title}</div>
                  <div className="font-mono text-xs text-slate-500">{p.part_number}</div>
                </div>
                {busyRun ? (
                  <Link to={`/runs/${busyRun.id}`} className="btn min-h-12 px-5 text-base">
                    Continue run #{busyRun.id}
                  </Link>
                ) : isOperator ? (
                  <button className="btn-primary min-h-12 px-5 text-base" onClick={() => void startRun(p.id)}>
                    <Play className="h-5 w-5" aria-hidden="true" />
                    Start a run
                  </button>
                ) : (
                  <span className="text-xs text-slate-500">operators start runs</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Run log</h2>
        <div className="overflow-x-auto rounded border bg-white">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Who</th>
                <th>When (UTC)</th>
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
                  <td>{r.operator ?? '–'}</td>
                  <td className="whitespace-nowrap font-mono text-xs">
                    {(r.started_at ?? r.created_at).slice(0, 16).replace('T', ' ')}
                    {r.start_mode && (
                      <div className="text-gray-500">
                        {r.start_mode === 'remote' ? 'started from ManufAI' : 'started at machine'}
                      </div>
                    )}
                  </td>
                  <td>{r.machine_name}</td>
                  <td className="font-mono">
                    {r.program_name} v{r.program_version}
                  </td>
                  <td className="font-mono text-xs">{r.part_number}</td>
                  <td>{r.status}</td>
                  <td>
                    {r.first_piece_result ?? '–'}
                    {r.first_piece_by && <div className="text-xs text-gray-500">by {r.first_piece_by}</div>}
                  </td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-gray-500">
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

function MachineTile({
  machine: m,
  selected,
  onSelect,
}: {
  machine: Machine;
  selected: boolean;
  onSelect: () => void;
}) {
  const { live } = useLiveStatus(m.id, 2000);
  const s = live?.state === 'online' ? live.status : null;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-2xl border-2 bg-white p-4 text-left transition ${
        selected ? 'border-brand-600 ring-4 ring-brand-100' : 'border-slate-200 hover:border-brand-300'
      }`}
    >
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
          selected ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'
        }`}
        aria-hidden="true"
      >
        <Cpu className="h-6 w-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold">{m.name}</span>
        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <LiveBadge live={live} />
          {m.remote_control_enabled ? 'remote start on' : 'Cycle Start at machine'}
        </span>
        {s && (
          <span className="mt-1.5 block text-sm text-slate-700">
            {RUN_STATE[s.run_state] ?? s.run_state}
            {s.alarms.length > 0 && <b className="text-rose-700"> · {s.alarms.length} alarm(s)</b>}
            {s.program_number ? ` · ${oNumber(s.program_number)} loaded` : ''}
          </span>
        )}
      </span>
    </button>
  );
}
