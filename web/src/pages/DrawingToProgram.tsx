import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Check } from 'lucide-react';
import {
  lazy,
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, apiUrl, getToken } from '../api/client';
import type {
  Cell,
  CellValue,
  Drawing,
  FeatureSchema,
  FeatureTable,
  FeatureTableData,
  FeatureTableSummary,
  FieldDef,
  GenOperation,
  GenPlan,
  GenPreview,
  KnownDrawingInfo,
  Machine,
  ProgramDetail,
  Suggestion,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import CompareView from '../components/CompareView';
import GcodeView from '../components/GcodeView';
import AiReadPanel from '../components/AiReadPanel';
import BrowserAiKey from '../components/BrowserAiKey';
import { browserServerMode } from '../browser-server/install';
import GeneratingCode from '../components/GeneratingCode';
import { useA11y } from '../a11y/A11yContext';
import { useToast } from '../components/Toast';
import UsbDownload from '../components/UsbDownload';
import { MachineLiveBadge } from '../components/StatusBadge';
import { useLiveStatus } from '../hooks/useLiveStatus';
import ToolpathView from '../components/ToolpathView';
import PartReport from '../components/PartReport';
import { buildPartModel } from '../lib/partModel';
import type { SimCheck } from '../cnc-sim/job';
import { ErrorBox, Notice } from '../components/ui';

/* ------------------------------------------------------------------ helpers */

type Setup = Record<string, Record<string, string>>;

// three.js loads only when the simulation is shown.
const CncSimulatorView = lazy(() => import('../cnc-sim/CncSimulatorView'));

function reducedMotionQuery(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const EMPTY: Cell = { ai: null, value: null, confirmed: false };
const filled = (c: Cell) => c.value !== null && c.value !== '';

function parseValue(kind: FieldDef['kind'], raw: string): CellValue {
  const t = raw.trim();
  if (t === '') return null;
  if (kind === 'text') return t;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : t;
}

function sourceText(s: Suggestion | null | undefined): string {
  if (!s) return 'Not found in proven programs - enter it';
  if (s.source === 'proven program for this part') return `From this part's program: ${s.note}`;
  if (s.source === 'proven program') return `From ${s.note}`;
  if (s.source === 'last saved') return `Same as ${s.note}`;
  return `From the machine tool list: ${s.note}`;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The step number the user should work on now (from "Do this now"). */
const ActiveStep = createContext<number | null>(null);

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: ReactNode;
}) {
  const active = useContext(ActiveStep) === n && !done;
  return (
    <motion.section
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={`card relative space-y-3 overflow-hidden p-4 pl-5 ${
        active ? 'shadow-[var(--shadow-glow)] ring-2 ring-brand-500/60' : ''
      }`}
      aria-label={title}
    >
      <span
        className={`absolute inset-y-0 left-0 w-1 transition-colors duration-500 ${
          done ? 'bg-emerald-500' : active ? 'bg-linear-to-b from-brand-500 to-sky-400' : 'bg-transparent'
        }`}
        aria-hidden="true"
      />
      <h2 className="flex items-center gap-2.5 font-semibold">
        <span className="relative inline-flex h-7 w-7 items-center justify-center" aria-hidden="true">
          {active && <span className="animate-pulse-ring absolute inset-0 rounded-full bg-brand-400" />}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={done ? 'done' : 'todo'}
              initial={{ scale: 0.4, rotate: -90, opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 520, damping: 26 }}
              className={`relative inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                done
                  ? 'bg-emerald-500 text-white shadow-[0_4px_12px_-4px_rgb(16_185_129/0.8)]'
                  : active
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
              }`}
            >
              {done ? <Check className="h-4 w-4" strokeWidth={3} /> : n}
            </motion.span>
          </AnimatePresence>
        </span>
        <span className="flex-1">{title}</span>
        {done && (
          <span className="badge-green" aria-hidden="true">
            Done
          </span>
        )}
        {active && (
          <span className="badge-blue" aria-hidden="true">
            Now
          </span>
        )}
        {done && <span className="sr-only">(done)</span>}
      </h2>
      {children}
    </motion.section>
  );
}

/* ------------------------------------------------------------------ drawing viewer */

const DRAWING_TYPES = 'application/pdf,image/png,image/jpeg,image/webp';

function DropZone({
  onFile,
  blocked,
  busy,
  chosen,
}: {
  onFile: (f: File) => void;
  blocked: string | null;
  busy: boolean;
  chosen: string | null;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!blocked) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !blocked) onFile(f);
      }}
      className={`flex h-[60vh] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 text-center text-sm ${
        over ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white'
      }`}
    >
      <p className="text-base font-semibold text-slate-800">Part drawing</p>
      <p className="text-slate-500">PDF, PNG, JPG or WEBP, up to 25 MB. Drag it here or choose the file.</p>
      {blocked ? (
        <p className="max-w-sm rounded-lg bg-amber-50 px-3 py-2 text-amber-900" role="note">
          {blocked}
        </p>
      ) : (
        <label className={`btn-primary cursor-pointer ${busy ? 'opacity-50' : ''}`}>
          {busy ? 'Uploading…' : 'Choose drawing file'}
          <input
            type="file"
            className="sr-only"
            accept={DRAWING_TYPES}
            aria-label="Choose drawing file"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = '';
            }}
          />
        </label>
      )}
      {chosen && (
        <p className="text-slate-700">Chosen: {chosen}. Type the part number in step 1 and press Start.</p>
      )}
    </div>
  );
}

const DRAWING_ATTEMPTS = 4;
const DRAWING_TIMEOUT_MS = 6000;

