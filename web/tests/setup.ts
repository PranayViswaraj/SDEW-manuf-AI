import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { MotionGlobalConfig } from 'framer-motion';

// The full suite runs files in parallel; give async queries more than the 1 s default.
configure({ asyncUtilTimeout: 3000 });

// Animations off in tests (instant), and jsdom has no matchMedia.
MotionGlobalConfig.skipAnimations = true;
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
