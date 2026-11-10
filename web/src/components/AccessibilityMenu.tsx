import { AnimatePresence, motion } from 'framer-motion';
import { Accessibility } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useA11y, type TextSize } from '../a11y/A11yContext';

const SIZES: { value: TextSize; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'larger', label: 'Larger' },
];

function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm font-medium text-slate-900">{label}</span>
        <span className="block text-xs text-slate-600">{hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition peer-focus-visible:ring-4 peer-focus-visible:ring-brand-200 ${
          checked ? 'bg-brand-600' : 'bg-slate-300'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </span>
    </label>
  );
}

export default function AccessibilityMenu() {
  const { prefs, update } = useA11y();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className="btn px-2.5"
        aria-label="Accessibility settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Accessibility settings"
        onClick={() => setOpen((o) => !o)}
      >
        <Accessibility className="h-4 w-4" aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Accessibility settings"
            className="absolute right-0 z-40 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-4 shadow-lg"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            <h2 className="text-sm font-semibold text-slate-900">Accessibility</h2>
            <p className="text-xs text-slate-600">Saved on this computer.</p>

            <fieldset className="mt-3">
              <legend className="text-sm font-medium text-slate-900">Text size</legend>
              <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
                {SIZES.map((s) => (
                  <label
                    key={s.value}
                    className={`cursor-pointer rounded-md px-2 py-1.5 text-center text-sm font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500 ${
                      prefs.textSize === s.value
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <input
                      type="radio"
                      name="text-size"
                      className="sr-only"
                      value={s.value}
                      checked={prefs.textSize === s.value}
                      onChange={() => update({ textSize: s.value })}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-3 divide-y divide-slate-100">
              <Switch
                label="High contrast"
                hint="Darker text and borders, underlined links"
                checked={prefs.highContrast}
                onChange={(v) => update({ highContrast: v })}
              />
              <Switch
                label="Reduce motion"
                hint="Turn off animations"
                checked={prefs.reduceMotion}
                onChange={(v) => update({ reduceMotion: v })}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
