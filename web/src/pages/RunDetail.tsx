import { motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  CircleDot,
  ClipboardCheck,
  Expand,
  Hand,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  Ruler,
  Send,
  Square,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  oNumber,
  type ActionResponse,
  type InspectionRow,
  type LiveStatus,
  type Material,
  type RunDetail as Detail,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import Checklist from '../components/Checklist';
import ConfirmDialog from '../components/ConfirmDialog';
import { LiveBadge } from '../components/StatusBadge';
import { ErrorBox, Notice, PageLoading } from '../components/ui';

type Status = Detail['status'];

const STEPS: { status: Status[]; label: string; icon: LucideIcon }[] = [
  { status: ['checklist', 'send_failed'], label: 'Prepare & send', icon: ClipboardCheck },
  { status: ['sent'], label: 'Start', icon: Play },
  { status: ['running'], label: 'Running', icon: CircleDot },
  { status: ['completed'], label: 'First piece', icon: Ruler },
  { status: ['closed'], label: 'Done', icon: CheckCircle2 },
];

const STATUS_WORDS: Record<Status, string> = {
  checklist: 'Getting ready',
  send_failed: 'Send failed',
  sent: 'Program on machine',
  running: 'Running',
  completed: 'Finished: measure the first piece',
  closed: 'Done',
  aborted: 'Aborted',
};

const RUN_STATE: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  feed_hold: 'Feed hold',
  stopped: 'Program stop',
};

