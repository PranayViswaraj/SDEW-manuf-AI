import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Issue, ProgramDetail as Detail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ProgramStatusBadge, ProvenBadge } from '../components/ProgramStatusBadge';
import MachiningView from '../components/MachiningView';
import ToolpathView from '../components/ToolpathView';
import GcodeEditor from '../components/GcodeEditor';
import UsbDownload from '../components/UsbDownload';
import { ErrorBox, PageLoading, Notice } from '../components/ui';

const SEV_CLS: Record<Issue['severity'], string> = {
  error: 'border-red-300 bg-red-50 text-red-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  info: 'border-gray-200 bg-gray-50 text-gray-700',
};

export default function ProgramDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const isProgrammer = hasRole('programmer');
  // accepting and correcting a program: engineer or programmer (shop decision, 13 Nov 2026)
  const canEdit = hasRole('programmer', 'engineer');
  const [p, setP] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api
      .get<Detail>(`/programs/${id}`)
      .then((d) => {
        setP(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  useEffect(() => {
    if (highlight === null || !textRef.current) return;
    const el = textRef.current.querySelector(`[data-line="${highlight}"]`);
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'center' });
  }, [highlight]);

  async function act(path: string, body?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      const d = await api.post<Detail>(`/programs/${id}/${path}`, body);
      setP(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveVersion() {
    try {
      const d = await api.put<Detail>(`/programs/${id}/text`, { text: draft });
      setEditing(false);
      navigate(`/programs/${d.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!p) return error ? <ErrorBox error={error} /> : <PageLoading />;
  const v = p.validation;
  const issues = [...v.errors, ...v.warnings, ...v.infos];
  const lineIssues = new Map<number, Issue['severity']>();
  for (const i of issues) if (i.line && !lineIssues.has(i.line)) lineIssues.set(i.line, i.severity);

  return (
    <div className="space-y-4">
      <div>
        <Link to="/programs" className="text-sm text-blue-700 hover:underline">
          ← Programs
        </Link>
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
          <span className="font-mono">{p.name}</span> <span className="text-gray-600">{p.title}</span>
          <ProgramStatusBadge status={p.status} /> <ProvenBadge proven={p.proven} />
        </h1>
        <p className="text-sm text-gray-600">
          Part <span className="font-mono">{p.part_number}</span> · {p.machine_name} · version {p.version}
          {!p.is_latest && <span className="ml-2 badge-amber">not the latest version</span>}
        </p>
      </div>
      <ErrorBox error={error} />

      <div className="grid grid-cols-1 gap-3 rounded border bg-white p-4 text-sm sm:grid-cols-2">
        <div>
          <div className="text-xs text-gray-500">SHA-256 (exact text)</div>
          <div className="break-all font-mono text-xs">{p.sha256}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Source</div>
          <div>{p.source_note || p.source}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Approval</div>
          <div>
            {p.status === 'approved'
              ? `Approved by ${p.approved_by_name ?? '?'} on ${p.approved_at?.slice(0, 16).replace('T', ' ')} UTC`
              : p.status_note || 'Not approved'}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Can be sent to {p.machine_name}?</div>
          <div>
            {p.sendable_problem ? <span className="text-red-800">No — {p.sendable_problem}</span> : 'Yes'}
          </div>
        </div>
        {!p.sendable_problem && (
          <div className="sm:col-span-2">
            <UsbDownload programId={p.id} programName={`O${String(p.program_number).padStart(4, '0')}`} />
          </div>
        )}
        {p.proven_note && (
          <div className="sm:col-span-2">
            <div className="text-xs text-gray-500">Proven</div>
            <div>{p.proven_note}</div>
          </div>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {p.is_latest && (p.status === 'draft' || p.status === 'rejected') && (
            <button
              className="btn-primary"
              disabled={!v.ok}
              title={v.ok ? '' : 'Fix the validation errors first'}
              onClick={() =>
                void act(
                  'approve',
                  undefined,
                  `Approve ${p.name} v${p.version} for ${p.machine_name}?\n\nYou confirm you have read all ${v.warnings.length} warnings and checked the tool path.`,
                )
              }
            >
              Approve
            </button>
          )}
          {isProgrammer && p.status !== 'retired' && p.status !== 'rejected' && (
            <button
              className="btn"
              onClick={() => {
                const reason = window.prompt('Reason for rejecting this program:');
                if (reason) void act('reject', { reason });
              }}
            >
              Reject
            </button>
          )}
          {isProgrammer && p.status !== 'retired' && (
            <button
              className="btn"
              onClick={() => void act('retire', undefined, `Retire ${p.name} v${p.version}?`)}
            >
              Retire
            </button>
          )}
          {p.is_latest && !editing && (
            <button
              className="btn"
              onClick={() => {
                setDraft(p.lines.join('\n'));
                setEditing(true);
              }}
            >
              Edit (new version)
            </button>
          )}
        </div>
      )}

      {editing && (
        <div className="space-y-2 rounded border bg-white p-4">
          <Notice tone="warn">
            Saving creates version {p.version + 1} as a draft. Approval of this program is cleared until the
            new version is approved.
          </Notice>
          <div className="overflow-hidden rounded-xl ring-1 ring-slate-900/10">
            <GcodeEditor
              value={draft}
              onChange={setDraft}
              changed={
                new Set(
                  draft
                    .split('\n')
                    .map((l, i) => (l !== p.lines[i] ? i + 1 : 0))
                    .filter(Boolean),
                )
              }
            />
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => void saveVersion()}>
              Save as new version
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <section className="space-y-2 rounded border bg-white p-4">
        <h2 className="font-semibold">
          Validation{' '}
          <span className="text-sm font-normal text-gray-600">
            {v.errors.length} errors · {v.warnings.length} warnings
          </span>
        </h2>
        {issues.length === 0 && <p className="text-sm text-green-800">No issues.</p>}
        <ul className="space-y-1">
          {issues.map((i, k) => (
            <li key={k} className={`rounded border px-2 py-1 text-sm ${SEV_CLS[i.severity]}`}>
              <span className="mr-2 font-semibold uppercase">{i.severity}</span>
              {i.line && (
                <button className="mr-2 font-mono underline" onClick={() => setHighlight(i.line)}>
                  line {i.line}
                </button>
              )}
              {i.message}
            </li>
          ))}
        </ul>
      </section>

      <MachiningView programId={p.id} />

      <ToolpathView programId={p.id} selectedLine={highlight} onSelectLine={setHighlight} />

      <section className="rounded border bg-white">
        <h2 className="border-b px-4 py-2 font-semibold">Program text</h2>
        <div
          ref={textRef}
          className="max-h-[32rem] overflow-auto font-mono text-xs"
          aria-label="Program text"
        >
          {p.lines.map((ln, i) => {
            const n = i + 1;
            const sev = lineIssues.get(n);
            const bg =
              n === highlight
                ? 'bg-blue-100'
                : sev === 'error'
                  ? 'bg-red-50'
                  : sev === 'warning'
                    ? 'bg-amber-50'
                    : '';
            return (
              <div key={n} data-line={n} className={`flex ${bg}`} onClick={() => setHighlight(n)}>
                <span className="w-12 shrink-0 select-none pr-2 text-right text-gray-400">{n}</span>
                <span className="whitespace-pre">{ln || ' '}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded border bg-white p-4 text-sm">
        <h2 className="mb-2 font-semibold">Versions</h2>
        <ul className="space-y-1">
          {p.versions.map((x) => (
            <li key={x.id}>
              <Link
                to={`/programs/${x.id}`}
                className={x.id === p.id ? 'font-semibold' : 'text-blue-700 hover:underline'}
              >
                v{x.version}
              </Link>{' '}
              <ProgramStatusBadge status={x.status} />{' '}
              <span className="font-mono text-xs text-gray-500">{x.sha256.slice(0, 12)}…</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
