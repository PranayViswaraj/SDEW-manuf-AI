import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Box,
  CheckCircle2,
  CircleAlert,
  ListChecks,
  ScanSearch,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AiJob, KnownDrawingInfo } from '../api/types';
import { CountUp } from './motion';

const ease = [0.22, 1, 0.36, 1] as const;

type AgentState = 'waiting' | 'working' | 'done' | 'failed';

function stateOf(job: AiJob | null, agent: 1 | 2): AgentState {
  if (!job) return agent === 1 ? 'working' : 'waiting';
  // round stays 0 until agent 2 starts: tells which agent stopped
  if (job.status === 'failed') {
    if (agent === 1) return job.round === 0 ? 'failed' : 'done';
    return job.round === 0 ? 'waiting' : 'failed';
  }
  if (job.status === 'done') return 'done';
  if (agent === 1) return job.stage === 'queued' || job.stage === 'extract' ? 'working' : 'done';
  return job.stage === 'verify' ? 'working' : 'waiting';
}

function AgentCard({
  n,
  title,
  does,
  state,
  detail,
  icon: Icon,
}: {
  n: 1 | 2;
  title: string;
  does: string[];
  state: AgentState;
  detail: string;
  icon: typeof ScanSearch;
}) {
  const reduce = useReducedMotion();
  const tone =
    state === 'working'
      ? 'border-sky-300 bg-sky-50/80 shadow-[0_0_0_4px_rgba(56,189,248,0.12)]'
      : state === 'done'
        ? 'border-emerald-300 bg-emerald-50/70'
        : state === 'failed'
          ? 'border-rose-300 bg-rose-50/70'
          : 'border-slate-200 bg-white/70';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease, delay: n === 2 ? 0.08 : 0 }}
      className={`relative overflow-hidden rounded-2xl border p-4 transition-colors duration-500 ${tone}`}
      aria-live="polite"
    >
      {state === 'working' && !reduce && (
        <motion.div
          aria-hidden="true"
          className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-sky-200/50 to-transparent"
          animate={{ x: ['0%', '400%'] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'linear' }}
        />
      )}
      <div className="relative flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            state === 'done'
              ? 'bg-emerald-600 text-white'
              : state === 'working'
                ? 'bg-sky-600 text-white'
                : state === 'failed'
                  ? 'bg-rose-600 text-white'
                  : 'bg-slate-200 text-slate-500'
          }`}
        >
          {state === 'done' ? (
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          ) : state === 'failed' ? (
            <CircleAlert className="h-5 w-5" aria-hidden="true" />
          ) : (
            <motion.span
              animate={state === 'working' && !reduce ? { rotate: 360 } : { rotate: 0 }}
              transition={{ duration: 2.4, repeat: state === 'working' ? Infinity : 0, ease: 'linear' }}
              className="inline-flex"
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </motion.span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Agent {n}</p>
          <p className="font-semibold text-slate-900">{title}</p>
          <p className="mt-0.5 text-sm text-slate-700">{detail}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {does.map((d) => (
              <li
                key={d}
                className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-xs text-slate-600"
              >
                {d}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Live view of the two-agent AI read of a drawing: agent 1 extracts (features, 3D shape analysis,
 * feature list), agent 2 verifies every value against the drawing. Polls the server; the page
 * stays responsive the whole time. Shows the result summary when both are done.
 */
export default function AiReadPanel({
  jobId,
  onDone,
}: {
  jobId: string;
  onDone: (info: KnownDrawingInfo & { filled: boolean; message: string }, ok: boolean) => void;
}) {
  const [job, setJob] = useState<AiJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const poll = async () => {
      try {
        const j = await api.get<AiJob>(`/drawings/ai-jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        if (j.status === 'running') timer = window.setTimeout(poll, 1200);
        else doneRef.current(j.info, j.status === 'done');
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void poll();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [jobId]);

  const s1 = stateOf(job, 1);
  const s2 = stateOf(job, 2);
  const info = job?.info;
  const counts = info?.check_counts;
  const shape = info?.shape_3d;
  const secs = job ? Math.round(job.elapsed) : 0;

  return (
    <section
      className="space-y-3 rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4"
      aria-label="AI drawing reader"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Two AI agents are reading the drawing</h3>
        <span className="rounded-full bg-slate-900 px-2.5 py-1 font-mono text-xs text-white tabular-nums">
          {job?.status === 'running' || !job ? `${secs}s` : job.status === 'done' ? 'Done' : 'Stopped'}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <AgentCard
          n={1}
          title="Extract & analyse"
          icon={ScanSearch}
          state={s1}
          does={[
            'Zoomed tiles',
            'Every callout listed',
            '3D shape analysis',
            'Dimensions & tolerances',
            'Feature list',
          ]}
          detail={
            s1 === 'working'
              ? 'Reading the drawing as an image: views, every dimension, the 3D shape.'
              : s1 === 'done'
                ? 'Feature table, 3D analysis and feature list drafted.'
                : 'Could not finish.'
          }
        />
        <AgentCard
          n={2}
          title="Verify & correct"
          icon={ShieldCheck}
          state={s2}
          does={[
            'Every value vs the drawing',
            'Own callout list',
            'Balloons 1..N',
            'Clamping order & lengths',
            'Nothing lost',
          ]}
          detail={
            s2 === 'working'
              ? `Checking every value against the drawing${job && job.round > 1 ? ` (second look, round ${job.round})` : ''}.`
              : s2 === 'done'
                ? `Checked ${info?.verify_rounds ?? 1} time${(info?.verify_rounds ?? 1) > 1 ? 's' : ''}; only accepted or corrected values are suggested.`
                : s2 === 'failed'
                  ? 'Could not finish.'
                  : 'Starts when agent 1 hands over its draft.'
          }
        />
      </div>
      {error && <p className="text-sm text-rose-800">{error}</p>}

      <AnimatePresence>
        {job?.status === 'done' && info && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease }}
            className="space-y-3"
          >
            {counts && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ['ok', 'Confirmed', 'text-emerald-700'],
                    ['wrong', 'Corrected', 'text-amber-700'],
                    ['unclear', 'For you to check', 'text-sky-700'],
                    ['unsupported', 'Removed', 'text-slate-600'],
                  ] as const
                ).map(([k, label, cls]) => (
                  <div key={k} className="rounded-xl border border-slate-200 bg-white p-3">
                    <CountUp
                      value={counts[k] ?? 0}
                      className={`text-2xl font-semibold tabular-nums ${cls}`}
                    />
                    <p className="text-xs text-slate-600">{label}</p>
                  </div>
                ))}
              </div>
            )}
            {info.callouts != null && (
              <div
                className={`rounded-xl border p-3 text-sm ${
                  info.unaccounted && info.unaccounted.length
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-emerald-300 bg-emerald-50'
                }`}
              >
                <p className="flex items-center gap-1.5 font-semibold">
                  {info.unaccounted && info.unaccounted.length ? (
                    <TriangleAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                  )}
                  Completeness: {info.callouts} callouts read
                  {info.balloons ? `, balloons 1–${info.balloons}` : ''}
                  {info.unaccounted && info.unaccounted.length
                    ? ` · ${info.unaccounted.length} to check on the drawing`
                    : ' · every one accounted for'}
                </p>
                {info.unaccounted && info.unaccounted.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-amber-900">
                    {info.unaccounted.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {shape && (
              <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                <p className="mb-1 flex items-center gap-1.5 font-semibold">
                  <Box className="h-4 w-4 text-sky-600" aria-hidden="true" /> 3D shape
                </p>
                <p className="text-slate-800">{shape.summary}</p>
                <p className="mt-1 text-xs text-slate-600">
                  Envelope: {shape.max_diameter != null ? `Ø${shape.max_diameter}` : 'Ø unknown'} ×{' '}
                  {shape.length != null ? `${shape.length} long` : 'length unknown'}
                </p>
                {shape.ends.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs text-slate-700">
                    {shape.ends.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
                {shape.non_turned.length > 0 && (
                  <p className="mt-1 text-xs text-amber-800">
                    Not turned on the lathe: {shape.non_turned.join('; ')}
                  </p>
                )}
              </div>
            )}
            {info.feature_list && info.feature_list.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                <p className="mb-1 flex items-center gap-1.5 font-semibold">
                  <ListChecks className="h-4 w-4 text-sky-600" aria-hidden="true" /> Features found (
                  {info.feature_list.length})
                </p>
                <ol className="grid list-decimal gap-x-6 gap-y-0.5 pl-5 text-slate-800 sm:grid-cols-2">
                  {info.feature_list.map((f, i) => (
                    <motion.li
                      key={`${i}-${f}`}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: Math.min(i * 0.03, 0.6), duration: 0.25 }}
                    >
                      {f}
                    </motion.li>
                  ))}
                </ol>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