export default function RunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const isOperator = hasRole('operator');
  const [run, setRun] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string; status: Status } | null>(null);
  const [confirm, setConfirm] = useState<'send' | 'start' | 'abort' | null>(null);
  const [busy, setBusy] = useState(false);
  const fullscreen = useFullscreen();

  const load = useCallback(() => {
    api
      .get<Detail>(`/runs/${id}`)
      .then((d) => {
        setRun(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 1000);
    return () => window.clearInterval(t);
  }, [load]);

  async function action(path: 'send' | 'start' | 'feed-hold' | 'stop') {
    setBusy(true);
    setConfirm(null);
    try {
      const r = await api.post<ActionResponse>(`/runs/${id}/${path}`);
      setRun(r.run);
      if (r.action.result === 'ok') {
        const text =
          path === 'send'
            ? r.run.machine.remote_control_enabled
              ? 'Program sent and verified on the machine.'
              : 'Program sent and verified.'
            : path === 'start'
              ? 'Cycle start sent.'
              : path === 'feed-hold'
                ? 'Feed hold sent.'
                : 'Stop (reset) sent.';
        setMessage({ tone: 'ok', text, status: r.run.status });
      } else {
        setMessage({
          tone: 'warn',
          text: r.action.error ?? `${path} ${r.action.result}`,
          status: r.run.status,
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function put(path: string, body: unknown) {
    try {
      setRun(await api.put<Detail>(`/runs/${id}/${path}`, body));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function abort() {
    setConfirm(null);
    try {
      setRun(await api.post<Detail>(`/runs/${id}/abort`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runAgain() {
    if (!run) return;
    try {
      const next = await api.post<Detail>('/runs', {
        machine_id: run.machine.id,
        program_id: run.program.id,
      });
      setMessage(null);
      navigate(`/runs/${next.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!run) return error ? <ErrorBox error={error} /> : <PageLoading />;

  const editable = ['checklist', 'send_failed', 'sent'].includes(run.status);
  const active = ['checklist', 'send_failed', 'sent', 'running'].includes(run.status);
  const stepIndex = STEPS.findIndex((s) => s.status.includes(run.status));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/run"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All runs
          </Link>
          <h1 className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono">{run.program.name}</span>
            <span className="text-base font-medium text-slate-500">v{run.program.version}</span>
            <span className="text-base font-medium text-slate-500">on {run.machine.name}</span>
          </h1>
          <p className="text-sm text-slate-600">
            Run #{run.id} · Part <span className="font-mono">{run.part_number}</span> · {run.program.title}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={run.status} />
          {fullscreen.supported && (
            <button
              type="button"
              className="btn"
              onClick={fullscreen.toggle}
              aria-pressed={fullscreen.on}
              title="Use the whole screen (for a tablet at the machine)"
            >
              {fullscreen.on ? (
                <Minimize className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Expand className="h-4 w-4" aria-hidden="true" />
              )}
              {fullscreen.on ? 'Exit full screen' : 'Full screen'}
            </button>
          )}
        </div>
      </header>

      {run.status !== 'aborted' && <Stepper index={stepIndex} />}

      <ErrorBox error={error} />
      <div aria-live="polite">
        {message && message.status === run.status && <Notice tone={message.tone}>{message.text}</Notice>}
      </div>

      <LiveStrip live={run.live} />

      <NextStep
        run={run}
        isOperator={isOperator}
        busy={busy}
        onSend={() => setConfirm('send')}
        onStart={() => setConfirm('start')}
        onFeedHold={() => void action('feed-hold')}
        onStop={() => void action('stop')}
        onRunAgain={() => void runAgain()}
      />

      {active && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
          <div className="xl:col-span-2">
            <MaterialSection
              run={run}
              editable={editable && isOperator}
              onSave={(b) => void put('material', b)}
            />
          </div>
          <div className="xl:col-span-3">
            <Checklist
              items={run.checklist}
              disabled={!editable || !isOperator}
              onToggle={(key, ticked) => void put('checklist', { item: key, ticked })}
            />
          </div>
        </div>
      )}

      {(run.status === 'completed' || run.status === 'closed') && (
        <FirstPieceSection run={run} canRecord={isOperator && run.status === 'completed'} onSaved={setRun} />
      )}

      <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        The machine&apos;s red emergency stop is the only emergency stop. Use it in any emergency.
      </p>

      {active && isOperator && (
        <div className="text-right">
          <button className="text-sm text-slate-600 underline" onClick={() => setConfirm('abort')}>
            Abort run (no machine action)
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'send'}
        title="Send program to the machine?"
        confirmLabel="Send program"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void action('send')}
      >
        <p>
          Send{' '}
          <b>
            {run.program.name} v{run.program.version}
          </b>{' '}
          ({run.part_number}) to <b>{run.machine.name}</b>.
        </p>
        <p className="mt-2">
          The bridge checks the machine is idle, sends it, reads it back and compares it.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'start'}
        title="Start the machine?"
        confirmLabel="Start"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void action('start')}
      >
        <p>
          <b>{run.machine.name}</b> will start <b>{run.program.name}</b>. Stand clear, door closed. Keep your
          hand near the machine&apos;s emergency stop.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'abort'}
        title="Abort this run?"
        confirmLabel="Abort run"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void abort()}
      >
        <p>
          The run is closed in ManufAI. <b>This does not stop the machine.</b> Use the machine panel to stop
          it.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ header pieces */

function StatusPill({ status }: { status: Status }) {
  const cls =
    status === 'closed'
      ? 'bg-emerald-600 text-white'
      : status === 'aborted' || status === 'send_failed'
        ? 'bg-rose-600 text-white'
        : status === 'running'
          ? 'bg-brand-600 text-white'
          : status === 'completed'
            ? 'bg-amber-500 text-white'
            : 'bg-slate-800 text-white';
  return (
    <span className={`rounded-full px-4 py-2 text-sm font-semibold ${cls}`}>
      <span className="sr-only">Run status: </span>
      <span data-testid="run-status" aria-live="polite">
        {STATUS_WORDS[status]}
      </span>
    </span>
  );
}

function Stepper({ index }: { index: number }) {
  return (
    <ol className="grid grid-cols-5 gap-1.5 sm:gap-2" aria-label="Run steps">
      {STEPS.map((s, i) => {
        const done = i < index;
        const current = i === index;
        const Icon = done ? Check : s.icon;
        return (
          <li
            key={s.label}
            aria-current={current ? 'step' : undefined}
            className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-center text-xs font-semibold transition sm:flex-row sm:gap-2 sm:px-3 sm:text-sm ${
              done
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : current
                  ? 'border-brand-600 bg-brand-600 text-white shadow-[var(--shadow-lift)]'
                  : 'border-slate-200 bg-white text-slate-500'
            }`}
          >
            <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>
              <span className="sr-only">
                Step {i + 1}
                {done ? ' (done)' : current ? ' (now)' : ''}:{' '}
              </span>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ live machine strip */

function Tile({ label, children, tone }: { label: string; children: ReactNode; tone?: 'bad' | 'good' }) {
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${
        tone === 'bad'
          ? 'border-rose-300 bg-rose-50'
          : tone === 'good'
            ? 'border-emerald-200 bg-emerald-50'
            : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className="text-xs font-medium tracking-wide text-slate-600 uppercase">{label}</div>
      <div
        className={`mt-0.5 text-xl font-bold tabular-nums ${tone === 'bad' ? 'text-rose-800' : 'text-slate-900'}`}
      >
        {children}
      </div>
    </div>
  );
}

function LiveStrip({ live }: { live: LiveStatus }) {
  const s = live.status;
  const usable = live.state === 'online' && s;
  return (
    <section className="card space-y-3 p-4" aria-label="Live machine status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Machine right now</h2>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <LiveBadge live={live} />
          {live.age_s !== null && <span>updated {live.age_s} s ago</span>}
        </div>
      </div>
      {live.state === 'stale' && (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
          No update from the machine for {live.age_s} s. The values below may be out of date. Check the
          machine.
        </p>
      )}
      {live.state === 'offline' && (
        <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-800">
          {live.bridge_id
            ? `The factory bridge "${live.bridge_id}" is not connected. No live data, and nothing can be sent.`
            : 'No bridge is assigned to this machine yet.'}
        </p>
      )}
      {live.state === 'machine_unreachable' && (
        <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-800">
          The bridge is online but cannot reach the machine: {live.error}
        </p>
      )}
      {s && (
        <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 ${usable ? '' : 'opacity-50'}`}>
          <Tile label="State" tone={s.run_state === 'running' ? 'good' : undefined}>
            {RUN_STATE[s.run_state] ?? s.run_state}
          </Tile>
          <Tile label="Spindle">
            {s.spindle_speed !== null ? (
              <>
                {Math.round(s.spindle_speed)} <span className="text-sm font-medium text-slate-500">rpm</span>
              </>
            ) : (
              '–'
            )}
          </Tile>
          <Tile label="Program">{oNumber(s.program_number)}</Tile>
          <Tile label="Block">{s.sequence_number !== null ? `N${s.sequence_number}` : '–'}</Tile>
          <Tile label="Parts made">{s.part_count ?? '–'}</Tile>
          <Tile label="Alarms" tone={s.alarms.length || s.emergency ? 'bad' : undefined}>
            {s.emergency ? 'E-STOP PRESSED' : s.alarms.length === 0 ? 'None' : s.alarms.length}
          </Tile>
        </div>
      )}
      {s && s.alarms.length > 0 && (
        <ul className="list-inside list-disc text-sm text-rose-800">
          {s.alarms.map((a) => (
            <li key={`${a.code}-${a.message}`}>
              {a.code} {a.message}
            </li>
          ))}
        </ul>
      )}
      {s && (
        <p className="text-xs text-slate-600">
          Mode {s.mode} · Feed override {s.feed_override !== null ? `${s.feed_override} %` : '–'} · Remote
          control {live.remote_control_enabled ? 'enabled' : 'off (Cycle Start is pressed at the machine)'}
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ "do this now" card */

function NextStep({
  run,
  isOperator,
  busy,
  onSend,
  onStart,
  onFeedHold,
  onStop,
  onRunAgain,
}: {
  run: Detail;
  isOperator: boolean;
  busy: boolean;
  onSend: () => void;
  onStart: () => void;
  onFeedHold: () => void;
  onStop: () => void;
  onRunAgain: () => void;
}) {
  const remote = run.machine.remote_control_enabled;
  const st = run.status;
  const preparing = st === 'checklist' || st === 'send_failed';
  const active = preparing || st === 'sent' || st === 'running';

  let icon: LucideIcon = ClipboardCheck;
  let title = '';
  let text: ReactNode = null;
  let tone: 'brand' | 'ok' | 'warn' | 'bad' = 'brand';
  if (preparing) {
    const ready = run.send_blockers.length === 0;
    icon = ready ? Send : ClipboardCheck;
    title = ready ? 'Ready: send the program' : 'Prepare the machine';
    text = ready
      ? 'Everything is checked. Send the program to the machine.'
      : 'Load the material and tick every check below. The Send button unlocks when nothing is left.';
    if (st === 'send_failed') {
      tone = 'bad';
      title = 'Sending failed: try again';
      text =
        run.status_note ||
        'The program did not reach the machine intact. Check the items below and send again.';
    }
  } else if (st === 'sent') {
    icon = remote ? Play : Hand;
    title = remote ? 'Start the machine' : 'Press Cycle Start at the machine';
    text = remote ? (
      'The verified program is selected on the machine. Close the door and press Start.'
    ) : (
      <span role="status">Program sent. Press Cycle Start at the machine.</span>
    );
  } else if (st === 'running') {
    icon = CircleDot;
    tone = 'ok';
    title = 'Machine is running';
    text = remote ? (
      'Watch the machine. Use Feed hold or Stop here, or the machine panel.'
    ) : (
      <span role="status">
        Running — started at the machine. Use the machine panel for Feed hold / Reset.
      </span>
    );
  } else if (st === 'completed') {
    icon = Ruler;
    tone = 'warn';
    title = 'Measure the first piece';
    text = 'The machine has finished. Measure the piece and record the result below.';
  } else if (st === 'closed') {
    icon = run.first_piece.result === 'pass' ? CheckCircle2 : XCircle;
    tone = run.first_piece.result === 'pass' ? 'ok' : 'bad';
    title =
      run.first_piece.result === 'pass'
        ? 'Run complete: first piece passed'
        : 'Run complete: first piece failed';
    text =
      run.first_piece.result === 'pass'
        ? `${run.program.name} is proven for part ${run.part_number}.`
        : 'Tell the programmer before running this program again.';
  } else {
    icon = XCircle;
    tone = 'bad';
    title = 'Run aborted';
    text = run.status_note || 'This run was closed without a result.';
  }

  const ring = {
    brand: 'border-brand-200 bg-brand-50/60',
    ok: 'border-emerald-200 bg-emerald-50/70',
    warn: 'border-amber-200 bg-amber-50/70',
    bad: 'border-rose-200 bg-rose-50/70',
  }[tone];
  const iconCls = {
    brand: 'bg-brand-600',
    ok: 'bg-emerald-600',
    warn: 'bg-amber-500',
    bad: 'bg-rose-600',
  }[tone];
  const Icon = icon;
  const big = 'min-h-14 px-6 text-base';

  return (
    <motion.section
      key={st}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-2xl border-2 p-4 sm:p-5 ${ring}`}
      aria-label="Machine actions"
    >
      <div className="flex items-start gap-4">
        <span
          className={`hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white sm:flex ${iconCls}`}
          aria-hidden="true"
        >
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 className="text-lg font-bold sm:text-xl">{title}</h2>
            <p className="mt-0.5 text-slate-700">{text}</p>
          </div>

          {active && isOperator && (
            <div className="flex flex-wrap gap-2">
              {preparing && (
                <button
                  className={`btn-primary ${big}`}
                  disabled={busy || run.send_blockers.length > 0}
                  onClick={onSend}
                >
                  <Send className="h-5 w-5" aria-hidden="true" />
                  Send program
                </button>
              )}
              {remote && st !== 'running' && (
                <button
                  className={`btn-primary ${big}`}
                  disabled={busy || run.start_blockers.length > 0}
                  onClick={onStart}
                >
                  <Play className="h-5 w-5" aria-hidden="true" />
                  Start
                </button>
              )}
              {/* Feed hold / Stop only once the program is on the machine. */}
              {remote && (st === 'sent' || st === 'running') && (
                <>
                  <button className={`btn-danger ${big}`} disabled={busy} onClick={onFeedHold}>
                    <Pause className="h-5 w-5" aria-hidden="true" />
                    Feed hold
                  </button>
                  <button
                    className={`btn-danger ${big}`}
                    title="Program reset through the control. NOT an emergency stop."
                    disabled={busy}
                    onClick={onStop}
                  >
                    <Square className="h-5 w-5" aria-hidden="true" />
                    Stop
                  </button>
                </>
              )}
            </div>
          )}
          {active && !isOperator && (
            <p className="text-sm text-slate-600">
              Only operators can send and start. You can watch this run.
            </p>
          )}

          {isOperator && preparing && <Todo title="Send is locked because" items={run.send_blockers} />}
          {isOperator && remote && st === 'sent' && (
            <Todo title="Start is locked because" items={run.start_blockers} />
          )}
          {preparing && !remote && (
            <p className="text-sm text-slate-600">
              Remote control is off for this machine: after sending, press Cycle Start at the machine.
            </p>
          )}

          {st === 'closed' && isOperator && run.program.status === 'approved' && (
            <button className={`btn-primary ${big}`} onClick={onRunAgain}>
              <RotateCcw className="h-5 w-5" aria-hidden="true" />
              Run this program again
            </button>
          )}
        </div>
      </div>
    </motion.section>
  );
}

function Todo({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
      <div className="font-semibold text-slate-800">
        {title} ({items.length} left):
      </div>
      <ul className="mt-1.5 space-y-1">
        {items.map((b) => (
          <li key={b} className="flex items-start gap-2 text-slate-800">
            <span
              className="mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-amber-500"
              aria-hidden="true"
            />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ raw material */

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').toUpperCase();

function MaterialSection({
  run,
  editable,
  onSave,
}: {
  run: Detail;
  editable: boolean;
  onSave: (b: { material_id: number | null; material_note: string }) => void;
}) {
  const req = run.required_material;
  const [options, setOptions] = useState<Material[]>([]);
  const [note, setNote] = useState(run.material_note);
  useEffect(() => {
    const qs = req?.material_grade ? `?q=${encodeURIComponent(req.material_grade)}` : '';
    api
      .get<Material[]>(`/materials${qs}`)
      .then(setOptions)
      .catch(() => undefined);
  }, [req?.material_grade]);

  const fits = (m: { grade: string; bar_diameter: number }) =>
    !!req?.material_grade &&
    norm(m.grade) === norm(req.material_grade) &&
    m.bar_diameter === req.bar_diameter;
  const sorted = [...options].sort((a, b) => Number(fits(b)) - Number(fits(a)));
  const chosen = run.material;
  const matches =
    req && chosen && req.material_grade && req.bar_diameter !== null
      ? norm(chosen.grade) === norm(req.material_grade) && chosen.bar_diameter === req.bar_diameter
      : null;

  return (
    <section className="card h-full space-y-3 p-4" aria-label="Raw material">
      <h2 className="font-semibold">Raw material</h2>
      <div className="rounded-xl bg-slate-50 p-3">
        <div className="text-xs font-medium tracking-wide text-slate-600 uppercase">This part needs</div>
        {req ? (
          <div className="mt-0.5 text-lg font-bold">
            {req.material_grade} bar Ø{req.bar_diameter} mm{' '}
            <span className="text-sm font-medium text-slate-600">(length {req.overall_length} mm part)</span>
          </div>
        ) : (
          <div className="mt-0.5 text-sm italic text-amber-800">
            not known — no confirmed feature table; enter it below
          </div>
        )}
      </div>
      <label className="block text-sm font-medium text-slate-700">
        Bar loaded
        <select
          className="input mt-1 min-h-12 text-base"
          aria-label="Material from register"
          value={chosen?.id ?? ''}
          disabled={!editable}
          onChange={(e) =>
            onSave({ material_id: e.target.value ? Number(e.target.value) : null, material_note: note })
          }
        >
          <option value="">— choose from the register —</option>
          {sorted.map((m) => (
            <option key={m.id} value={m.id}>
              {fits(m) ? '✓ ' : ''}
              {m.grade} Ø{m.bar_diameter}
              {m.available_length !== null ? ` × ${m.available_length} mm` : ''}{' '}
              {m.stock_quantity !== null ? `(${m.stock_quantity} ${m.quantity_unit})` : ''}
            </option>
          ))}
        </select>
      </label>
      {matches === true && (
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Matches what the part needs.
        </p>
      )}
      {matches === false && (
        <p className="flex items-center gap-2 text-sm font-medium text-rose-800" role="alert">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Not the grade or size this part needs.
          Check before you run.
        </p>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSave({ material_id: run.material?.id ?? null, material_note: note });
        }}
      >
        <input
          className="input"
          aria-label="Material note"
          placeholder="or type the material (manual entry)"
          value={note}
          disabled={!editable}
          onChange={(e) => setNote(e.target.value)}
        />
        {editable && <button className="btn">Save</button>}
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ first piece */

type Row = { feature: string; nominal: string; measured: string; min: number | null; max: number | null };

function fromPlan(plan: InspectionRow[]): Row[] {
  return plan.map((p) => ({
    feature: p.feature,
    nominal:
      p.nominal === null
        ? p.unit
        : p.min !== null && p.max !== null
          ? `${p.nominal} (${p.min} to ${p.max})`.slice(0, 32)
          : `${p.nominal}`,
    measured: '',
    min: p.min,
    max: p.max,
  }));
}

function check(r: Row): 'ok' | 'out' | null {
  if (r.min === null || r.max === null || !r.measured.trim()) return null;
  const v = Number(r.measured.replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  return v >= r.min - 1e-9 && v <= r.max + 1e-9 ? 'ok' : 'out';
}

function FirstPieceSection({
  run,
  canRecord,
  onSaved,
}: {
  run: Detail;
  canRecord: boolean;
  onSaved: (r: Detail) => void;
}) {
  const plan = run.inspection_plan ?? [];
  const [rows, setRows] = useState<Row[]>(() =>
    plan.length ? fromPlan(plan) : [{ feature: '', nominal: '', measured: '', min: null, max: null }],
  );
  const [result, setResult] = useState<'pass' | 'fail' | ''>('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!canRecord) {
    const fp = run.first_piece;
    return (
      <section id="first-piece" className="card space-y-2 p-4">
        <h2 className="font-semibold">First piece</h2>
        <p className="text-sm">
          Result:{' '}
          <span className={fp.result === 'pass' ? 'badge-green' : 'badge-red'}>
            {fp.result ?? 'not recorded'}
          </span>
          {fp.result === 'pass' && run.program.proven && (
            <span className="ml-2 badge-blue">program marked proven for {run.part_number}</span>
          )}
        </p>
        {fp.measurements.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Nominal</th>
                  <th>Measured</th>
                </tr>
              </thead>
              <tbody>
                {fp.measurements.map((m, i) => (
                  <tr key={i}>
                    <td>{m.feature}</td>
                    <td className="font-mono">{m.nominal || '–'}</td>
                    <td className="font-mono font-semibold">{m.measured}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {fp.notes && <p className="text-sm text-slate-700">{fp.notes}</p>}
      </section>
    );
  }

  const checks = rows.map(check);
  const out = checks.filter((c) => c === 'out').length;
  const toleranced = rows.filter((r) => r.min !== null).length;
  const okCount = checks.filter((c) => c === 'ok').length;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!result) return;
    try {
      onSaved(
        await api.post<Detail>(`/runs/${run.id}/first-piece`, {
          result,
          measurements: rows
            .filter((r) => r.feature.trim() && r.measured.trim())
            .map(({ feature, nominal, measured }) => ({ feature, nominal, measured })),
          notes,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const set = (i: number, k: 'feature' | 'nominal' | 'measured', v: string) =>
    setRows(rows.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  return (
    <form id="first-piece" onSubmit={save} className="card space-y-4 p-4" aria-label="First piece result">
      <div>
        <h2 className="text-lg font-semibold">First piece result</h2>
        <p className="text-sm text-slate-600">
          {plan.length
            ? 'Measure each dimension from the confirmed feature table. Values outside the tolerance are marked.'
            : 'Measure the first piece by hand and record the result.'}
        </p>
      </div>

      <div className="space-y-2">
        <div className="hidden grid-cols-12 gap-2 px-1 text-xs font-semibold tracking-wide text-slate-600 uppercase sm:grid">
          <span className="col-span-5">Feature</span>
          <span className="col-span-3">Nominal (limits)</span>
          <span className="col-span-3">Measured</span>
          <span className="col-span-1" />
        </div>
        {rows.map((r, i) => {
          const c = checks[i];
          const fixed = i < plan.length;
          return (
            <div
              key={i}
              className={`grid grid-cols-12 items-center gap-2 rounded-xl border p-2 ${
                c === 'out'
                  ? 'border-rose-300 bg-rose-50'
                  : c === 'ok'
                    ? 'border-emerald-200 bg-emerald-50/60'
                    : 'border-slate-200'
              }`}
            >
              {fixed ? (
                <>
                  <span className="col-span-12 px-1 font-medium sm:col-span-5">{r.feature}</span>
                  <span className="col-span-5 px-1 font-mono text-sm sm:col-span-3">
                    {plan[i].nominal === null ? (
                      <span className="font-sans text-slate-600">check with {plan[i].unit}</span>
                    ) : (
                      <>
                        <b>
                          {plan[i].nominal} {plan[i].unit}
                        </b>
                        {r.min !== null && (
                          <span className="block text-xs text-slate-600">
                            {r.min} to {r.max}
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <input
                    className="input col-span-12 sm:col-span-5"
                    placeholder="Feature (e.g. OD 40)"
                    aria-label={`feature ${i + 1}`}
                    value={r.feature}
                    onChange={(e) => set(i, 'feature', e.target.value)}
                  />
                  <input
                    className="input col-span-5 font-mono sm:col-span-3"
                    placeholder="nominal"
                    aria-label={`nominal ${i + 1}`}
                    value={r.nominal}
                    onChange={(e) => set(i, 'nominal', e.target.value)}
                  />
                </>
              )}
              <input
                className="input col-span-5 min-h-12 font-mono text-base font-semibold sm:col-span-3"
                placeholder="measured"
                aria-label={`measured ${i + 1}`}
                inputMode={r.min !== null ? 'decimal' : undefined}
                value={r.measured}
                onChange={(e) => set(i, 'measured', e.target.value)}
              />
              <span className="col-span-2 text-center text-sm font-bold sm:col-span-1">
                {c === 'ok' && <span className="text-emerald-700">OK</span>}
                {c === 'out' && <span className="text-rose-700">OUT</span>}
              </span>
            </div>
          );
        })}
        <button
          type="button"
          className="btn"
          onClick={() => setRows([...rows, { feature: '', nominal: '', measured: '', min: null, max: null }])}
        >
          Add measurement
        </button>
      </div>

      {toleranced > 0 && (
        <p
          className={`rounded-xl px-3 py-2 text-sm font-medium ${
            out
              ? 'bg-rose-100 text-rose-900'
              : okCount === toleranced
                ? 'bg-emerald-100 text-emerald-900'
                : 'bg-slate-100 text-slate-700'
          }`}
          aria-live="polite"
        >
          {out
            ? `${out} value${out > 1 ? 's are' : ' is'} outside the tolerance.`
            : okCount === toleranced
              ? 'Every toleranced value is within the limits.'
              : `${okCount} of ${toleranced} toleranced values checked.`}
        </p>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Result</legend>
        <div className="grid grid-cols-2 gap-3">
          {(['pass', 'fail'] as const).map((v) => (
            <label
              key={v}
              className={`flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 text-lg font-bold transition has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-200 ${
                result === v
                  ? v === 'pass'
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-rose-600 bg-rose-600 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
              }`}
            >
              <input
                type="radio"
                name="fp"
                className="sr-only"
                checked={result === v}
                onChange={() => setResult(v)}
              />
              {v === 'pass' ? (
                <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
              ) : (
                <XCircle className="h-6 w-6" aria-hidden="true" />
              )}
              {v === 'pass' ? 'Pass' : 'Fail'}
            </label>
          ))}
        </div>
        {result === 'pass' && out > 0 && (
          <p className="mt-2 text-sm font-medium text-rose-800" role="alert">
            Some values are outside the tolerance. Are you sure the piece passes?
          </p>
        )}
      </fieldset>

      <textarea
        className="input"
        rows={2}
        placeholder="Notes"
        aria-label="First piece notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <ErrorBox error={error} />
      <button className="btn-primary min-h-14 w-full text-base sm:w-auto sm:px-8" disabled={!result}>
        Save result
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ helpers */

function useFullscreen() {
  const supported = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!supported) return;
    const h = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, [supported]);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };
  return { supported, on, toggle };
}
