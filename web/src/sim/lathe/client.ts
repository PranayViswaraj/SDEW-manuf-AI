/** Run the simulation in a web worker; falls back to the main thread where workers are missing. */
import { runSimulation } from './engine';
import type { SimInput, SimResult } from './types';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: SimResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined' || import.meta.env.MODE === 'test') return null;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: SimResult; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.result) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error ?? 'Simulation failed'));
    };
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error('Simulation worker stopped'));
      pending.clear();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

export function simulate(input: SimInput): Promise<SimResult> {
  const w = getWorker();
  if (!w) {
    return new Promise((resolve, reject) => {
      try {
        resolve(runSimulation(input));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // Safety net: if the worker does not answer (blocked or unsupported), run here instead.
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      try {
        resolve(runSimulation(input));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }, 3000);
    pending.set(id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    w.postMessage({ id, input });
  });
}
