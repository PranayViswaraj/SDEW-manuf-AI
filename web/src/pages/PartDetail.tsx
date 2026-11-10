import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Cell, CellValue, FeatureSchema, FeatureTable, FeatureTableData, FieldDef } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import CapablePanel from '../components/CapablePanel';
import { ErrorBox, PageLoading, Notice } from '../components/ui';

const UNIT: Record<FieldDef['kind'], string> = { mm: 'mm', deg: '°', tol: 'mm', text: '' };

function show(v: CellValue): string {
  return v === null || v === undefined ? '' : String(v);
}

function parse(kind: FieldDef['kind'], raw: string): CellValue {
  const t = raw.trim();
  if (t === '') return null;
  if (kind === 'text') return t;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : t; // server rejects non-numbers with a clear message
}

function CellRow({
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
  const [text, setText] = useState(show(cell.value));
  useEffect(() => setText(show(cell.value)), [cell.value]);
  const missing = cell.value === null || cell.value === '' || !cell.confirmed;
  return (
    <tr className={missing ? 'bg-amber-50/50' : ''}>
      <td className="whitespace-nowrap">
        {def.label} {UNIT[def.kind] && <span className="text-xs text-gray-500">({UNIT[def.kind]})</span>}
      </td>
      <td className="font-mono text-gray-500" title="Suggested by the drawing reader">
        {show(cell.ai) || '–'}
        {!readOnly && cell.ai !== null && cell.ai !== '' && (
          <button
            className="ml-2 text-xs text-blue-700 underline"
            onClick={() => onChange({ ...cell, value: cell.ai, confirmed: false })}
          >
            use
          </button>
        )}
      </td>
      <td>
        <input
          className="input w-36 font-mono"
          aria-label={`${def.label} value`}
          value={text}
          disabled={readOnly}
          inputMode={def.kind === 'text' ? 'text' : 'decimal'}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const v = parse(def.kind, text);
            // Changing a value always clears its confirmation tick.
            if (v !== cell.value) onChange({ ...cell, value: v, confirmed: false });
          }}
        />
      </td>
      <td>
        <input
          type="checkbox"
          className="h-5 w-5"
          aria-label={`${def.label} confirmed`}
          checked={cell.confirmed}
          disabled={readOnly || cell.value === null || cell.value === ''}
          onChange={(e) => onChange({ ...cell, confirmed: e.target.checked })}
        />
      </td>
    </tr>
  );
}

