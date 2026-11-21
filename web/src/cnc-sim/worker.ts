/// <reference lib="webworker" />
/** <cnc-simulator> worker: parse, expand and pre-cut the whole program once. */
import { precompute, transferables } from './precompute';
import type { JobOptions } from './job';

self.onmessage = (e: MessageEvent<{ id: number; text: string; opts: JobOptions }>) => {
  const { id, text, opts } = e.data;
  try {
    const p = precompute(text, opts);
    (self as unknown as Worker).postMessage({ id, result: p }, transferables(p));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
