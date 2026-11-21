/// <reference lib="webworker" />
/** Runs the lathe simulation off the main thread so playback stays smooth. */
import { runSimulation } from './engine';
import type { SimInput } from './types';

self.onmessage = (e: MessageEvent<{ id: number; input: SimInput }>) => {
  const { id, input } = e.data;
  try {
    const result = runSimulation(input);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
