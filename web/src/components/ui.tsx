import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <motion.p
      role="alert"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800"
    >
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{error}</span>
    </motion.p>
  );
}

const TONES: Record<'info' | 'warn' | 'ok', { cls: string; icon: LucideIcon }> = {
  warn: { cls: 'border-amber-200 bg-amber-50 text-amber-900', icon: AlertTriangle },
  ok: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: CheckCircle2 },
  info: { cls: 'border-brand-200 bg-brand-50 text-brand-900', icon: Info },
};

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok' }) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${t.cls}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </motion.div>
  );
}

export function NotEntered({ what = 'Not entered' }: { what?: string }) {
  return <span className="text-sm text-amber-700 italic">{what}</span>;
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

/** Animated placeholder shown while a page loads. */
export function PageLoading() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}
