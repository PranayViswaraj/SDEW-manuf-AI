import { motion } from 'framer-motion';
import { Check, Copy, FileCode2 } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';

const WORD = /(\([^)]*\))|([A-Z])(-?\d*\.?\d+)?/g;

function cls(letter: string, first: boolean): string {
  if (letter === 'N' && first) return 'gc-n';
  if (letter === 'G') return 'gc-g';
  if (letter === 'M') return 'gc-m';
  if (letter === 'T') return 'gc-t';
  if (letter === 'O') return 'gc-block';
  if ('XZUWRIKAC'.includes(letter)) return 'gc-axis';
  if ('FSPQ'.includes(letter)) return 'gc-feed';
  return '';
}

/** One program line with each word coloured by what it does. Text is unchanged. */
function Line({ text }: { text: string }) {
  if (text.trim() === '%') return <span className="gc-block">{text}</span>;
  const out: ReactNode[] = [];
  let last = 0;
  let first = true;
  for (const m of text.matchAll(WORD)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const c = m[1] ? 'gc-comment' : cls(m[2], first);
    out.push(
      <span key={at} className={c}>
        {m[0]}
      </span>,
    );
    if (!m[1]) first = false;
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Read-only program text with line numbers, colours, a summary and a copy button. */
export default function GcodeView({
  text,
  label = 'Generated program text',
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => text.trimEnd().split('\n'), [text]);
  const stats = useMemo(() => {
    const tools = new Set(text.match(/T\d{4}/g) ?? []);
    const ops = /\(2ND OPN/.test(text) ? 2 : 1;
    return { tools: tools.size, ops };
  }, [text]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the text can still be selected */
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="overflow-hidden rounded-xl bg-slate-950 shadow-[var(--shadow-lift)] ring-1 ring-slate-900/10"
    >
      <div className="flex items-center gap-3 border-b border-white/10 bg-slate-900 px-3 py-2">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
        </span>
        <FileCode2 className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <span className="flex flex-wrap gap-1.5 text-[11px] font-medium text-slate-300">
          <span className="rounded bg-white/10 px-1.5 py-0.5">{lines.length} lines</span>
          <span className="rounded bg-white/10 px-1.5 py-0.5">{stats.tools} tools</span>
          <span className="rounded bg-white/10 px-1.5 py-0.5">
            {stats.ops === 2 ? '2 clampings' : '1 clamping'}
          </span>
          <span className="rounded bg-white/10 px-1.5 py-0.5">FANUC 0i-TF</span>
        </span>
        <button
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-200 transition hover:bg-white/10"
          onClick={() => void copy()}
          aria-label="Copy program text"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="max-h-[28rem] overflow-auto p-3 font-mono text-xs leading-5 text-slate-100"
        aria-label={label}
        tabIndex={0}
      >
        {lines.map((l, i) => (
          <Fragment key={i}>
            <span className="text-slate-600 select-none">{String(i + 1).padStart(3, ' ')}</span>
            {'  '}
            <Line text={l} />
            {i < lines.length - 1 ? '\n' : ''}
          </Fragment>
        ))}
      </pre>
    </motion.div>
  );
}
