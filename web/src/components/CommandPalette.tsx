import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';

export interface Command {
  id: string;
  label: string;
  hint: string;
  to: string;
  icon: LucideIcon;
  group: string;
}

export default function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => {
      const text = `${c.label} ${c.hint} ${c.group}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [q, commands]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);
  useEffect(() => setActive(0), [q]);

  function go(c: Command | undefined) {
    if (!c) return;
    onClose();
    navigate(c.to);
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 px-4 pt-[12vh] backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Quick search"
            className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -6 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              }
              if (e.key === 'Enter') go(results[active]);
            }}
          >
            <div className="flex items-center gap-3 border-b border-slate-100 px-4">
              <Search className="h-5 w-5 text-slate-400" aria-hidden="true" />
              <input
                ref={inputRef}
                className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-slate-400"
                placeholder="Where do you want to go? Try “run”, “approve”, “materials”…"
                aria-label="Search pages and actions"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <span className="kbd">Esc</span>
            </div>
            <ul className="max-h-[50vh] overflow-y-auto p-2" role="listbox" aria-label="Results">
              {results.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-slate-500">Nothing found.</li>
              )}
              {results.map((c, i) => {
                const Icon = c.icon;
                const on = i === active;
                return (
                  <li key={c.id} role="option" aria-selected={on}>
                    <button
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                        on ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-50'
                      }`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(c)}
                    >
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-lg ${on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}
                      >
                        <Icon className="h-4.5 w-4.5" aria-hidden="true" />
                      </span>
                      <span className="flex-1">
                        <span className="block text-sm font-medium">{c.label}</span>
                        <span className="block text-xs text-slate-500">{c.hint}</span>
                      </span>
                      <span className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
                        {c.group}
                      </span>
                      {on && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center gap-3 border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500">
              <span>
                <span className="kbd">↑</span> <span className="kbd">↓</span> move
              </span>
              <span>
                <span className="kbd">Enter</span> open
              </span>
              <span className="ml-auto">
                <span className="kbd">Ctrl</span> <span className="kbd">K</span> anywhere
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
