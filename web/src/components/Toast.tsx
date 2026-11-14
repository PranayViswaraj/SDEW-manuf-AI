import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Tone = 'ok' | 'info' | 'warn';
interface Toast {
  id: number;
  title: string;
  detail?: string;
  tone: Tone;
}
type Push = (title: string, opts?: { detail?: string; tone?: Tone }) => void;

const ToastContext = createContext<Push>(() => {});

/** Show a short confirmation in the corner, e.g. toast('Program accepted'). */
export function useToast(): Push {
  return useContext(ToastContext);
}

const STYLE: Record<Tone, { icon: LucideIcon; ring: string; iconCls: string; bar: string }> = {
  ok: { icon: CheckCircle2, ring: 'ring-emerald-600/20', iconCls: 'text-emerald-600', bar: 'bg-emerald-500' },
  info: { icon: Info, ring: 'ring-brand-600/20', iconCls: 'text-brand-600', bar: 'bg-brand-500' },
  warn: { icon: AlertTriangle, ring: 'ring-amber-600/25', iconCls: 'text-amber-600', bar: 'bg-amber-500' },
};
const LIFE_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const close = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback<Push>(
    (title, opts) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-3), { id, title, detail: opts?.detail, tone: opts?.tone ?? 'ok' }]);
      window.setTimeout(() => close(id), LIFE_MS);
    },
    [close],
  );
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const s = STYLE[t.tone];
            const Icon = s.icon;
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 40, scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                className={`pointer-events-auto relative overflow-hidden rounded-xl bg-white/95 p-3.5 pr-10 shadow-[var(--shadow-lift)] ring-1 backdrop-blur ${s.ring}`}
              >
                <div className="flex items-start gap-2.5">
                  <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${s.iconCls}`} aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">{t.title}</p>
                    {t.detail && <p className="mt-0.5 text-xs text-slate-600">{t.detail}</p>}
                  </div>
                </div>
                <button
                  className="absolute top-2.5 right-2.5 rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                  onClick={() => close(t.id)}
                  aria-label="Dismiss"
                >
                  <X className="h-4 w-4" />
                </button>
                <motion.span
                  className={`absolute bottom-0 left-0 h-0.5 ${s.bar}`}
                  initial={{ width: '100%' }}
                  animate={{ width: '0%' }}
                  transition={{ duration: LIFE_MS / 1000, ease: 'linear' }}
                  aria-hidden="true"
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
