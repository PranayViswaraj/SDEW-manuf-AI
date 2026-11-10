import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  LIMIT_FIELDS,
  TOOL_TYPES,
  type Machine,
  type MachineLimits,
  type MachineState,
  type Tool,
  type ToolType,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox, Notice, NotEntered } from '../components/ui';

type LimitDraft = Record<keyof MachineLimits, string>;

function limitsToDraft(l: MachineLimits): LimitDraft {
  const d = {} as LimitDraft;
  for (const f of LIMIT_FIELDS) d[f.key] = l[f.key] === null ? '' : String(l[f.key]);
  return d;
}

function draftToLimits(d: LimitDraft): MachineLimits {
  const out = {} as Record<string, number | string | null>;
  for (const f of LIMIT_FIELDS) {
    const v = d[f.key].trim();
    out[f.key] = v === '' ? null : f.kind === 'text' ? v : Number(v);
  }
  return out as unknown as MachineLimits;
}

export default function MachineDetail() {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const canEditTools = hasRole('admin', 'programmer');
  const [machine, setMachine] = useState<Machine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    api
      .get<Machine>(`/machines/${id}`)
      .then(setMachine)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (!machine) return error ? <ErrorBox error={error} /> : <p className="text-gray-600">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/machines" className="text-sm text-blue-700 hover:underline">
          ← Machines
        </Link>
        <h1 className="text-xl font-semibold">{machine.name}</h1>
        <p className="text-sm text-gray-600">
          {machine.controller} · key <span className="font-mono">{machine.key}</span>
        </p>
      </div>
      <ErrorBox error={error} />
      {saved && <Notice tone="ok">Saved.</Notice>}

      <MachineForm
        key={machine.updated_at}
        machine={machine}
        readOnly={!isAdmin}
        onSaved={(m) => {
          setMachine(m);
          setError(null);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
        }}
        onError={setError}
      />
      <ToolTable machine={machine} canEdit={canEditTools} onChange={load} onError={setError} />
    </div>
  );
}

