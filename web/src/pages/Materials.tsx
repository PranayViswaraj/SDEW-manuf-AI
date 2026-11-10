import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ImportPreview, ImportReport, Material, MaterialField } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox, Notice } from '../components/ui';

const FIELD_LABELS: Record<MaterialField, string> = {
  grade: 'Grade (required)',
  bar_diameter: 'Bar diameter mm (required)',
  available_length: 'Available length mm',
  stock_quantity: 'Stock quantity',
  notes: 'Notes',
};

const EMPTY = { grade: '', bar_diameter: '', available_length: '', stock_quantity: '', notes: '' };
type Draft = typeof EMPTY;

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

export default function Materials() {
  const { hasRole } = useAuth();
  const canEdit = hasRole('admin', 'engineer');
  const [items, setItems] = useState<Material[]>([]);
  const [q, setQ] = useState('');
  const [dMin, setDMin] = useState('');
  const [dMax, setDMax] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [showImport, setShowImport] = useState(false);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (q.trim()) qs.set('q', q.trim());
    if (dMin.trim()) qs.set('diameter_min', dMin.trim());
    if (dMax.trim()) qs.set('diameter_max', dMax.trim());
    api
      .get<Material[]>(`/materials?${qs}`)
      .then((d) => {
        setItems(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [q, dMin, dMax]);
  useEffect(load, [load]);

  async function save() {
    const body = {
      grade: draft.grade,
      bar_diameter: Number(draft.bar_diameter),
      available_length: num(draft.available_length),
      stock_quantity: num(draft.stock_quantity),
      notes: draft.notes,
    };
    try {
      if (editing === 'new') await api.post('/materials', body);
      else await api.put(`/materials/${editing}`, body);
      setEditing(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(m: Material) {
    if (!window.confirm(`Delete ${m.grade} Ø${m.bar_diameter}?`)) return;
    try {
      await api.del(`/materials/${m.id}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const editRow = (
    <tr>
      {(Object.keys(EMPTY) as (keyof Draft)[]).map((k) => (
        <td key={k}>
          <input
            className="input"
            aria-label={`material ${k}`}
            value={draft[k]}
            onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
          />
        </td>
      ))}
      <td className="whitespace-nowrap">
        <button className="btn-primary mr-1" onClick={() => void save()}>
          Save
        </button>
        <button className="btn" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </td>
    </tr>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Raw materials</h1>
          <p className="text-sm text-gray-600">
            Bar stock register. Search by grade or notes, or by diameter range.
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <button className="btn" onClick={() => setShowImport(!showImport)}>
              {showImport ? 'Close import' : 'Import CSV / XLSX'}
            </button>
            <button
              className="btn"
              disabled={editing !== null}
              onClick={() => {
                setDraft(EMPTY);
                setEditing('new');
              }}
            >
              Add material
            </button>
          </div>
        )}
      </div>
      {showImport && (
        <ImportWizard
          onDone={() => {
            load();
          }}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <input
          className="input w-56"
          placeholder="Search grade or notes"
          aria-label="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          className="input w-32"
          placeholder="Ø min mm"
          aria-label="Diameter min"
          value={dMin}
          onChange={(e) => setDMin(e.target.value)}
        />
        <input
          className="input w-32"
          placeholder="Ø max mm"
          aria-label="Diameter max"
          value={dMax}
          onChange={(e) => setDMax(e.target.value)}
        />
      </div>
      <ErrorBox error={error} />
      <div className="overflow-x-auto rounded border bg-white">
        <table className="table">
          <thead>
            <tr>
              <th>Grade</th>
              <th>Bar Ø (mm)</th>
              <th>Length (mm)</th>
              <th>Stock</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {editing === 'new' && editRow}
            {items.map((m) =>
              editing === m.id ? (
                <tr key={m.id} className="hidden" />
              ) : (
                <tr key={m.id}>
                  <td className="font-medium">{m.grade}</td>
                  <td>{m.bar_diameter}</td>
                  <td>{m.available_length ?? '–'}</td>
                  <td>
                    {m.stock_quantity ?? '–'} {m.stock_quantity !== null && m.quantity_unit}
                  </td>
                  <td className="text-gray-600">{m.notes}</td>
                  <td className="whitespace-nowrap">
                    {canEdit && editing === null && (
                      <>
                        <button
                          className="btn mr-1"
                          onClick={() => {
                            setDraft({
                              grade: m.grade,
                              bar_diameter: String(m.bar_diameter),
                              available_length: m.available_length === null ? '' : String(m.available_length),
                              stock_quantity: m.stock_quantity === null ? '' : String(m.stock_quantity),
                              notes: m.notes,
                            });
                            setEditing(m.id);
                          }}
                        >
                          Edit
                        </button>
                        <button className="btn" onClick={() => void remove(m)}>
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ),
            )}
            {typeof editing === 'number' && editRow}
            {items.length === 0 && editing === null && (
              <tr>
                <td colSpan={6} className="text-center text-gray-500">
                  No materials found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImportWizard({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [onDup, setOnDup] = useState<'skip' | 'update'>('skip');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(f: File | null) {
    setFile(f);
    setPreview(null);
    setReport(null);
    setError(null);
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const p = await api.post<ImportPreview>('/materials/import/preview', fd);
      setPreview(p);
      setMapping(p.suggested_mapping);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function run(dryRun: boolean) {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mapping', JSON.stringify(mapping));
    fd.append('on_duplicate', onDup);
    fd.append('dry_run', String(dryRun));
    try {
      const r = await api.post<ImportReport>('/materials/import', fd);
      setReport(r);
      setError(null);
      if (!dryRun) onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3 rounded border bg-white p-4">
      <h2 className="font-semibold">Import raw material register</h2>
      <input
        type="file"
        aria-label="Register file"
        accept=".csv,.xlsx"
        onChange={(e) => void choose(e.target.files?.[0] ?? null)}
      />
      <ErrorBox error={error} />
      {preview && (
        <>
          <p className="text-sm text-gray-600">
            {preview.row_count} rows found. Match each field to a column in your file:
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {preview.target_fields.map((f) => (
              <label key={f} className="text-sm">
                <span className="font-medium">{FIELD_LABELS[f]}</span>
                <select
                  className="input mt-1"
                  aria-label={`map ${f}`}
                  value={mapping[f] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || null })}
                >
                  <option value="">— not in file —</option>
                  {preview.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  {preview.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample_rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>If a grade + diameter already exists:</span>
            <label className="flex items-center gap-1">
              <input type="radio" checked={onDup === 'skip'} onChange={() => setOnDup('skip')} /> keep
              existing (skip)
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={onDup === 'update'} onChange={() => setOnDup('update')} /> update
              from file
            </label>
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={() => void run(true)}>
              Check (dry run)
            </button>
            <button className="btn-primary" onClick={() => void run(false)}>
              Import
            </button>
          </div>
        </>
      )}
      {report && (
        <Notice tone={report.errors ? 'warn' : 'ok'}>
          <div className="font-medium">
            {report.dry_run ? 'Dry run: ' : 'Imported: '}
            {report.created} new, {report.updated} updated, {report.skipped} skipped, {report.errors} with
            errors.
          </div>
          <ul className="mt-1 max-h-40 list-inside list-disc overflow-y-auto">
            {report.rows
              .filter((r) => r.status !== 'created')
              .map((r) => (
                <li key={r.row_number}>
                  Row {r.row_number}: {r.status.replace(/_/g, ' ')} {r.message && `– ${r.message}`}
                </li>
              ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}
