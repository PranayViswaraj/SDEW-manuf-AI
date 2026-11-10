import { MotionConfig } from 'framer-motion';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type TextSize = 'normal' | 'large' | 'larger';

export interface A11yPrefs {
  textSize: TextSize;
  highContrast: boolean;
  reduceMotion: boolean;
}

const KEY = 'manufai.a11y';
const DEFAULTS: A11yPrefs = { textSize: 'normal', highContrast: false, reduceMotion: false };

function load(): A11yPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<A11yPrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

interface A11yState {
  prefs: A11yPrefs;
  update: (p: Partial<A11yPrefs>) => void;
}

const A11yContext = createContext<A11yState | null>(null);

/** Applies the viewer's accessibility choices to <html> and to all animations. */
export function A11yProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<A11yPrefs>(load);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle('a11y-text-large', prefs.textSize === 'large');
    html.classList.toggle('a11y-text-larger', prefs.textSize === 'larger');
    html.classList.toggle('a11y-contrast', prefs.highContrast);
    html.classList.toggle('a11y-reduce-motion', prefs.reduceMotion);
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable: settings last for this page load */
    }
  }, [prefs]);

  const value = useMemo<A11yState>(
    () => ({ prefs, update: (p) => setPrefs((old) => ({ ...old, ...p })) }),
    [prefs],
  );

  return (
    <A11yContext.Provider value={value}>
      <MotionConfig reducedMotion={prefs.reduceMotion ? 'always' : 'user'}>{children}</MotionConfig>
    </A11yContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useA11y(): A11yState {
  const ctx = useContext(A11yContext);
  if (!ctx) throw new Error('useA11y must be used inside A11yProvider');
  return ctx;
}
