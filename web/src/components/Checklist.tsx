import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import type { RunDetail } from '../api/types';

export default function Checklist({
  items,
  disabled,
  onToggle,
}: {
  items: RunDetail['checklist'];
  disabled: boolean;
  onToggle: (key: string, ticked: boolean) => void;
}) {
  const done = items.filter((i) => i.ticked).length;
  const pct = items.length ? (done / items.length) * 100 : 0;
  const all = done === items.length;
  return (
    <section className="space-y-3 card h-full p-4" aria-label="Safety checklist">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Safety checklist</h2>
        <span className={`text-sm font-medium ${all ? 'text-emerald-700' : 'text-slate-600'}`}>
          {done} / {items.length} ticked
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        <motion.div
          className={`h-full rounded-full ${all ? 'bg-emerald-500' : 'bg-brand-500'}`}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 160, damping: 22 }}
        />
      </div>
      <p className="text-xs text-slate-500">
        Tick each item at the machine. The list starts empty for every run.
      </p>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {items.map((i) => (
          <li key={i.key}>
            <label
              className={`relative flex cursor-pointer items-center min-h-16 gap-3 rounded-xl border-2 px-4 py-3 text-base transition ${
                i.ticked
                  ? 'border-emerald-200 bg-emerald-50/70 text-slate-900'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50/40'
              } ${disabled ? 'cursor-not-allowed opacity-70' : ''}`}
            >
              <input
                type="checkbox"
                className="peer sr-only"
                checked={i.ticked}
                disabled={disabled}
                onChange={(e) => onToggle(i.key, e.target.checked)}
              />
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-2 transition peer-focus-visible:ring-4 peer-focus-visible:ring-brand-200 ${
                  i.ticked ? 'border-emerald-500 bg-emerald-500' : 'border-slate-300 bg-white'
                }`}
                aria-hidden="true"
              >
                {i.ticked && (
                  <motion.span initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }}>
                    <Check className="h-5 w-5 text-white" strokeWidth={3} />
                  </motion.span>
                )}
              </span>
              <span className="flex-1 font-medium">{i.label}</span>
              {i.ticked && i.by && (
                <span className="text-xs text-slate-400">
                  {i.by} {i.at?.slice(11, 19)}
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
