import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { ActionResponse, Material, RunDetail as Detail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import Checklist from '../components/Checklist';
import ConfirmDialog from '../components/ConfirmDialog';
import LivePanel from '../components/LivePanel';
import { ErrorBox, Notice } from '../components/ui';

const STEPS: { status: Detail['status'][]; label: string }[] = [
  { status: ['checklist', 'send_failed'], label: 'Checklist & send' },
  { status: ['sent'], label: 'Start' },
  { status: ['running'], label: 'Running' },
  { status: ['completed'], label: 'First piece' },
  { status: ['closed'], label: 'Done' },
];

export default function RunDetail() {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const isOperator = hasRole('operator');
  const [run, setRun] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<'send' | 'start' | null>(null);
  const [busy, setBusy] = useState(false);

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
              : 'Program sent. Press Cycle Start at the machine.'
            : path === 'start'
              ? 'Cycle start sent.'
              : path === 'feed-hold'
                ? 'Feed hold sent.'
                : 'Stop (reset) sent.';
        setMessage({ tone: 'ok', text });
      } else {
        setMessage({ tone: 'warn', text: r.action.error ?? `${path} ${r.action.result}` });
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

  if (!run) return error ? <ErrorBox error={error} /> : <p className="text-gray-600">Loading…</p>;

  const editable = ['checklist', 'send_failed', 'sent'].includes(run.status);
  const active = ['checklist', 'send_failed', 'sent', 'running'].includes(run.status);
  const remote = run.machine.remote_control_enabled;
  const stepIndex = STEPS.findIndex((s) => s.status.includes(run.status));

  return (
    <div className="space-y-4">
      <div>
        <Link to="/run" className="text-sm text-blue-700 hover:underline">
          ← Run a part
        </Link>
        <h1 className="text-xl font-semibold">
          Run #{run.id}: <span className="font-mono">{run.program.name}</span> v{run.program.version} on{' '}
          {run.machine.name}
        </h1>
        <p className="text-sm text-gray-600">
          Part <span className="font-mono">{run.part_number}</span> · {run.program.title} · status{' '}
          <b data-testid="run-status">{run.status}</b>
          {run.status_note && <span className="ml-2 text-amber-800">{run.status_note}</span>}
        </p>
        {run.status !== 'aborted' && (
          <ol className="mt-2 flex flex-wrap gap-2 text-xs">
            {STEPS.map((s, i) => (
              <li
                key={s.label}
                className={`rounded px-2 py-1 ${i < stepIndex ? 'bg-green-100 text-green-800' : i === stepIndex ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}`}
              >
                {i + 1}. {s.label}
              </li>
            ))}
          </ol>
        )}
      </div>
      <ErrorBox error={error} />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <Notice tone="warn">
        The machine&apos;s red emergency stop is the only emergency stop. Use it in any emergency.
      </Notice>

      <LivePanel live={run.live} />

      <MaterialSection run={run} editable={editable && isOperator} onSave={(b) => void put('material', b)} />

      <Checklist
        items={run.checklist}
        disabled={!editable || !isOperator}
        onToggle={(key, ticked) => void put('checklist', { item: key, ticked })}
      />

      {active && isOperator && (
        <section className="space-y-3 rounded border bg-white p-4" aria-label="Machine actions">
          <h2 className="font-semibold">Machine</h2>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-primary"
              disabled={busy || run.send_blockers.length > 0}
              onClick={() => setConfirm('send')}
            >
              Send program
            </button>
            {remote && (
              <>
                <button
                  className="btn-primary"
                  disabled={busy || run.start_blockers.length > 0}
                  onClick={() => setConfirm('start')}
                >
                  Start
                </button>
                <button
                  className="btn-danger"
                  disabled={busy || !['sent', 'running'].includes(run.status)}
                  onClick={() => void action('feed-hold')}
                >
                  Feed hold
                </button>
                <button
                  className="btn-danger"
                  title="Program reset through the control. NOT an emergency stop."
                  disabled={busy || !['sent', 'running'].includes(run.status)}
                  onClick={() => void action('stop')}
                >
                  Stop
                </button>
              </>
            )}
          </div>
          {!remote && ['sent', 'running'].includes(run.status) && (
            <p className="rounded bg-blue-50 p-2 text-sm font-medium text-blue-900" role="status">
              {run.status === 'sent'
                ? 'Program sent. Press Cycle Start at the machine.'
                : 'Running — started at the machine. Use the machine panel for Feed hold / Reset.'}
            </p>
          )}
          {!remote && run.status !== 'sent' && run.status !== 'running' && (
            <p className="text-xs text-gray-500">
              Remote control is off for this machine: after sending, press Cycle Start at the machine.
            </p>
          )}
          <Blockers title="Send is locked because" items={run.send_blockers} show={run.status !== 'sent'} />
          {remote && (
            <Blockers
              title="Start is locked because"
              items={run.start_blockers}
              show={run.status === 'sent'}
            />
          )}
          {isOperator && active && (
            <button
              className="text-xs text-gray-500 underline"
              onClick={() => {
                if (window.confirm('Abort this run in ManufAI? This does not stop the machine.'))
                  void api.post<Detail>(`/runs/${id}/abort`).then(setRun);
              }}
            >
              Abort run (no machine action)
            </button>
          )}
        </section>
      )}

      {(run.status === 'completed' || run.status === 'closed') && (
        <FirstPieceSection run={run} canRecord={isOperator && run.status === 'completed'} onSaved={setRun} />
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
    </div>
  );
}

function Blockers({ title, items, show }: { title: string; items: string[]; show: boolean }) {
  if (!show || items.length === 0) return null;
  return (
    <div className="text-sm">
      <div className="font-medium text-gray-700">{title}:</div>
      <ul className="list-inside list-disc text-amber-900">
        {items.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    </div>
  );
}

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

  return (
    <section className="space-y-2 rounded border bg-white p-4" aria-label="Raw material">
      <h2 className="font-semibold">Raw material</h2>
      <p className="text-sm">
        Required:{' '}
        {req ? (
          <b>
            {req.material_grade} bar Ø{req.bar_diameter} mm (length {req.overall_length} mm part)
          </b>
        ) : (
          <span className="italic text-amber-800">
            not known — no confirmed feature table; enter it below
          </span>
        )}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <select
          className="input"
          aria-label="Material from register"
          value={run.material?.id ?? ''}
          disabled={!editable}
          onChange={(e) =>
            onSave({ material_id: e.target.value ? Number(e.target.value) : null, material_note: note })
          }
        >
          <option value="">— choose from the register —</option>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.grade} Ø{m.bar_diameter}{' '}
              {m.stock_quantity !== null ? `(${m.stock_quantity} ${m.quantity_unit})` : ''}
            </option>
          ))}
        </select>
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
      </div>
    </section>
  );
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
  const [rows, setRows] = useState([{ feature: '', nominal: '', measured: '' }]);
  const [result, setResult] = useState<'pass' | 'fail' | ''>('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!canRecord) {
    const fp = run.first_piece;
    return (
      <section className="space-y-2 rounded border bg-white p-4">
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
          <ul className="list-inside list-disc text-sm">
            {fp.measurements.map((m, i) => (
              <li key={i}>
                {m.feature}: nominal {m.nominal || '–'}, measured {m.measured}
              </li>
            ))}
          </ul>
        )}
        {fp.notes && <p className="text-sm text-gray-700">{fp.notes}</p>}
      </section>
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!result) return;
    try {
      onSaved(
        await api.post<Detail>(`/runs/${run.id}/first-piece`, {
          result,
          measurements: rows.filter((r) => r.feature.trim() && r.measured.trim()),
          notes,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 rounded border bg-white p-4" aria-label="First piece result">
      <h2 className="font-semibold">First piece result</h2>
      <p className="text-sm text-gray-600">Measure the first piece by hand and record the result.</p>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-3 gap-2">
          {(['feature', 'nominal', 'measured'] as const).map((k) => (
            <input
              key={k}
              className="input"
              placeholder={k === 'feature' ? 'Feature (e.g. OD 40)' : k}
              aria-label={`${k} ${i + 1}`}
              value={r[k]}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))}
            />
          ))}
        </div>
      ))}
      <button
        type="button"
        className="btn"
        onClick={() => setRows([...rows, { feature: '', nominal: '', measured: '' }])}
      >
        Add measurement
      </button>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input type="radio" name="fp" checked={result === 'pass'} onChange={() => setResult('pass')} /> Pass
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="fp" checked={result === 'fail'} onChange={() => setResult('fail')} /> Fail
        </label>
      </div>
      <textarea
        className="input"
        rows={2}
        placeholder="Notes"
        aria-label="First piece notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <ErrorBox error={error} />
      <button className="btn-primary" disabled={!result}>
        Save result
      </button>
    </form>
  );
}