function DrawingViewer({ drawing, empty }: { drawing: Drawing | null; empty: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);

  const [attempt, setAttempt] = useState(1);
  const [reload, setReload] = useState(0);
  const drawingId = drawing?.id;
  const drawingSize = drawing?.size;

  useEffect(() => {
    if (!drawingId) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    let controller: AbortController | null = null;
    setError(null);
    setUrl(null);
    const token = getToken();

    // Download with a time limit and a size check; retry a few times if it stalls.
    async function load() {
      for (let n = 1; n <= DRAWING_ATTEMPTS && !cancelled; n++) {
        setAttempt(n);
        controller = new AbortController();
        const timer = window.setTimeout(() => controller?.abort(), DRAWING_TIMEOUT_MS);
        try {
          const r = await fetch(apiUrl(`/drawings/${drawingId}/file`), {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: controller.signal,
          });
          if (!r.ok) throw new Error(`Could not load the drawing (${r.status}).`);
          const b = await r.blob();
          if (drawingSize && b.size !== drawingSize) throw new Error('Incomplete download.');
          if (cancelled) return;
          objectUrl = URL.createObjectURL(b);
          setUrl(objectUrl);
          return;
        } catch (e) {
          if (cancelled) return;
          if (n === DRAWING_ATTEMPTS)
            setError(`Could not load the drawing after ${n} tries (${(e as Error).message}).`);
        } finally {
          window.clearTimeout(timer);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller?.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [drawingId, drawingSize, reload]);

  if (!drawing) return <>{empty}</>;
  if (error)
    return (
      <div className="space-y-2">
        <ErrorBox error={error} />
        <button className="btn" onClick={() => setReload((x) => x + 1)}>
          Try again
        </button>
      </div>
    );
  if (!url)
    return (
      <p className="text-sm text-slate-500" role="status">
        Loading drawing…{attempt > 1 ? ` (try ${attempt} of ${DRAWING_ATTEMPTS})` : ''}
      </p>
    );
  if (drawing.content_type === 'application/pdf')
    return (
      <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
          <span className="truncate font-medium">{drawing.filename}</span>
          <a className="shrink-0 text-blue-700 underline" href={url} target="_blank" rel="noreferrer">
            Open full size
          </a>
        </div>
        {/* Full-page drawing: no PDF toolbar or thumbnail side bar, fitted to the width. */}
        <iframe
          title={`Drawing ${drawing.filename}`}
          src={`${url}#toolbar=0&navpanes=0&pagemode=none&view=FitH`}
          className="h-[calc(100vh-11rem)] min-h-[420px] w-full"
        />
      </div>
    );
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        Zoom
        <input
          type="range"
          min={50}
          max={400}
          step={10}
          value={zoom}
          aria-label="Drawing zoom"
          onChange={(e) => setZoom(Number(e.target.value))}
        />
        {zoom}%
      </label>
      <div className="h-[74vh] overflow-auto rounded-xl border bg-white">
        <img src={url} alt={`Drawing ${drawing.filename}`} style={{ width: `${zoom}%`, maxWidth: 'none' }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ compact feature editor */

function ValueInput({
  def,
  cell,
  readOnly,
  onChange,
}: {
  def: FieldDef;
  cell: Cell;
  readOnly: boolean;
  onChange: (c: Cell) => void;
}) {
  const shown = cell.value === null || cell.value === undefined ? '' : String(cell.value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const unit = def.kind === 'deg' ? '°' : def.kind === 'text' ? '' : 'mm';
  return (
    <label className={`flex flex-col text-xs ${filled(cell) && cell.confirmed ? '' : 'text-amber-900'}`}>
      <span>
        {def.label}
        {unit && ` (${unit})`}
      </span>
      <span className="flex items-center gap-1">
        <input
          className="input w-24 font-mono"
          aria-label={def.label}
          value={text}
          disabled={readOnly}
          inputMode={def.kind === 'text' ? 'text' : 'decimal'}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const v = parseValue(def.kind, text);
            if (v !== cell.value) onChange({ ...cell, value: v, confirmed: false });
          }}
        />
        <input
          type="checkbox"
          className="h-5 w-5"
          aria-label={`${def.label} checked against the drawing`}
          title="Checked against the drawing"
          checked={cell.confirmed}
          disabled={readOnly || !filled(cell)}
          onChange={(e) => onChange({ ...cell, confirmed: e.target.checked })}
        />
      </span>
      {cell.ai !== null && cell.ai !== '' && cell.ai !== cell.value && (
        <span className="mt-0.5 flex items-center gap-1 text-[11px] text-brand-800">
          Read from drawing: <span className="font-mono">{String(cell.ai)}</span>
          {!readOnly && (
            <button
              type="button"
              className="underline"
              aria-label={`Use ${String(cell.ai)} for ${def.label}`}
              onClick={() => onChange({ ...cell, value: cell.ai, confirmed: false })}
            >
              use
            </button>
          )}
        </span>
      )}
    </label>
  );
}

function FeatureEditor({
  schema,
  data,
  readOnly,
  onChange,
}: {
  schema: FeatureSchema;
  data: FeatureTableData;
  readOnly: boolean;
  onChange: (d: FeatureTableData) => void;
}) {
  const typeDefs = useMemo(() => Object.fromEntries(schema.feature_types.map((t) => [t.type, t])), [schema]);
  const setFeature = (i: number, key: string, c: Cell) =>
    onChange({
      ...data,
      features: data.features.map((f, j) => (j === i ? { ...f, fields: { ...f.fields, [key]: c } } : f)),
    });
  const move = (i: number, d: -1 | 1) => {
    const f = [...data.features];
    const j = i + d;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]];
    onChange({ ...data, features: f });
  };
  const add = (type: string) =>
    onChange({
      ...data,
      features: [
        ...data.features,
        { type, fields: Object.fromEntries(typeDefs[type].fields.map((f) => [f.key, { ...EMPTY }])) },
      ],
    });
  const fromAi = (c: Cell): Cell =>
    c.ai !== null && c.ai !== '' && !filled(c) ? { ...c, value: c.ai, confirmed: false } : c;
  const allCells = [...Object.values(data.header), ...data.features.flatMap((f) => Object.values(f.fields))];
  const hasSuggestions = allCells.some((c) => c.ai !== null && c.ai !== '' && !filled(c));
  // Fills empty boxes only. Each value still has to be ticked after checking it against the drawing.
  const applyAllRead = () =>
    onChange({
      header: Object.fromEntries(Object.entries(data.header).map(([k, c]) => [k, fromAi(c)])),
      features: data.features.map((f) => ({
        ...f,
        fields: Object.fromEntries(Object.entries(f.fields).map(([k, c]) => [k, fromAi(c)])),
      })),
    });
  const tickAll = () =>
    onChange({
      header: Object.fromEntries(
        Object.entries(data.header).map(([k, c]) => [k, filled(c) ? { ...c, confirmed: true } : c]),
      ),
      features: data.features.map((f) => ({
        ...f,
        fields: Object.fromEntries(
          Object.entries(f.fields).map(([k, c]) => [k, filled(c) ? { ...c, confirmed: true } : c]),
        ),
      })),
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 rounded-lg bg-slate-50 p-3">
        {schema.header.map((def) => (
          <ValueInput
            key={def.key}
            def={def}
            cell={data.header[def.key] ?? EMPTY}
            readOnly={readOnly}
            onChange={(c) => onChange({ ...data, header: { ...data.header, [def.key]: c } })}
          />
        ))}
      </div>
      <ol className="space-y-2">
        {data.features.map((f, i) => (
          <li
            key={i}
            className={
              f.type === 'flip'
                ? 'rounded-lg border-2 border-amber-400 bg-amber-50 p-3'
                : 'rounded-lg border p-3'
            }
            aria-label={`Feature ${i + 1}`}
          >
            <div className={`flex items-center justify-between gap-2 ${f.type === 'flip' ? '' : 'mb-2'}`}>
              <span className="text-sm font-medium">
                {i + 1}. {typeDefs[f.type]?.label ?? f.type}
                {f.type === 'flip' && (
                  <span className="mt-0.5 block text-xs font-normal text-amber-900">
                    The rows below are cut after turning the part around, measured from the back face (Z0 =
                    finished back face).
                  </span>
                )}
              </span>
              {!readOnly && (
                <span className="flex gap-1">
                  <button
                    className="btn min-h-8 px-2"
                    aria-label={`Move feature ${i + 1} up`}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="btn min-h-8 px-2"
                    aria-label={`Move feature ${i + 1} down`}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="btn min-h-8 px-2"
                    aria-label={`Remove feature ${i + 1}`}
                    onClick={() => onChange({ ...data, features: data.features.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              {typeDefs[f.type]?.fields.map((def) => (
                <ValueInput
                  key={def.key}
                  def={def}
                  cell={f.fields[def.key] ?? EMPTY}
                  readOnly={readOnly}
                  onChange={(c) => setFeature(i, def.key, c)}
                />
              ))}
            </div>
          </li>
        ))}
      </ol>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-600">Add:</span>
          {schema.feature_types.map((t) => (
            <button key={t.type} className="btn min-h-8 px-2.5" onClick={() => add(t.type)}>
              + {t.label.split(' (')[0]}
            </button>
          ))}
          <span className="flex-1" />
          {hasSuggestions && (
            <button className="btn min-h-8" onClick={applyAllRead}>
              Use all values read from the drawing
            </button>
          )}
          <button className="btn min-h-8" onClick={tickAll}>
            Tick all entered values
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ setup (tools, speeds, feeds) */

function SetupEditor({
  ops,
  setup,
  onChange,
  readOnly,
}: {
  ops: GenOperation[];
  setup: Setup;
  onChange: (op: string, key: string, value: string) => void;
  readOnly: boolean;
}) {
  return (
    <div className="space-y-3">
      {ops.map((op) => (
        <fieldset key={op.key} className="rounded-lg border p-3">
          <legend className="px-1 text-sm font-semibold">{op.label}</legend>
          <div className="flex flex-wrap gap-3">
            {op.tool_types.length > 0 && (
              <label className="flex flex-col text-xs">
                <span>Tool</span>
                <select
                  className="input w-56"
                  aria-label={`${op.label} tool`}
                  value={setup[op.key]?.tool_code ?? ''}
                  disabled={readOnly}
                  onChange={(e) => onChange(op.key, 'tool_code', e.target.value)}
                >
                  <option value="">Choose…</option>
                  {op.tools.map((t) => (
                    <option key={t.tool_code} value={t.tool_code}>
                      {t.tool_code} {t.description}
                    </option>
                  ))}
                </select>
                <span className="mt-0.5 max-w-56 text-[11px] text-slate-500">
                  {op.tools.length === 0
                    ? `No ${op.tool_types.join('/')} tool on this machine - add it on the Machines page`
                    : sourceText(op.tool_suggestion)}
                </span>
              </label>
            )}
            {op.params.map((p) => {
              const v = setup[op.key]?.[p.key] ?? '';
              const missing = v === '';
              return (
                <label
                  key={p.key}
                  className={`flex flex-col text-xs ${missing ? 'text-amber-900' : ''}`}
                  title={p.hint}
                >
                  <span>
                    {p.label}
                    {p.unit && ` (${p.unit})`}
                  </span>
                  {p.kind === 'choice' ? (
                    <select
                      className="input w-32"
                      aria-label={`${op.label} ${p.label}`}
                      value={v}
                      disabled={readOnly}
                      onChange={(e) => onChange(op.key, p.key, e.target.value)}
                    >
                      <option value="">Choose…</option>
                      {p.choices.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className={`input w-28 font-mono ${missing ? 'border-amber-400' : ''}`}
                      aria-label={`${op.label} ${p.label}`}
                      inputMode="decimal"
                      value={v}
                      disabled={readOnly}
                      onChange={(e) => onChange(op.key, p.key, e.target.value.replace(',', '.'))}
                    />
                  )}
                  <span className="mt-0.5 max-w-44 text-[11px] text-slate-500">
                    {p.suggestion && String(p.suggestion.value) !== v && v !== ''
                      ? `Changed (was ${p.suggestion.value})`
                      : sourceText(p.suggestion)}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ progress, machines */

interface LibraryProgram {
  name: string;
  program_number: number;
  part_numbers: string[];
  title: string;
  sha256: string;
  text: string;
}

function Progress({ steps }: { steps: { label: string; done: boolean }[] }) {
  const current = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  const reached = current === -1 ? steps.length - 1 : current;
  const fill = steps.length > 1 ? reached / (steps.length - 1) : 0;
  return (
    <nav aria-label="Progress" className="card overflow-hidden p-4">
      <div
        className="mb-3 flex items-center justify-between text-xs font-medium text-slate-600"
        aria-hidden="true"
      >
        <span>
          <strong className="text-slate-900">
            Step {reached + 1} of {steps.length}
          </strong>{' '}
          · {steps[reached]?.label}
        </span>
        <span className="tabular-nums">
          {doneCount} of {steps.length} done
        </span>
      </div>
      <div className="relative">
        <div
          className="absolute top-[18px] h-1 rounded-full bg-slate-100"
          style={{ left: '8%', right: '8%' }}
          aria-hidden="true"
        />
        <motion.div
          className="absolute top-[18px] h-1 rounded-full bg-linear-to-r from-emerald-500 via-emerald-400 to-brand-500"
          style={{ left: '8%' }}
          initial={false}
          animate={{ width: `${fill * 84}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 22 }}
          aria-hidden="true"
        />
        <ol
          className="relative grid gap-1"
          style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
        >
          {steps.map((s, i) => {
            const now = i === current;
            return (
              <li
                key={s.label}
                aria-current={now ? 'step' : undefined}
                className="flex flex-col items-center gap-1.5 text-center"
              >
                <motion.span
                  initial={false}
                  animate={{ scale: now ? 1.12 : 1 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                  className={`relative z-[1] flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold ring-4 ring-white transition-colors duration-300 ${
                    s.done
                      ? 'bg-emerald-500 text-white'
                      : now
                        ? 'bg-brand-600 text-white shadow-[var(--shadow-glow)]'
                        : 'bg-slate-100 text-slate-500'
                  }`}
                  aria-hidden="true"
                >
                  {now && <span className="animate-pulse-ring absolute inset-0 rounded-full bg-brand-400" />}
                  <span className="relative">
                    {s.done ? <Check className="h-4 w-4" strokeWidth={3} /> : i + 1}
                  </span>
                </motion.span>
                <span
                  className={`text-xs leading-tight font-medium sm:text-[13px] ${
                    s.done ? 'text-emerald-800' : now ? 'text-brand-800' : 'text-slate-500'
                  }`}
                >
                  {s.label}
                </span>
                <span className="sr-only">{s.done ? '(done)' : now ? '(do this now)' : '(later)'}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}

/** What a machine still needs before it can receive a program over Ethernet. */
/** What a machine still needs before it can receive a program (these block sending). */
function machineGaps(m: Machine): string[] {
  const gaps: string[] = [];
  if (!(m.controller ?? '').toUpperCase().startsWith('FANUC')) gaps.push('Control not confirmed');
  if (!m.ip_address) gaps.push('Ethernet IP address not entered');
  if (!m.bridge_id) gaps.push('No bridge PC assigned');
  return gaps;
}

/** Extra safety checks that are not needed to send (they turn into warnings when missing). */
function optionalChecks(m: Machine): string[] {
  const opt: string[] = [];
  if (m.tools.length === 0) opt.push('turret tool list');
  if (m.limits_missing.length) opt.push('machine limits (rpm, size)');
  return opt;
}

const LIVE_TEXT: Record<string, string> = {
  online: 'Connected over Ethernet',
  machine_unreachable: 'Bridge connected, but the CNC does not answer over Ethernet',
  stale: 'Connection is stale (no update in the last few seconds)',
  offline: 'Not connected',
};

function ConnectionPanel({ machine }: { machine: Machine }) {
  const { live, error } = useLiveStatus(machine.id, 2000);
  const state = live?.state ?? 'offline';
  const ok = state === 'online';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl border p-3 text-sm ${ok ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}
    >
      <p className="font-semibold">
        {machine.name}: {live ? LIVE_TEXT[state] : 'Checking connection…'}
      </p>
      <p className="mt-1 text-slate-700">
        Link: this app → bridge PC at the machine
        {machine.bridge_id ? ` ("${machine.bridge_id}")` : ' (none assigned)'} → Ethernet (FANUC FOCAS) →{' '}
        {machine.ip_address ? `${machine.ip_address}:${machine.focas_port}` : 'CNC IP not entered'}.
      </p>
      {!ok && (
        <ul className="mt-1 list-disc pl-5 text-slate-700">
          {!machine.ip_address && (
            <li>Enter the CNC&apos;s IP address on the Machines page (read it at the control).</li>
          )}
          {!machine.bridge_id && (
            <li>Assign a bridge PC to this machine (Admin → Bridges, then the Machines page).</li>
          )}
          {machine.bridge_id && <li>Make sure the bridge PC is switched on and running.</li>}
          {error && <li>{error}</li>}
        </ul>
      )}
    </div>
  );
}

const CONTROLS = ['FANUC 0i-TF', 'FANUC 0i-TF Plus', 'FANUC 0i-TD', 'FANUC 0i-TC'];

/** Admin: enter what is read at the machine (control, IP, bridge) without leaving the page. */
function MachineSetupForm({ machine, onSaved }: { machine: Machine; onSaved: () => void }) {
  const [controller, setController] = useState(machine.controller ?? '');
  const [ip, setIp] = useState(machine.ip_address ?? '');
  const [bridge, setBridge] = useState(machine.bridge_id ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setController(machine.controller ?? '');
    setIp(machine.ip_address ?? '');
    setBridge(machine.bridge_id ?? '');
  }, [machine]);
  async function save() {
    try {
      await api.patch(`/machines/${machine.id}`, {
        controller: controller.trim(),
        ip_address: ip.trim() || null,
        bridge_id: bridge.trim() || null,
      });
      setMsg('Saved.');
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <details className="rounded-xl border p-3 text-sm" open={!machine.controller || !machine.ip_address}>
      <summary className="cursor-pointer font-semibold">
        Machine setup for {machine.name} (read it at the machine)
      </summary>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="flex flex-col">
          Control (from the CNC screen)
          <input
            className="input w-48"
            list="controls"
            aria-label="Control"
            value={controller}
            placeholder="e.g. FANUC 0i-TF"
            onChange={(e) => setController(e.target.value)}
          />
          <datalist id="controls">
            {CONTROLS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col">
          CNC IP address
          <input
            className="input w-40 font-mono"
            aria-label="CNC IP address"
            value={ip}
            placeholder="192.168.1.20"
            onChange={(e) => setIp(e.target.value)}
          />
        </label>
        <label className="flex flex-col">
          Bridge PC name
          <input
            className="input w-40"
            aria-label="Bridge PC name"
            value={bridge}
            placeholder="from Admin → Bridges"
            onChange={(e) => setBridge(e.target.value)}
          />
        </label>
        <button className="btn-primary" onClick={() => void save()}>
          Save machine setup
        </button>
        {msg && <span role="status">{msg}</span>}
      </div>
      <p className="mt-2 text-xs text-slate-600">
        Control: the model name on the CNC start-up screen or the SYSTEM page. IP address: on the FANUC press
        SYSTEM, then the soft key for the embedded Ethernet (EMBED PORT), page COMMON. Bridge: the name given
        when the bridge PC was registered under Admin → Bridges.
      </p>
    </details>
  );
}

interface NextAction {
  step: number;
  text: ReactNode;
}

function DoThisNow({ action }: { action: NextAction }) {
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label="Do this now"
      className="frame-flow relative overflow-hidden rounded-2xl p-4 shadow-[var(--shadow-lift)]"
    >
      <div className="flex items-start gap-3">
        <span className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white shadow-[var(--shadow-glow)]">
          <ArrowRight className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-wide text-brand-800 uppercase">
            Do this now{action.step ? ` · step ${action.step}` : ''}
          </p>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={action.step}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.22 }}
              className="mt-1 text-base text-slate-900"
            >
              {action.text}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ page */

export default function DrawingToProgram() {
  const { hasRole } = useAuth();
  const isEngineer = hasRole('engineer');
  const isProgrammer = hasRole('programmer');
  const isOperator = hasRole('operator');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tableId = params.get('table') ? Number(params.get('table')) : null;
  const machineId = params.get('machine') ? Number(params.get('machine')) : null;
  const select = (key: 'table' | 'machine', id: number | null) => {
    const next = new URLSearchParams(params);
    if (id === null) next.delete(key);
    else next.set(key, String(id));
    setParams(next, { replace: true });
  };

  const [error, setError] = useState<string | null>(null);
  const [tables, setTables] = useState<FeatureTableSummary[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [schema, setSchema] = useState<FeatureSchema | null>(null);

  // part + drawing
  const [newPart, setNewPart] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingId, setDrawingId] = useState<number | null>(null);

  // feature table
  const [ft, setFt] = useState<FeatureTable | null>(null);
  const [data, setData] = useState<FeatureTableData | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error' | null>(null);

  // generator
  const [plan, setPlan] = useState<GenPlan | null>(null);
  const [setup, setSetup] = useState<Setup>({});
  const edited = useRef<Set<string>>(new Set());
  const [programNumber, setProgramNumber] = useState('');
  const [title] = useState('');
  const [preview, setPreview] = useState<GenPreview | null>(null);
  // Drawing column shown beside the steps (remembered on this computer).
  const [showDrawing, setShowDrawing] = useState(() => {
    try {
      return localStorage.getItem('make.showDrawing') !== '0';
    } catch {
      return true;
    }
  });
  const toggleDrawing = () =>
    setShowDrawing((v) => {
      try {
        localStorage.setItem('make.showDrawing', v ? '0' : '1');
      } catch {
        /* storage blocked: not remembered */
      }
      return !v;
    });
  // The generated text that has finished its "writing" animation.
  const [typedFor, setTypedFor] = useState<string | null>(null);
  const { prefs: a11yPrefs } = useA11y();
  const animateCode = !a11yPrefs.reduceMotion && import.meta.env.MODE !== 'test' && !reducedMotionQuery();
  const [program, setProgram] = useState<ProgramDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (notice)
      toast(notice.split('. ')[0].replace(/\.$/, ''), {
        detail: notice.includes('. ') ? notice.slice(notice.indexOf('. ') + 2) : undefined,
      });
  }, [notice, toast]);
  const [tableReload, setTableReload] = useState(0);
  const [knownInfo, setKnownInfo] = useState<KnownDrawingInfo | null>(null);
  // 3D simulation safety checks of the program on screen (null until it has run)
  const [simCheck, setSimCheck] = useState<{ text: string; checks: SimCheck[]; errors: number } | null>(null);
  // Two-agent AI read of a new drawing, running in the background (job id), and whether it is on.
  const [aiJob, setAiJob] = useState<string | null>(null);
  const [aiReader, setAiReader] = useState<{ enabled: boolean; model: string | null } | null>(null);
  const [aiStatusReload, setAiStatusReload] = useState(0);
  useEffect(() => {
    api
      .get<{ enabled: boolean; model: string | null }>('/drawings/ai-reader')
      .then(setAiReader)
      .catch(() => setAiReader(null));
  }, [aiStatusReload]);
  const [aiStarting, setAiStarting] = useState(false);

  const reloadMachines = useCallback(() => {
    api
      .get<Machine[]>('/machines')
      .then(setMachines)
      .catch((e: Error) => setError(e.message));
  }, []);
  const reloadTables = useCallback(
    () =>
      api
        .get<FeatureTableSummary[]>('/feature-tables')
        .then(setTables)
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void reloadTables();
    reloadMachines();
    api
      .get<FeatureSchema>('/feature-tables/schema')
      .then(setSchema)
      .catch((e: Error) => setError(e.message));
  }, [reloadTables, reloadMachines]);

  // load the chosen part
  useEffect(() => {
    setFt(null);
    setData(null);
    setProgram(null);
    setPreview(null);
    if (!tableId) return;
    api
      .get<FeatureTable>(`/feature-tables/${tableId}`)
      .then((t) => {
        setFt(t);
        setData(t.data);
        setDirty(false);
        setSaveState(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [tableId, tableReload]);

  const partNumber = ft?.part_number ?? null;
  const loadDrawings = useCallback(() => {
    if (!partNumber) return;
    api
      .get<Drawing[]>(`/drawings?part_number=${encodeURIComponent(partNumber)}`)
      .then((d) => {
        setDrawings(d);
        setDrawingId((cur) => (cur && d.some((x) => x.id === cur) ? cur : (d[0]?.id ?? null)));
      })
      .catch((e: Error) => setError(e.message));
  }, [partNumber]);
  useEffect(() => {
    setDrawings([]);
    setDrawingId(null);
    loadDrawings();
  }, [loadDrawings]);

  useEffect(() => {
    setKnownInfo(null);
    if (!partNumber) return;
    api
      .get<KnownDrawingInfo | null>(`/drawings/known?part_number=${encodeURIComponent(partNumber)}`)
      .then((k) => setKnownInfo(k))
      .catch(() => setKnownInfo(null));
  }, [partNumber]);

  // proven programs already made for this part number (company library)
  const [library, setLibrary] = useState<LibraryProgram[]>([]);
  useEffect(() => {
    setLibrary([]);
    if (!partNumber) return;
    api
      .get<LibraryProgram[]>(`/generator/library?part_number=${encodeURIComponent(partNumber)}`)
      .then(setLibrary)
      .catch((e: Error) => setError(e.message));
  }, [partNumber]);

  async function uploadDrawing(part: string, f: File) {
    const form = new FormData();
    form.append('part_number', part);
    form.append('file', f);
    const d = await api.post<Drawing>('/drawings', form);
    const a = d.autofill;
    if (a?.job_id) {
      // the two AI agents work in the background; the panel shows them and reloads the table
      setKnownInfo(null);
      setAiJob(a.job_id);
      return d;
    }
    if (a) {
      setKnownInfo(a);
      if (a.filled) {
        setNotice(a.message);
        setTableReload((n) => n + 1);
      } else setError(a.message);
    }
    return d;
  }

  async function startPart(drawingFile: File | null = file, partNumber?: string) {
    const part = (partNumber ?? newPart).trim();
    if (!part) return;
    setBusy(true);
    setError(null);
    try {
      let id = tables.find((t) => t.part_number === part)?.id;
      if (!id) {
        const t = await api.post<FeatureTable>('/feature-tables', {
          part_number: part,
          drawing_ref: drawingFile?.name ?? '',
        });
        id = t.id;
        await reloadTables();
      }
      if (drawingFile) await uploadDrawing(part, drawingFile);
      setNewPart('');
      setFile(null);
      select('table', id);
      loadDrawings();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canUpload = isEngineer || isProgrammer;
  const uploadBlocked = !canUpload
    ? 'Uploading a drawing needs the Engineer or Programmer role. Log out and tap Engineer on the login page.'
    : !ft && !isEngineer
      ? 'Open a part in step 1 first, then upload its drawing here.'
      : null;

  // A dropped drawing with no part open: recognise it (fingerprint or part number in its
  // name), create the part and fill its values in one go.
  async function identifyAndStart(f: File) {
    if (!isEngineer) {
      setFile(f);
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', f);
      const k = await api.post<KnownDrawingInfo | null>('/drawings/identify', form);
      if (k?.not_lathe) {
        setError(k.not_lathe);
        return;
      }
      if (k) {
        setNewPart(k.part_number);
        await startPart(f, k.part_number);
        return;
      }
      setFile(f); // unknown drawing: type its part number and press Start
      setNotice(`${f.name} is not a known drawing yet: type its part number in step 1 and press Start.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleDrawingFile(f: File) {
    if (ft) void addDrawing(f);
    else if (newPart.trim()) void startPart(f);
    else void identifyAndStart(f);
  }

  async function addDrawing(f: File) {
    if (!ft) return;
    setBusy(true);
    try {
      const d = await uploadDrawing(ft.part_number, f);
      setDrawings((cur) => [d, ...cur.filter((x) => x.id !== d.id)]);
      setDrawingId(d.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // autosave the table shortly after the engineer stops typing
  const pendingData = useDebounced(data, 700);
  useEffect(() => {
    if (!dirty || !pendingData || !ft || !isEngineer) return;
    let cancelled = false;
    setSaveState('saving');
    api
      .put<FeatureTable>(`/feature-tables/${ft.id}`, { data: pendingData })
      .then((t) => {
        if (cancelled) return;
        setFt(t);
        setDirty(false);
        setSaveState('saved');
        setError(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setSaveState('error');
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingData]);

  async function confirmTable() {
    if (!ft) return;
    if (
      !window.confirm(
        `Confirm every value of part ${ft.part_number} against the drawing? You are responsible for these values.`,
      )
    )
      return;
    try {
      const t = await api.post<FeatureTable>(`/feature-tables/${ft.id}/confirm`);
      setFt(t);
      setData(t.data);
      setNotice('Feature table confirmed.');
      setError(null);
      void reloadTables();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // plan: which operations, pre-filled setup
  const tableVersion = ft?.updated_at ?? '';
  useEffect(() => {
    if (!tableId || !machineId) {
      setPlan(null);
      return;
    }
    api
      .get<GenPlan>(`/generator/plan?feature_table_id=${tableId}&machine_id=${machineId}`)
      .then((p) => {
        setPlan(p);
        setProgramNumber((cur) => cur || String(p.program_number));
        setSetup((cur) => {
          const next: Setup = {};
          for (const op of p.operations) {
            const mine = cur[op.key] ?? {};
            const row: Record<string, string> = {};
            const pick = (key: string, sug: Suggestion | null) =>
              edited.current.has(`${op.key}.${key}`) ? (mine[key] ?? '') : sug ? String(sug.value) : '';
            if (op.tool_types.length) row.tool_code = pick('tool_code', op.tool_suggestion);
            for (const prm of op.params) row[prm.key] = pick(prm.key, prm.suggestion);
            next[op.key] = row;
          }
          return next;
        });
      })
      .catch((e: Error) => setError(e.message));
  }, [tableId, machineId, tableVersion]);

  const partOff = setup.general?.part_off;
  const visibleOps = useMemo(
    () =>
      (plan?.operations ?? []).filter((o) => (o.key === 'part' ? o.needed && partOff !== 'no' : o.needed)),
    [plan, partOff],
  );

  const body = useMemo(() => {
    if (!tableId || !machineId) return null;
    const out: Record<string, Record<string, string | number>> = {};
    for (const op of plan?.operations ?? []) {
      const row = setup[op.key] ?? {};
      const conv: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(row)) {
        const prm = op.params.find((p) => p.key === k);
        conv[k] =
          prm && prm.kind !== 'choice' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
      }
      out[op.key] = conv;
    }
    return {
      feature_table_id: tableId,
      machine_id: machineId,
      program_number: Number(programNumber) || 0,
      title: title.trim(),
      setup: out,
    };
  }, [tableId, machineId, plan, setup, programNumber, title]);

  // the program is generated when the user presses "Generate live program"
  const [generating, setGenerating] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const bodyKey = JSON.stringify(body) + tableVersion;
  const stale = !!preview && generatedKey !== bodyKey;
  // The proven program loaded into step 4 instead of a generated one (copied line for line).
  const [fromLib, setFromLib] = useState<LibraryProgram | null>(null);
  const autoLoaded = useRef('');
  useEffect(() => {
    setPreview(null);
    setGeneratedKey(null);
    setFromLib(null);
  }, [tableId, machineId]);

  // Editing the generated text on screen: checked live, saved as a new version on accept.
  const [editText, setEditText] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editCheck, setEditCheck] = useState<{
    validation: GenPreview['validation'];
    toolpath: GenPreview['toolpath'];
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const isEdited = editText !== null && !!preview?.text && editText !== preview.text;
  const debouncedEdit = useDebounced(editText, 600);
  useEffect(() => {
    if (!isEdited || debouncedEdit === null || !machineId) {
      setEditCheck(null);
      return;
    }
    let live = true;
    setChecking(true);
    const bar = Number(data?.header?.bar_diameter?.value);
    api
      .post<{ validation: GenPreview['validation']; toolpath: GenPreview['toolpath'] }>('/generator/check', {
        machine_id: machineId,
        text: debouncedEdit,
        bar_diameter: bar > 0 ? bar : null,
      })
      .then((r) => live && setEditCheck(r))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedEdit, isEdited, machineId]);

  async function generateLive() {
    if (!body) return;
    setGenerating(true);
    setFromLib(null);
    try {
      const p = await api.post<GenPreview>('/generator/preview', body);
      setEditText(null);
      setEditing(false);
      setEditCheck(null);
      setPreview(p);
      setGeneratedKey(bodyKey);
      setProgram(null);
      setError(null);
      setNotice(p.ok ? 'Program generated. Check it, then the engineer accepts it in step 5.' : null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  function changeSetup(op: string, key: string, value: string) {
    edited.current.add(`${op}.${key}`);
    setSetup((cur) => ({ ...cur, [op]: { ...(cur[op] ?? {}), [key]: value } }));
    setProgram(null);
  }

  async function acceptProgram() {
    if (!body || !machine) return;
    const what = program ? `${program.name}` : `O${String(body.program_number).padStart(4, '0')}`;
    if (
      !window.confirm(
        `Accept ${what} for ${machine.name}?\n\nYou have read the program text and played the tool path, ` +
          'and you are responsible for this program.',
      )
    )
      return;
    try {
      let id = program?.id;
      if (!id && fromLib) {
        // the proven program, byte for byte (no regeneration)
        const r = await api.post<{ program_id: number }>(`/generator/library/${fromLib.name}/use`, {
          machine_id: machine.id,
          part_number: ft?.part_number ?? '',
        });
        id = r.program_id;
      } else if (!id) {
        const r = await api.post<{ program_id: number }>('/generator/programs', body);
        id = r.program_id;
      }
      if (isEdited && editText !== null) {
        // the edit is kept as its own version on top of the generated one (who changed what)
        const v2 = await api.put<ProgramDetail>(`/programs/${id}/text`, { text: editText });
        id = v2.id;
      }
      const p = await api.post<ProgramDetail>(`/programs/${id}/approve`);
      setProgram(p);
      setNotice(
        `${p.name} v${p.version} accepted for ${p.machine_name}. Next: send it to the machine (step 6).`,
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Put the part's proven program into step 4 (checked, tool path, 3D) exactly as written. */
  async function loadLibraryProgram(lib: LibraryProgram, quiet = false) {
    if (!machineId) return;
    try {
      const bar = Number(data?.header?.bar_diameter?.value);
      const chk = await api.post<{ validation: GenPreview['validation']; toolpath: GenPreview['toolpath'] }>(
        '/generator/check',
        { machine_id: machineId, text: lib.text, bar_diameter: bar > 0 ? bar : null },
      );
      setEditText(null);
      setEditing(false);
      setEditCheck(null);
      setPreview({
        ok: true,
        problems: [],
        operations: [],
        text: lib.text,
        validation: chk.validation,
        toolpath: chk.toolpath,
        drawing: null,
        table_problem: null,
        controller_problem: null,
        notes: [],
      });
      setFromLib(lib);
      setGeneratedKey(bodyKey);
      setProgram(null);
      setError(null);
      setNotice(`${lib.name} loaded: your proven program for this part, copied line for line.`);
    } catch (e) {
      if (!quiet) setError((e as Error).message);
    }
  }

  // When the part has a proven program, step 4 starts with it (shop rule: run what is proven).
  useEffect(() => {
    if (!ft || !machineId || !plan || library.length === 0 || preview || !(isEngineer || isProgrammer))
      return;
    const key = `${ft.id}|${machineId}|${library[0].name}`;
    if (autoLoaded.current === key) return;
    autoLoaded.current = key;
    void loadLibraryProgram(library[0], true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ft, machineId, plan, library, preview, isEngineer, isProgrammer]);

  async function sendToMachine() {
    if (!program || !machineId) return;
    try {
      const run = await api.post<{ id: number }>('/runs', { machine_id: machineId, program_id: program.id });
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const sortedMachines = machines
    .filter((m) => m.status === 'in_service')
    .map((m) => ({ m, gaps: machineGaps(m) }))
    .sort((a, b) => a.gaps.length - b.gaps.length || a.m.name.localeCompare(b.m.name));
  const anyReady = sortedMachines.some((x) => x.gaps.length === 0);
  const setupMissing = visibleOps.reduce(
    (n, op) =>
      n +
      (op.tool_types.length && !setup[op.key]?.tool_code ? 1 : 0) +
      op.params.filter((prm) => (setup[op.key]?.[prm.key] ?? '') === '').length,
    0,
  );
  const selectedDrawing = drawings.find((d) => d.id === drawingId) ?? null;
  const machine = machines.find((m) => m.id === machineId) ?? null;
  const confirmed = ft?.status === 'confirmed' && !dirty;
  const allTicked =
    !!data &&
    data.features.length > 0 &&
    Object.values(data.header).every((c) => filled(c) && c.confirmed) &&
    data.features.every((f) => Object.values(f.fields).every((c) => filled(c) && c.confirmed));
  const stillNeeded: string[] =
    data && schema
      ? [
          ...schema.header
            .filter((d) => !filled(data.header[d.key] ?? EMPTY) || !(data.header[d.key] ?? EMPTY).confirmed)
            .map((d) => d.label),
          ...data.features.flatMap((f, i) =>
            (schema.feature_types.find((t) => t.type === f.type)?.fields ?? [])
              .filter((d) => !filled(f.fields[d.key] ?? EMPTY) || !(f.fields[d.key] ?? EMPTY).confirmed)
              .map((d) => `feature ${i + 1} ${d.label.toLowerCase()}`),
          ),
          ...(data.features.length === 0 ? ['at least one feature'] : []),
        ]
      : [];
  const v = isEdited ? editCheck?.validation : preview?.validation;
  const writing = !!preview?.text && typedFor !== preview.text;
  const simText = preview?.ok && v?.ok && !writing ? (editText ?? preview.text) : null;
  const simBar =
    Number(data?.header?.bar_diameter?.value) > 0
      ? Number(data?.header?.bar_diameter?.value)
      : (knownInfo?.bar_estimate?.value ?? null);
  const simLen =
    Number(data?.header?.overall_length?.value) > 0 ? Number(data?.header?.overall_length?.value) : null;
  const simResult = simCheck && simCheck.text === simText ? simCheck : null;
  const onSimChecks = useCallback(
    (checks: SimCheck[], errors: number) => {
      if (simText) setSimCheck({ text: simText, checks, errors });
    },
    [simText],
  );
  const accepted = program?.status === 'approved';
  const partModel = useMemo(() => buildPartModel(data), [data]);
  // The table holds only what the AI filled in, untouched: the AI may read the drawing again.
  const aiUntouched =
    !!ft &&
    !!data &&
    !dirty &&
    ft.source === 'drawing_reader' &&
    ft.status === 'draft' &&
    [...Object.values(data.header), ...data.features.flatMap((f) => Object.values(f.fields))].every(
      (c) => !c.confirmed && (c.value === null || c.value === '' || c.value === c.ai),
    );
  const tableEmpty =
    !!data &&
    [...Object.values(data.header), ...data.features.flatMap((f) => Object.values(f.fields))].every(
      (c) => c.value === null || c.value === '',
    );
  const machineControlOk = !!machine && (machine.controller ?? '').toUpperCase().startsWith('FANUC');
  const acceptBlockers: string[] = [];
  if (!isEngineer && !isProgrammer) acceptBlockers.push('Log in as Engineer (or Sample).');
  if (!confirmed) acceptBlockers.push('Confirm the values in step 2 first.');
  if (machine && !machineControlOk)
    acceptBlockers.push(`Enter the control of ${machine.name} under "Machine setup" in step 3.`);
  if (!preview?.ok) acceptBlockers.push('Generate the program in step 4 first.');
  else if (stale) acceptBlockers.push('You changed something: press "Generate live program" again.');
  else if (isEdited && (checking || !editCheck)) acceptBlockers.push('Checking your edit…');
  else if (v && !v.ok) acceptBlockers.push('The program has validation errors (see step 4).');
  else if (simResult && simResult.errors > 0)
    acceptBlockers.push(
      `The 3D simulation found ${simResult.errors} safety ${simResult.errors === 1 ? 'alarm' : 'alarms'} (rapid through metal, spindle off or tool past centre): fix the program in step 4.`,
    );
  const sendBlockers: string[] = [];
  if (!accepted) sendBlockers.push('The program must be accepted in step 6 first.');
  if (!isOperator) sendBlockers.push('Log in as Operator (or Sample) to send.');
  if (machine && !machine.ip_address)
    sendBlockers.push(`Enter the CNC IP address of ${machine.name} in step 3.`);
  if (machine && !machine.bridge_id) sendBlockers.push(`Enter the bridge PC of ${machine.name} in step 3.`);

  const nextAction: NextAction = (() => {
    if (!ft)
      return {
        step: 1,
        text: (
          <>
            In step 1, open your part (for example <strong>3773480M01</strong>) or type a new part number,
            choose its drawing and press <strong>Start</strong>.
          </>
        ),
      };
    if (!selectedDrawing)
      return {
        step: 1,
        text: (
          <>
            Upload the drawing of <strong>{ft.part_number}</strong>: press{' '}
            <strong>Choose drawing file</strong> in the box on the left.
          </>
        ),
      };
    if (!confirmed)
      return {
        step: 2,
        text:
          stillNeeded.length > 0 ? (
            <>
              In step 2, fill in and tick: <strong>{stillNeeded.slice(0, 4).join(', ')}</strong>
              {stillNeeded.length > 4 && ` and ${stillNeeded.length - 4} more`}. Then press{' '}
              <strong>Confirm table</strong>.
            </>
          ) : (
            <>
              In step 2, press <strong>Confirm table</strong> (all values are filled and ticked).
            </>
          ),
      };
    if (!machine) return { step: 3, text: <>In step 3, click the machine that will make this part.</> };
    if (!preview || stale)
      return {
        step: 4,
        text: (
          <>
            {stale ? 'You changed something. ' : ''}Press <strong>Generate live program</strong> in step 4.
          </>
        ),
      };
    if (!preview.ok)
      return {
        step: 4,
        text: (
          <>
            The program could not be generated yet: <strong>{preview.problems[0]}</strong>
            {preview.problems.length > 1 && ` (+${preview.problems.length - 1} more, listed in step 4)`}.
          </>
        ),
      };
    if (!accepted && !machineControlOk)
      return {
        step: 3,
        text: (
          <>
            Before accepting: the control of <strong>{machine.name}</strong> is not entered. Look at the CNC
            screen of this machine, then in step 3 open <strong>Machine setup</strong>, type the control (for
            example <strong>FANUC 0i-TF</strong>) and press <strong>Save machine setup</strong>.
          </>
        ),
      };
    if (!accepted && simResult && simResult.errors > 0)
      return {
        step: 5,
        text: (
          <>
            The 3D simulation in step 5 found{' '}
            <strong>
              {simResult.errors} safety {simResult.errors === 1 ? 'alarm' : 'alarms'}
            </strong>
            : fix the program in step 4, then generate it again.
          </>
        ),
      };
    if (!accepted)
      return {
        step: 6,
        text: (
          <>
            Read the program in step 4 and play it in the 3D simulation in step 5. If it is right, the
            engineer presses <strong>Accept program</strong> in step 6.
          </>
        ),
      };
    if (!machine.ip_address || !machine.bridge_id)
      return {
        step: 3,
        text: (
          <>
            Before sending to <strong>{machine.name}</strong>: in step 3 under <strong>Machine setup</strong>,
            enter
            {!machine.ip_address && (
              <>
                {' '}
                the <strong>CNC IP address</strong> (on the FANUC: SYSTEM key → EMBED PORT → COMMON)
              </>
            )}
            {!machine.ip_address && !machine.bridge_id && ' and'}
            {!machine.bridge_id && (
              <>
                {' '}
                the <strong>bridge PC name</strong> (Admin → Bridges)
              </>
            )}
            , then press <strong>Save machine setup</strong>.
          </>
        ),
      };
    return {
      step: 7,
      text: (
        <>
          Press <strong>Send to {machine.name}</strong> in step 7. On the run screen: pick the bar, tick the 6
          safety checks, press <strong>Send program</strong>. Then press <strong>Cycle Start</strong> at the
          machine.
        </>
      ),
    };
  })();

  return (
    <ActiveStep.Provider value={nextAction.step}>
      <div className="space-y-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            Lathe: drawing to program
            <span className="rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-800 ring-1 ring-sky-200">
              Lathe · {machine?.controller || 'FANUC 0i-TF'}
            </span>
          </h1>
          <p className="max-w-4xl text-base text-slate-700">
            Drawing in, checked lathe program out. The engineer confirms every dimension of the drawing; the
            program is written live by fixed rules from those values (OP10, and OP20 when the part is turned
            round), checked, and played in the 3D simulation before it is accepted. A part with a proven
            program uses that program. No AI writes or edits programs. The machine is always started at its
            own control.
          </p>
        </div>
        <Progress
          steps={[
            { label: 'Drawing', done: !!selectedDrawing },
            { label: 'Features confirmed', done: confirmed },
            { label: 'Lathe chosen', done: !!machine },
            { label: 'Code generated', done: !!preview?.ok && !stale && !writing },
            { label: '3D simulation', done: !!simResult && simResult.errors === 0 },
            { label: 'Accepted', done: program?.status === 'approved' },
            { label: 'Files', done: false },
          ]}
        />
        <DoThisNow action={nextAction} />
        <ErrorBox error={error} />
        {notice && (
          <div role="status" aria-live="polite">
            <Notice tone="ok">{notice}</Notice>
          </div>
        )}

        <div className="flex justify-end">
          <button className="btn text-sm" onClick={() => toggleDrawing()}>
            {showDrawing ? 'Hide drawing' : 'Show drawing'}
          </button>
        </div>
        <div className={`grid gap-4 ${showDrawing ? 'xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : ''}`}>
          {/* ---------------- left: the drawing */}
          <div className={`space-y-2 xl:sticky xl:top-4 xl:self-start ${showDrawing ? '' : 'hidden'}`}>
            {ft && (
              <div className="flex flex-wrap items-center gap-2">
                {drawings.length > 1 && (
                  <select
                    className="input w-auto"
                    aria-label="Drawing"
                    value={drawingId ?? ''}
                    onChange={(e) => setDrawingId(Number(e.target.value))}
                  >
                    {drawings.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.filename} ({d.uploaded_at.slice(0, 10)})
                      </option>
                    ))}
                  </select>
                )}
                {canUpload && drawings.length > 0 && (
                  <label className="btn cursor-pointer">
                    Upload a new revision
                    <input
                      type="file"
                      className="sr-only"
                      accept={DRAWING_TYPES}
                      aria-label="Upload drawing file"
                      disabled={busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void addDrawing(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
                {selectedDrawing && (
                  <span className="text-xs text-slate-500">
                    {selectedDrawing.filename} · by {selectedDrawing.uploaded_by_name} · SHA-256{' '}
                    {selectedDrawing.sha256.slice(0, 12)}
                  </span>
                )}
              </div>
            )}
            <DrawingViewer
              drawing={selectedDrawing}
              empty={
                <DropZone
                  onFile={handleDrawingFile}
                  blocked={uploadBlocked}
                  busy={busy}
                  chosen={file?.name ?? null}
                />
              }
            />
          </div>

          {/* ---------------- right: steps */}
          <div className="space-y-4">
            <Step n={1} title="Part and drawing" done={!!ft}>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-sm">
                  Open a part
                  <select
                    className="input w-64"
                    aria-label="Part"
                    value={tableId ?? ''}
                    onChange={(e) => select('table', e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">Choose…</option>
                    {tables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.part_number} ({t.status})
                      </option>
                    ))}
                  </select>
                </label>
                {isEngineer && (
                  <>
                    <span className="pb-2 text-sm text-slate-500">or new:</span>
                    <input
                      className="input w-44"
                      placeholder="Part number"
                      aria-label="New part number"
                      value={newPart}
                      onChange={(e) => setNewPart(e.target.value)}
                    />
                    <label className="btn cursor-pointer" title={file?.name}>
                      {file ? `Drawing: ${file.name.slice(0, 24)}` : 'Choose drawing'}
                      <input
                        type="file"
                        className="sr-only"
                        aria-label="Drawing for the new part"
                        accept={DRAWING_TYPES}
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          e.target.value = '';
                          if (f && !newPart.trim()) void identifyAndStart(f);
                          else setFile(f);
                        }}
                      />
                    </label>
                    <button
                      className="btn-primary"
                      disabled={!newPart.trim() || busy}
                      onClick={() => void startPart()}
                    >
                      Start
                    </button>
                  </>
                )}
              </div>
              {!isEngineer && (
                <p className="text-xs text-slate-500">
                  {canUpload
                    ? 'Only an engineer can start a new part. Open an existing part to upload its drawing.'
                    : 'Uploading drawings and starting parts needs the Engineer or Programmer role. Log out and tap Engineer.'}
                </p>
              )}
            </Step>

            {ft && data && schema && (
              <Step n={2} title="Features and dimensions (engineer verifies and confirms)" done={confirmed}>
                {aiJob && (
                  <AiReadPanel
                    key={aiJob}
                    jobId={aiJob}
                    onDone={(info, ok) => {
                      setKnownInfo(info);
                      if (ok && info.filled) {
                        setNotice(info.message);
                        setTableReload((n) => n + 1);
                      } else setError(info.message);
                    }}
                  />
                )}
                {!aiJob && browserServerMode && (
                  <BrowserAiKey onChange={() => setAiStatusReload((n) => n + 1)} />
                )}
                {!aiJob && aiReader && !aiReader.enabled && !knownInfo && !browserServerMode && (
                  <p className="text-xs text-slate-500">
                    AI drawing reading is off on this server, so drawings that are not known yet are filled in
                    by hand. With it on, two AI agents read every new drawing: one extracts the features, the
                    3D shape and a feature list, the second checks each value against the drawing.
                  </p>
                )}
                {!aiJob &&
                  aiReader?.enabled &&
                  selectedDrawing &&
                  isEngineer &&
                  (tableEmpty || aiUntouched) && (
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sky-200 bg-sky-50/70 px-4 py-3 text-sm">
                      <span className="flex-1 text-sky-950">
                        {tableEmpty ? 'Let the two AI agents read' : 'Read again with the two AI agents:'}{' '}
                        <b>{selectedDrawing.filename}</b>. Agent 1 extracts every feature and dimension, agent
                        2 checks each one against the drawing (most careful setting: about 20–30 minutes; keep
                        this tab open).{!tableEmpty && ' It replaces the values the AI filled in before.'}
                      </span>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={aiStarting}
                        onClick={async () => {
                          if (
                            !tableEmpty &&
                            !window.confirm(
                              'Read the drawing again with AI? The values the AI filled in before are replaced.',
                            )
                          )
                            return;
                          setAiStarting(true);
                          try {
                            const info = await api.post<KnownDrawingInfo>(
                              `/drawings/${selectedDrawing.id}/ai-read`,
                            );
                            if (info.job_id) {
                              setKnownInfo(null);
                              setAiJob(info.job_id);
                            }
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setAiStarting(false);
                          }
                        }}
                      >
                        {aiStarting ? 'Starting…' : tableEmpty ? 'Read with AI' : 'Read again with AI'}
                      </button>
                    </div>
                  )}
                {knownInfo && (
                  <Notice tone="info">
                    <p className="font-medium">
                      {knownInfo.ai
                        ? `AI read drawing ${knownInfo.title}: one agent read it and a second checked and corrected it, and the table below is filled in. Check each value against the drawing and tick it, then press Confirm table.`
                        : `Known drawing ${knownInfo.part_number}: the values below were filled for you. Check each against the drawing, tick it, then press Confirm table.`}
                    </p>
                    {knownInfo.questions && knownInfo.questions.length > 0 && (
                      <>
                        <p className="mt-1">The AI could not settle these; check them on the drawing:</p>
                        <ul className="list-disc pl-5">
                          {knownInfo.questions.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {knownInfo.bar_estimate ? (
                      <p className="mt-1">
                        Bar diameter <b>Ø{knownInfo.bar_estimate.value}</b> is not on the drawing; it is
                        worked out from the proven program: {knownInfo.bar_estimate.note} Check it against the
                        bar on the rack.
                      </p>
                    ) : (
                      knownInfo.not_on_drawing.includes('bar_diameter') && (
                        <p className="mt-1">
                          Bar diameter is not on the drawing: enter the bar size you load on the machine.
                        </p>
                      )
                    )}
                    {knownInfo.back_note && (
                      <p className="mt-1">
                        <b>Second clamping</b> (rows after "Turn part around", measured from the back face):{' '}
                        {knownInfo.back_note}
                      </p>
                    )}
                    {knownInfo.not_in_table.length > 0 && (
                      <>
                        <p className="mt-1">On the drawing but not in this table (check them on the part):</p>
                        <ul className="list-disc pl-5">
                          {knownInfo.not_in_table.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </Notice>
                )}
                <PartReport
                  model={partModel}
                  partNumber={ft.part_number}
                  drawingRef={selectedDrawing?.filename ?? ft.drawing_ref}
                  programText={writing ? null : (editText ?? preview?.text ?? null)}
                  aiOn={!!aiReader?.enabled}
                  nonTurned={knownInfo?.shape_3d?.non_turned ?? []}
                />
                <h3 className="pt-2 font-semibold">
                  Feature table: enter, check against the drawing and tick
                </h3>
                <details className="text-xs text-slate-600">
                  <summary className="cursor-pointer font-medium">How to enter the values</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    <li>Z0 is the finished front face. All diameters are diameters, not radii.</li>
                    <li>
                      List OD steps from the front face; each length is that step&apos;s own length. They must
                      get bigger towards the chuck.
                    </li>
                    <li>
                      List bores largest first; each depth is measured from the front face. A bore needs a
                      drill.
                    </li>
                    <li>
                      A chamfer or radius applies to the front corner of the OD or bore right after it.
                      Chamfer angle is measured from the axis.
                    </li>
                    <li>
                      Groove: diameter = groove bottom, position = front face to the groove&apos;s front wall.
                    </li>
                    <li>
                      Thread: metric (e.g. M24) on the OD step with the same diameter, from its front edge.
                    </li>
                    <li>Tick each value once you have checked it against the drawing.</li>
                  </ul>
                </details>
                <FeatureEditor
                  schema={schema}
                  data={data}
                  readOnly={!isEngineer}
                  onChange={(d) => {
                    setData(d);
                    setDirty(true);
                    setProgram(null);
                  }}
                />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {ft.status === 'confirmed' && !dirty ? (
                    <span className="badge-green">Confirmed by {ft.confirmed_by_name}</span>
                  ) : (
                    <span className="badge-amber">Not confirmed</span>
                  )}
                  <span className="text-xs text-slate-500" aria-live="polite">
                    {saveState === 'saving'
                      ? 'Saving…'
                      : saveState === 'saved'
                        ? 'Saved'
                        : dirty
                          ? 'Unsaved changes'
                          : ''}
                  </span>
                  {isEngineer && ft.status !== 'confirmed' && stillNeeded.length > 0 && (
                    <p
                      role="status"
                      className="order-last basis-full rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"
                    >
                      To confirm, fill in and tick: <strong>{stillNeeded.slice(0, 6).join(', ')}</strong>
                      {stillNeeded.length > 6 && ` and ${stillNeeded.length - 6} more`}.
                    </p>
                  )}
                  <span className="flex-1" />
                  {isEngineer ? (
                    <button
                      className="btn-primary"
                      disabled={dirty || !allTicked || ft.status === 'confirmed'}
                      title={allTicked ? '' : 'Every value must be entered and ticked'}
                      onClick={() => void confirmTable()}
                    >
                      Confirm table
                    </button>
                  ) : (
                    <span className="text-xs text-slate-500">
                      An engineer enters and confirms these values.
                    </span>
                  )}
                </div>
              </Step>
            )}

            {ft && (
              <Step n={3} title="Choose the lathe" done={!!machine}>
                {!anyReady && (
                  <Notice tone="warn">
                    No machine can receive a program yet. Each card lists what is still missing. Enter it on
                    the{' '}
                    <Link className="underline" to="/machines">
                      Machines page
                    </Link>{' '}
                    after checking at the machine.
                  </Notice>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  {sortedMachines.map(({ m, gaps }) => (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={m.id === machineId}
                      onClick={() => {
                        select('machine', m.id);
                        setProgram(null);
                        setProgramNumber('');
                      }}
                      className={`rounded-xl border p-3 text-left transition ${
                        m.id === machineId
                          ? 'border-brand-600 ring-2 ring-brand-200'
                          : 'hover:border-slate-400'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-base font-semibold">{m.name}</span>
                        {gaps.length === 0 ? (
                          <span className="badge-green">Recommended</span>
                        ) : (
                          <span className="badge-amber">{gaps.length} to fill in</span>
                        )}
                      </div>
                      <div className="mt-1">
                        <MachineLiveBadge machineId={m.id} />
                      </div>
                      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-sm text-slate-700">
                        <dt className="text-slate-500">Control</dt>
                        <dd>{m.controller || 'not confirmed'}</dd>
                        <dt className="text-slate-500">Ethernet</dt>
                        <dd>{m.ip_address ? `${m.ip_address}:${m.focas_port}` : 'IP not entered'}</dd>
                      </dl>
                      {gaps.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-xs text-amber-900">
                          {gaps.map((g) => (
                            <li key={g}>{g}</li>
                          ))}
                        </ul>
                      )}
                      {optionalChecks(m).length > 0 && (
                        <p className="mt-1 text-xs text-slate-500">
                          Optional checks not set up: {optionalChecks(m).join(', ')}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
                {machine && <ConnectionPanel machine={machine} />}
                {machine && hasRole('admin') && (
                  <MachineSetupForm machine={machine} onSaved={reloadMachines} />
                )}
              </Step>
            )}

            {ft && machine && plan && (
              <Step
                n={4}
                title="Bar, tools and cutting values, then generate live code"
                done={!!preview?.ok && !stale && !writing}
              >
                {library.length > 0 && fromLib && (
                  <Notice tone="info">
                    Step 4 shows <strong className="font-mono">{fromLib.name}</strong>, your proven program
                    for part {ft.part_number}, copied line for line. Accepting saves exactly this text.{' '}
                    <button
                      className="underline"
                      disabled={generating || !body}
                      onClick={() => void generateLive()}
                    >
                      Generate a new program from the drawing instead
                    </button>
                  </Notice>
                )}
                {library.length > 0 && !fromLib && (
                  <Notice tone="info">
                    Your shop already runs <strong className="font-mono">{library[0].name}</strong> for part{' '}
                    {ft.part_number}. You can generate a new program from the drawing below, or{' '}
                    <button
                      className="underline"
                      disabled={!!program || (!isEngineer && !isProgrammer)}
                      onClick={() => void loadLibraryProgram(library[0])}
                    >
                      use {library[0].name} instead
                    </button>{' '}
                    (the proven program, byte for byte). Both include the second clamping.
                  </Notice>
                )}
                {plan.geometry_problems.length > 0 && (
                  <Notice tone="warn">
                    <ul className="list-disc pl-4">
                      {plan.geometry_problems.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  </Notice>
                )}
                <div className="flex flex-wrap items-end gap-3">
                  <button
                    className="btn-primary min-h-12 px-6 text-base"
                    disabled={generating || !body}
                    onClick={() => void generateLive()}
                  >
                    {generating
                      ? 'Generating…'
                      : preview
                        ? 'Generate live program again'
                        : 'Generate live program'}
                  </button>
                  <label className="flex flex-col text-xs">
                    Program number (O)
                    <input
                      className="input w-28 font-mono"
                      aria-label="Program number"
                      inputMode="numeric"
                      value={programNumber}
                      onChange={(e) => {
                        setProgramNumber(e.target.value.replace(/\D/g, '').slice(0, 4));
                        setProgram(null);
                      }}
                    />
                  </label>
                  {stale && <span className="badge-amber">Changed since generated</span>}
                </div>
                <details open={setupMissing > 0}>
                  <summary className="cursor-pointer text-sm font-medium">
                    Tools, speeds and feeds{' '}
                    {setupMissing === 0
                      ? '(all filled from your data)'
                      : `(${setupMissing} not found in your data: fill them in)`}
                  </summary>
                  <div className="mt-2">
                    <SetupEditor
                      ops={visibleOps}
                      setup={setup}
                      onChange={changeSetup}
                      readOnly={!isProgrammer && !isEngineer}
                    />
                  </div>
                </details>
                {preview && !preview.ok && (
                  <Notice tone="warn">
                    <p className="font-medium">Could not generate yet. Still needed:</p>
                    <ul className="list-disc pl-4">
                      {preview.problems.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  </Notice>
                )}
                {preview?.ok && (
                  <>
                    {preview.notes.length > 0 && (
                      <Notice tone="info">
                        <p className="font-medium">Taken from your data (not on the drawing):</p>
                        <ul className="list-disc pl-5">
                          {preview.notes.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      </Notice>
                    )}
                    <ol className="space-y-1.5" aria-label="Operations">
                      {preview.operations.map((o, k) => {
                        const second = o.summary.startsWith('2nd side');
                        return (
                          <motion.li
                            key={k}
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: k * 0.04, duration: 0.25 }}
                            className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-sm ${
                              second ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200 bg-white'
                            }`}
                          >
                            <span
                              className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold ${
                                second ? 'bg-amber-500 text-white' : 'bg-brand-600 text-white'
                              }`}
                              aria-hidden="true"
                            >
                              {k + 1}
                            </span>
                            <span className="font-medium">{o.label}</span>
                            {o.tool_code && <span className="badge-gray font-mono">{o.tool_code}</span>}
                            {o.rpm && <span className="badge-blue">{o.rpm} rpm</span>}
                            <span className="basis-full pl-7 text-xs text-slate-600 sm:basis-auto sm:pl-0">
                              · {o.summary}
                            </span>
                          </motion.li>
                        );
                      })}
                    </ol>
                    {v && (
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className={v.ok ? 'text-emerald-800' : 'text-rose-800'}>
                          Program check: {v.errors.length} errors · {v.warnings.length} warnings
                        </span>
                        <span className={v.errors.length ? 'badge-red' : 'badge-green'} aria-hidden="true">
                          {v.errors.length ? 'Fix errors' : 'No errors'}
                        </span>
                      </p>
                    )}
                    {v && [...v.errors, ...v.warnings].length > 0 && (
                      <ul className="space-y-1.5 text-xs">
                        {[...v.errors, ...v.warnings].map((i, k) => (
                          <li
                            key={k}
                            className={`flex gap-2 rounded-lg border px-2.5 py-1.5 ${
                              i.severity === 'error'
                                ? 'border-rose-200 bg-rose-50 text-rose-900'
                                : 'border-amber-200 bg-amber-50 text-amber-900'
                            }`}
                          >
                            {i.line ? (
                              <span className="shrink-0 rounded bg-white/70 px-1.5 font-mono font-semibold">
                                line {i.line}
                              </span>
                            ) : null}
                            <span>{i.message}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {isEdited && (
                      <Notice tone="warn">
                        You edited the generated program{checking ? ' (checking…)' : ''}. The check, the tool
                        path and the comparison below are for your edited text. On accept it is saved as a new
                        version on top of the generated one, with your name.
                      </Notice>
                    )}
                    {preview.text && writing ? (
                      <GeneratingCode
                        key={preview.text}
                        text={preview.text}
                        animate={animateCode}
                        onDone={() => setTypedFor(preview.text)}
                      />
                    ) : null}
                    {preview.text &&
                      !writing &&
                      (isEngineer || isProgrammer ? (
                        <GcodeView
                          text={editText ?? preview.text}
                          original={preview.text}
                          editing={editing}
                          onEditingChange={setEditing}
                          onChange={(t) => {
                            setEditText(t === preview.text ? null : t);
                            setProgram(null);
                          }}
                        />
                      ) : (
                        <GcodeView text={preview.text} />
                      ))}
                  </>
                )}
              </Step>
            )}

            {ft && machine && preview?.ok && (
              <Step n={5} title="3D simulation" done={!!simResult && simResult.errors === 0}>
                {writing ? (
                  <p className="text-sm text-slate-600">
                    The simulation starts as soon as the program is written.
                  </p>
                ) : simText ? (
                  <Suspense fallback={<p className="text-sm text-slate-600">Loading the 3D simulation…</p>}>
                    <CncSimulatorView
                      programText={simText}
                      speed={10}
                      height={720}
                      stock={{ diameter: simBar, length: simLen }}
                      onChecks={onSimChecks}
                    />
                    {simResult && (
                      <p
                        className={`text-sm ${simResult.errors ? 'font-semibold text-rose-800' : 'text-emerald-800'}`}
                        role="status"
                      >
                        {simResult.errors
                          ? `Safety alarms: ${simResult.checks
                              .filter((c) => c.severity === 'error')
                              .map((c) => `line ${c.line}: ${c.message}`)
                              .join(' · ')}`
                          : `3D safety checks passed${simBar ? ` on a Ø${simBar} bar` : ''}: no rapid through metal, spindle on for every cut, no tool past centre.`}
                      </p>
                    )}
                  </Suspense>
                ) : (
                  <p className="text-sm text-slate-600">
                    The 3D simulation runs once the program passes the checks in step 4.
                  </p>
                )}
                {!writing &&
                  (() => {
                    const path = isEdited ? editCheck?.toolpath : preview.toolpath;
                    return path ? (
                      <details className="rounded-xl border border-slate-200 p-3">
                        <summary className="cursor-pointer text-sm font-medium">
                          2D tool path{library.length > 0 ? ` and comparison with ${library[0].name}` : ''}
                        </summary>
                        <div className="mt-3 space-y-3">
                          <ToolpathView key={isEdited ? 'edit' : 'gen'} preview={path} />
                          {library.length > 0 && (
                            <CompareView generated={path} provenName={library[0].name} />
                          )}
                        </div>
                      </details>
                    ) : null;
                  })()}
              </Step>
            )}

            {ft && machine && (preview?.ok || program) && (
              <Step n={6} title="Engineer accepts the program" done={accepted}>
                {accepted ? (
                  <p className="text-base">
                    <span className="badge-green">Accepted</span>{' '}
                    <Link className="text-blue-700 underline" to={`/programs/${program!.id}`}>
                      {program!.name} v{program!.version}
                    </Link>{' '}
                    by {program!.approved_by_name} for {program!.machine_name}. The acceptance is tied to this
                    exact text: any change makes a new version that must be accepted again.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-slate-700">
                      The engineer reads the program in step 4 and plays it in the 3D simulation in step 5,
                      then accepts it. Accepting saves the program for {machine.name} and approves it in one
                      step.
                    </p>
                    <button
                      className="btn-primary min-h-12 px-6 text-base"
                      disabled={acceptBlockers.length > 0}
                      onClick={() => void acceptProgram()}
                    >
                      Accept program
                    </button>
                    {acceptBlockers.length > 0 && (
                      <ul className="list-disc pl-5 text-sm text-amber-900">
                        {acceptBlockers.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </Step>
            )}

            {ft && machine && accepted && (
              <Step n={7} title={`Files and sending to ${machine.name}`} done={false}>
                <p className="text-sm text-slate-700">
                  Opens the run screen for {machine.name}. There you pick the bar and tick the 6 safety
                  checks; then <strong>Send program</strong> transfers it over Ethernet through the bridge PC.
                  Start is pressed at the machine (Cycle Start).
                </p>
                <button
                  className="btn-primary min-h-12 px-6 text-base"
                  disabled={sendBlockers.length > 0}
                  onClick={() => void sendToMachine()}
                >
                  Send to {machine.name}
                </button>
                {sendBlockers.length > 0 && (
                  <ul className="list-disc pl-5 text-sm text-amber-900">
                    {sendBlockers.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
                {program && (
                  <div className="border-t pt-3">
                    <UsbDownload programId={program.id} programName={program.name} />
                  </div>
                )}
              </Step>
            )}
          </div>
        </div>
      </div>
    </ActiveStep.Provider>
  );
}