function MachineForm({
  machine,
  readOnly,
  onSaved,
  onError,
}: {
  machine: Machine;
  readOnly: boolean;
  onSaved: (m: Machine) => void;
  onError: (e: string) => void;
}) {
  const [f, setF] = useState({
    name: machine.name,
    make: machine.make,
    model: machine.model,
    controller: machine.controller,
    ip_address: machine.ip_address ?? '',
    focas_port: String(machine.focas_port),
    status: machine.status,
    notes: machine.notes,
    remote_control_enabled: machine.remote_control_enabled,
  });
  const [limits, setLimits] = useState<LimitDraft>(() => limitsToDraft(machine.limits));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (f.remote_control_enabled && !machine.remote_control_enabled) {
      const ok = window.confirm(
        'Turn ON remote Start / Feed hold / Stop for this machine?\n\nThe bridge config must also enable it and the machine needs a PMC start signal. The physical emergency stop is never replaced.',
      );
      if (!ok) return;
    }
    try {
      const m = await api.patch<Machine>(`/machines/${machine.id}`, {
        ...f,
        ip_address: f.ip_address.trim() || null,
        focas_port: Number(f.focas_port),
        limits: draftToLimits(limits),
      });
      onSaved(m);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  const text = (
    key: 'name' | 'make' | 'model' | 'controller' | 'ip_address' | 'focas_port',
    label: string,
  ) => (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <input
        className="input mt-1"
        aria-label={label}
        value={f[key]}
        disabled={readOnly}
        placeholder={key === 'ip_address' || key === 'model' ? 'Not entered' : ''}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <form onSubmit={save} className="space-y-4 rounded border bg-white p-4">
      <h2 className="font-semibold">Machine details</h2>
      {readOnly && <p className="text-sm text-gray-500">Only an admin can edit machine details.</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {text('name', 'Name')}
        {text('make', 'Make')}
        {text('model', 'Model')}
        {text('controller', 'Controller')}
        {text('ip_address', 'IP address')}
        {text('focas_port', 'FOCAS port')}
        <label className="block text-sm">
          <span className="font-medium">State</span>
          <select
            className="input mt-1"
            value={f.status}
            disabled={readOnly}
            onChange={(e) => setF({ ...f, status: e.target.value as MachineState })}
          >
            <option value="in_service">In service</option>
            <option value="maintenance">Maintenance</option>
            <option value="retired">Retired</option>
          </select>
        </label>
      </div>

      <div>
        <h3 className="text-sm font-semibold">Machine limits</h3>
        <p className="text-xs text-gray-500">
          From the machine nameplate / manual. Leave empty if unknown — unknown limits are never treated as
          &quot;capable&quot;.
        </p>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {LIMIT_FIELDS.map((lf) => (
            <label key={lf.key} className="block text-sm">
              <span className="font-medium">
                {lf.label} {lf.unit && <span className="text-gray-500">({lf.unit})</span>}
              </span>
              <input
                className="input mt-1"
                aria-label={lf.label}
                inputMode={lf.kind === 'text' ? 'text' : 'decimal'}
                value={limits[lf.key]}
                disabled={readOnly}
                placeholder="Not entered – from nameplate"
                onChange={(e) => setLimits({ ...limits, [lf.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={f.remote_control_enabled}
          disabled={readOnly}
          onChange={(e) => setF({ ...f, remote_control_enabled: e.target.checked })}
        />
        <span>
          <span className="font-medium">Remote control (Start / Feed hold / Stop from the web app)</span>
          <span className="block text-xs text-gray-500">
            Off by default. When off, operators press Cycle Start at the machine. Also needs the bridge config
            and a PMC start signal on the machine.
          </span>
        </span>
      </label>

      <label className="block text-sm">
        <span className="font-medium">Notes</span>
        <textarea
          className="input mt-1"
          rows={2}
          value={f.notes}
          disabled={readOnly}
          onChange={(e) => setF({ ...f, notes: e.target.value })}
        />
      </label>
      {!readOnly && <button className="btn-primary">Save machine</button>}
    </form>
  );
}

const EMPTY_TOOL = {
  station: '',
  tool_code: '',
  description: '',
  insert_type: '',
  nose_radius: '',
  tool_type: 'od_rough',
};
type ToolDraft = typeof EMPTY_TOOL;

function toolToDraft(t: Tool): ToolDraft {
  return {
    station: String(t.station),
    tool_code: t.tool_code,
    description: t.description,
    insert_type: t.insert_type,
    nose_radius: t.nose_radius === null ? '' : String(t.nose_radius),
    tool_type: t.tool_type,
  };
}

function draftToBody(d: ToolDraft) {
  return {
    station: Number(d.station),
    tool_code: d.tool_code.trim().toUpperCase(),
    description: d.description,
    insert_type: d.insert_type,
    nose_radius: d.nose_radius.trim() === '' ? null : Number(d.nose_radius),
    tool_type: d.tool_type as ToolType,
  };
}

function ToolTable({
  machine,
  canEdit,
  onChange,
  onError,
}: {
  machine: Machine;
  canEdit: boolean;
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<ToolDraft>(EMPTY_TOOL);
  const base = `/machines/${machine.id}/tools`;

  async function save() {
    try {
      if (editing === 'new') await api.post(base, draftToBody(draft));
      else if (editing !== null) await api.put(`${base}/${editing}`, draftToBody(draft));
      setEditing(null);
      onChange();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function remove(t: Tool) {
    if (!window.confirm(`Remove ${t.tool_code} from the tool list?`)) return;
    try {
      await api.del(`${base}/${t.id}`);
      onChange();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  const row = (
    <tr>
      {(['station', 'tool_code', 'description', 'insert_type', 'nose_radius'] as const).map((k) => (
        <td key={k}>
          <input
            className="input"
            aria-label={`tool ${k}`}
            value={draft[k]}
            placeholder={k === 'tool_code' ? 'T0101' : ''}
            onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
          />
        </td>
      ))}
      <td>
        <select
          className="input"
          aria-label="tool type"
          value={draft.tool_type}
          onChange={(e) => setDraft({ ...draft, tool_type: e.target.value })}
        >
          {TOOL_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </td>
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
    <div className="space-y-2 rounded border bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Turret tools</h2>
          <p className="text-xs text-gray-500">
            Tool layout and offsets must match the machine. Program validation checks tool calls against this
            list.
          </p>
        </div>
        {canEdit && editing === null && (
          <button
            className="btn"
            onClick={() => {
              setDraft(EMPTY_TOOL);
              setEditing('new');
            }}
          >
            Add tool
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Station</th>
              <th>Tool / offset</th>
              <th>Description</th>
              <th>Insert</th>
              <th>Nose R (mm)</th>
              <th>Type</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {machine.tools.map((t) =>
              editing === t.id ? (
                <Fragment key={t.id}>{row}</Fragment>
              ) : (
                <tr key={t.id}>
                  <td>{t.station}</td>
                  <td className="font-mono">{t.tool_code}</td>
                  <td>{t.description}</td>
                  <td>{t.insert_type}</td>
                  <td>{t.nose_radius ?? '–'}</td>
                  <td>{TOOL_TYPES.find((x) => x.value === t.tool_type)?.label}</td>
                  <td className="whitespace-nowrap">
                    {canEdit && editing === null && (
                      <>
                        <button
                          className="btn mr-1"
                          onClick={() => {
                            setDraft(toolToDraft(t));
                            setEditing(t.id);
                          }}
                        >
                          Edit
                        </button>
                        <button className="btn" onClick={() => void remove(t)}>
                          Remove
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ),
            )}
            {editing === 'new' && row}
            {machine.tools.length === 0 && editing !== 'new' && (
              <tr>
                <td colSpan={7} className="text-center">
                  <NotEntered what="No tools entered – turret layout not supplied yet" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