export default function PartDetail() {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const isEngineer = hasRole('engineer');
  const [schema, setSchema] = useState<FeatureSchema | null>(null);
  const [ft, setFt] = useState<FeatureTable | null>(null);
  const [data, setData] = useState<FeatureTableData | null>(null);
  const [dirty, setDirty] = useState(false);
  const [newType, setNewType] = useState('od');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<FeatureTable>(`/feature-tables/${id}`)
      .then((d) => {
        setFt(d);
        setData(d.data);
        setDirty(false);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    api
      .get<FeatureSchema>('/feature-tables/schema')
      .then(setSchema)
      .catch((e: Error) => setError(e.message));
  }, []);

  const typeDefs = useMemo(
    () => Object.fromEntries((schema?.feature_types ?? []).map((t) => [t.type, t])),
    [schema],
  );

  if (!ft || !data || !schema) return error ? <ErrorBox error={error} /> : <PageLoading />;
  const readOnly = !isEngineer;

  function update(next: FeatureTableData) {
    setData(next);
    setDirty(true);
    setSaved(null);
  }

  function emptyFields(type: string): Record<string, Cell> {
    return Object.fromEntries(
      typeDefs[type].fields.map((f) => [f.key, { ai: null, value: null, confirmed: false }]),
    );
  }

  function move(i: number, d: -1 | 1) {
    const f = [...data!.features];
    const j = i + d;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]];
    update({ ...data!, features: f });
  }

  async function save() {
    try {
      const d = await api.put<FeatureTable>(`/feature-tables/${id}`, { data });
      setFt(d);
      setData(d.data);
      setDirty(false);
      setError(null);
      setSaved(
        ft!.status === 'confirmed' && d.status === 'draft'
          ? 'Saved. The table must be confirmed again.'
          : 'Saved.',
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function confirmTable() {
    if (
      !window.confirm(`Confirm every value of part ${ft!.part_number}? You are responsible for these values.`)
    )
      return;
    try {
      const d = await api.post<FeatureTable>(`/feature-tables/${id}/confirm`);
      setFt(d);
      setData(d.data);
      setError(null);
      setSaved('Feature table confirmed.');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const allTicked =
    Object.values(data.header).every((c) => c.value !== null && c.value !== '' && c.confirmed) &&
    data.features.length > 0 &&
    data.features.every((f) =>
      Object.values(f.fields).every((c) => c.value !== null && c.value !== '' && c.confirmed),
    );

  const head = (
    <thead>
      <tr>
        <th>Value</th>
        <th>AI value</th>
        <th>Confirmed value</th>
        <th>Confirmed</th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-4">
      <div>
        <Link to="/parts" className="text-sm text-blue-700 hover:underline">
          ← Parts
        </Link>
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
          Part <span className="font-mono">{ft.part_number}</span>
          {ft.status === 'confirmed' ? (
            <span className="badge-green">confirmed</span>
          ) : (
            <span className="badge-amber">draft</span>
          )}
        </h1>
        <p className="text-sm text-gray-600">
          {ft.drawing_ref && <>Drawing {ft.drawing_ref} · </>}
          {ft.status === 'confirmed'
            ? `Confirmed by ${ft.confirmed_by_name}${ft.confirmed_at ? ` on ${ft.confirmed_at.slice(0, 16).replace('T', ' ')} UTC` : ''}`
            : `${ft.unconfirmed.length} values still to enter / confirm`}
        </p>
      </div>
      <ErrorBox error={error} />
      {saved && <Notice tone="ok">{saved}</Notice>}
      {ft.source === 'drawing_reader' && (
        <Notice>
          Created from a drawing. The AI reader is not available yet, so the AI column is empty. Enter every
          value by hand.
        </Notice>
      )}
      {readOnly && (
        <p className="text-sm text-gray-500">Only an engineer can edit or confirm a feature table.</p>
      )}

      <section className="rounded border bg-white p-4">
        <h2 className="mb-2 font-semibold">Part</h2>
        <table className="table">
          {head}
          <tbody>
            {schema.header.map((def) => (
              <CellRow
                key={def.key}
                def={def}
                cell={data.header[def.key]}
                readOnly={readOnly}
                onChange={(c) => update({ ...data, header: { ...data.header, [def.key]: c } })}
              />
            ))}
          </tbody>
        </table>
      </section>

      {data.features.map((f, i) => (
        <section key={i} className="rounded border bg-white p-4" aria-label={`Feature ${i + 1}`}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">
              {i + 1}. {typeDefs[f.type]?.label ?? f.type}
            </h2>
            {!readOnly && (
              <div className="flex gap-1">
                <button className="btn" aria-label={`Move feature ${i + 1} up`} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="btn" aria-label={`Move feature ${i + 1} down`} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button
                  className="btn"
                  onClick={() => update({ ...data, features: data.features.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
          <table className="table">
            {head}
            <tbody>
              {typeDefs[f.type]?.fields.map((def) => (
                <CellRow
                  key={def.key}
                  def={def}
                  cell={f.fields[def.key]}
                  readOnly={readOnly}
                  onChange={(c) => {
                    const features = data.features.map((x, j) =>
                      j === i ? { ...x, fields: { ...x.fields, [def.key]: c } } : x,
                    );
                    update({ ...data, features });
                  }}
                />
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input w-56"
            aria-label="New feature type"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
          >
            {schema.feature_types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() =>
              update({
                ...data,
                features: [...data.features, { type: newType, fields: emptyFields(newType) }],
              })
            }
          >
            Add feature
          </button>
          <span className="flex-1" />
          <button className="btn-primary" disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
          <button
            className="btn-primary"
            disabled={dirty || !allTicked || ft.status === 'confirmed'}
            title={dirty ? 'Save first' : allTicked ? '' : 'Every value must be entered and ticked'}
            onClick={() => void confirmTable()}
          >
            Confirm table
          </button>
        </div>
      )}

      {ft.status === 'confirmed' && !dirty && <CapablePanel featureTableId={ft.id} />}

      {ft.programs.length > 0 && (
        <section className="rounded border bg-white p-4 text-sm">
          <h2 className="mb-1 font-semibold">Programs for this part</h2>
          <ul>
            {ft.programs.map((p) => (
              <li key={p.id}>
                <Link to={`/programs/${p.id}`} className="font-mono text-blue-700 hover:underline">
                  {p.name} v{p.version}
                </Link>{' '}
                ({p.status})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
