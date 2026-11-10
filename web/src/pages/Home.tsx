import { motion } from 'framer-motion';
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Cpu,
  FileCode2,
  Hourglass,
  Play,
  Ruler,
  ScrollText,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { FeatureTableSummary, Machine, ProgramSummary, Role, RunSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { CountUp, Stagger, StaggerItem } from '../components/motion';
import { MachineLiveBadge } from '../components/StatusBadge';
import { Notice, Skeleton } from '../components/ui';

interface Data {
  machines: Machine[];
  programs: ProgramSummary[];
  parts: FeatureTableSummary[];
  runs: RunSummary[];
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

interface Task {
  to: string;
  title: string;
  text: string;
  icon: LucideIcon;
  roles: Role[];
  tone: string;
}

const TASKS: Task[] = [
  {
    to: '/run',
    title: 'Run a part',
    text: 'Pick a machine and an approved program, tick the checklist, send and start.',
    icon: Play,
    roles: ['operator'],
    tone: 'from-emerald-500 to-teal-600',
  },
  {
    to: '/parts',
    title: 'Confirm a part',
    text: 'Enter the drawing values and confirm every one before anything is sent.',
    icon: Ruler,
    roles: ['engineer'],
    tone: 'from-violet-500 to-purple-600',
  },
  {
    to: '/programs',
    title: 'Check and approve programs',
    text: 'Read the checks, look at the tool path, approve for one machine.',
    icon: FileCode2,
    roles: ['programmer'],
    tone: 'from-brand-500 to-brand-700',
  },
  {
    to: '/materials',
    title: 'Raw materials',
    text: 'Search bar stock or import the company register.',
    icon: Boxes,
    roles: ['engineer', 'admin'],
    tone: 'from-amber-500 to-orange-600',
  },
  {
    to: '/machines',
    title: 'Machines',
    text: 'Live status, limits and turret tools of every machine.',
    icon: Cpu,
    roles: ['admin', 'engineer', 'programmer', 'operator'],
    tone: 'from-sky-500 to-cyan-600',
  },
  {
    to: '/users',
    title: 'Users and Start list',
    text: 'Give roles and decide who may press Start.',
    icon: Users,
    roles: ['admin'],
    tone: 'from-slate-600 to-slate-800',
  },
  {
    to: '/logs',
    title: 'Audit log',
    text: 'Every action: who, what, which machine, when.',
    icon: ScrollText,
    roles: ['admin'],
    tone: 'from-rose-500 to-pink-600',
  },
];

// The 11-step flow from the design document, and what is live today.
const FLOW: { step: string; who: string; to: string; live: boolean; note?: string }[] = [
  { step: 'Upload drawing', who: 'Engineer', to: '/parts', live: true },
  { step: 'AI reads drawing', who: 'ManufAI', to: '/parts', live: false, note: 'needs real drawings' },
  { step: 'Confirm feature table', who: 'Engineer', to: '/parts', live: true },
  { step: 'Match capable machines', who: 'ManufAI', to: '/parts', live: true },
  { step: 'Select machine', who: 'Engineer', to: '/parts', live: true },
  {
    step: 'Build program',
    who: 'Fixed code',
    to: '/programs',
    live: false,
    note: 'needs templates, speeds & feeds',
  },
  { step: 'Approve program', who: 'Programmer', to: '/programs', live: true },
  { step: 'Material & safety prompt', who: 'Operator', to: '/run', live: true },
  { step: 'Send to machine', who: 'Operator', to: '/run', live: true },
  { step: 'Start / Feed hold / Stop', who: 'Operator', to: '/run', live: true },
  { step: 'First piece result', who: 'Operator', to: '/run', live: true },
];

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  to,
}: {
  icon: LucideIcon;
  label: string;
  value: number | null;
  sub: string;
  tone: string;
  to: string;
}) {
  return (
    <StaggerItem>
      <Link
        to={to}
        className="card group flex items-start gap-4 p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)]"
      >
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${tone} text-white shadow-md`}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</span>
          <span className="mt-0.5 block text-3xl font-bold tracking-tight text-slate-900 tabular-nums">
            {value === null ? <Skeleton className="mt-1 h-8 w-12" /> : <CountUp value={value} />}
          </span>
          <span className="block text-xs text-slate-500">{sub}</span>
        </span>
      </Link>
    </StaggerItem>
  );
}

export default function Home() {
  const { user, hasRole } = useAuth();
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      safe(api.get<Machine[]>('/machines'), []),
      safe(api.get<ProgramSummary[]>('/programs'), []),
      safe(api.get<FeatureTableSummary[]>('/feature-tables'), []),
      safe(api.get<RunSummary[]>('/runs?limit=6'), []),
    ]).then(([machines, programs, parts, runs]) => {
      if (!cancelled) setData({ machines, programs, parts, runs });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const tasks = TASKS.filter((t) => hasRole(...t.roles));
  const approved = data ? data.programs.filter((p) => p.status === 'approved').length : null;
  const confirmed = data ? data.parts.filter((p) => p.status === 'confirmed').length : null;
  const openRuns = data
    ? data.runs.filter((r) => ['checklist', 'send_failed', 'sent', 'running', 'completed'].includes(r.status))
        .length
    : null;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="space-y-8">
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative overflow-hidden rounded-3xl bg-ink px-6 py-8 text-white shadow-xl sm:px-10"
      >
        <div className="pointer-events-none absolute -top-24 -right-16 h-72 w-72 animate-float rounded-full bg-brand-500/30 blur-3xl" />
        <div
          className="pointer-events-none absolute -bottom-28 left-1/3 h-72 w-72 animate-float rounded-full bg-emerald-500/20 blur-3xl"
          style={{ animationDelay: '-7s' }}
        />
        <div className="relative">
          <p className="text-sm font-medium text-brand-200">{greeting}</p>
          <h1 className="hero-title mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            Welcome, {user?.full_name || user?.username}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-300">
            From a confirmed drawing to a machined part, one piece at a time. Use the big buttons below, or
            press <span className="kbd border-white/20 bg-white/10 text-white">Ctrl</span>{' '}
            <span className="kbd border-white/20 bg-white/10 text-white">K</span> to jump anywhere.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {(user?.roles ?? []).map((r) => (
              <span
                key={r}
                className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold capitalize ring-1 ring-white/20"
              >
                {r}
              </span>
            ))}
            {user?.can_start_machine && (
              <span className="rounded-full bg-emerald-400/20 px-3 py-1 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-300/30">
                allowed to press Start
              </span>
            )}
          </div>
        </div>
      </motion.section>

      <Notice tone="warn">
        ManufAI never replaces the machine&apos;s physical emergency stop. Always use the red E-stop on the
        machine in an emergency.
      </Notice>

      <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Cpu}
          label="Machines"
          value={data ? data.machines.length : null}
          sub="in the register"
          tone="from-sky-500 to-cyan-600"
          to="/machines"
        />
        <StatCard
          icon={CheckCircle2}
          label="Approved programs"
          value={approved}
          sub="ready to send"
          tone="from-brand-500 to-brand-700"
          to="/programs"
        />
        <StatCard
          icon={Ruler}
          label="Confirmed parts"
          value={confirmed}
          sub={data ? `${data.parts.length - (confirmed ?? 0)} waiting for an engineer` : 'feature tables'}
          tone="from-violet-500 to-purple-600"
          to="/parts"
        />
        <StatCard
          icon={ClipboardCheck}
          label="Open runs"
          value={openRuns}
          sub="not closed yet"
          tone="from-emerald-500 to-teal-600"
          to="/run"
        />
      </Stagger>

      <section aria-labelledby="tasks-title" className="space-y-3">
        <h2 id="tasks-title" className="text-lg font-semibold tracking-tight">
          What would you like to do?
        </h2>
        <Stagger className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {tasks.map((t) => {
            const Icon = t.icon;
            return (
              <StaggerItem key={t.to}>
                <Link
                  to={t.to}
                  className="card group relative flex h-full items-start gap-4 overflow-hidden p-5 transition duration-200 hover:-translate-y-1 hover:border-brand-200 hover:shadow-[var(--shadow-lift)]"
                >
                  <span
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${t.tone} text-white shadow-lg transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3`}
                  >
                    <Icon className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 font-semibold text-slate-900">
                      {t.title}
                      <ArrowRight
                        className="h-4 w-4 -translate-x-1 opacity-0 transition duration-200 group-hover:translate-x-0 group-hover:opacity-100"
                        aria-hidden="true"
                      />
                    </span>
                    <span className="mt-1 block text-sm text-slate-600">{t.text}</span>
                  </span>
                </Link>
              </StaggerItem>
            );
          })}
        </Stagger>
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <section className="card p-5 xl:col-span-2" aria-labelledby="live-title">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="live-title" className="font-semibold tracking-tight">
              Machines right now
            </h2>
            <Link to="/machines" className="text-sm font-medium text-brand-700 hover:underline">
              All machines
            </Link>
          </div>
          {!data ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : data.machines.length === 0 ? (
            <p className="text-sm text-slate-500">No machines in the register.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.machines.map((m) => (
                <li key={m.id}>
                  <Link
                    to={`/machines/${m.id}`}
                    className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition hover:bg-slate-50"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                      <Cpu className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{m.name}</span>
                      <span className="block text-xs text-slate-500">{m.controller}</span>
                    </span>
                    <MachineLiveBadge machineId={m.id} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5 xl:col-span-3" aria-labelledby="flow-title">
          <h2 id="flow-title" className="font-semibold tracking-tight">
            From drawing to machined part
          </h2>
          <p className="text-xs text-slate-500">The 11 steps of the design. Click a step to go there.</p>
          <ol className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {FLOW.map((f, i) => (
              <motion.li
                key={f.step}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.15 + i * 0.04 }}
              >
                <Link
                  to={f.to}
                  className="group flex items-center gap-3 rounded-xl border border-slate-100 px-3 py-2 transition hover:border-brand-200 hover:bg-brand-50/40"
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      f.live ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-400'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">{f.step}</span>
                    <span className="block truncate text-xs text-slate-500">{f.live ? f.who : f.note}</span>
                  </span>
                  {f.live ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-label="available" />
                  ) : (
                    <Hourglass className="h-4 w-4 text-amber-500" aria-label="waiting for inputs" />
                  )}
                </Link>
              </motion.li>
            ))}
          </ol>
        </section>
      </div>

      <section className="card p-5" aria-labelledby="recent-title">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent-title" className="font-semibold tracking-tight">
            Latest runs
          </h2>
          <Link to="/run" className="text-sm font-medium text-brand-700 hover:underline">
            Full run log
          </Link>
        </div>
        {!data ? (
          <Skeleton className="h-10 w-full" />
        ) : data.runs.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Clock className="h-4 w-4" aria-hidden="true" /> No runs yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.runs.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/runs/${r.id}`}
                  className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition hover:bg-slate-50"
                >
                  <span className="font-mono text-xs text-slate-400">#{r.id}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-mono font-medium">{r.program_name}</span> on {r.machine_name}
                    {r.operator && <span className="text-slate-500"> · {r.operator}</span>}
                  </span>
                  <span
                    className={
                      r.first_piece_result === 'pass'
                        ? 'badge-green'
                        : r.first_piece_result === 'fail'
                          ? 'badge-red'
                          : 'badge-gray'
                    }
                  >
                    {r.first_piece_result ?? r.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
