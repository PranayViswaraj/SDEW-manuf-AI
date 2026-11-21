/** Run the precompute in a worker (main-thread fallback when workers are blocked or missing). */
import type { JobOptions } from './job';
import { precompute, type Precomputed } from './precompute';

export class Runner {
  private worker: Worker | null = null;
  private next = 1;
  private pending = new Map<number, { resolve: (p: Precomputed) => void; reject: (e: Error) => void }>();

  constructor() {
    if (typeof Worker === 'undefined' || import.meta.env.MODE === 'test') return;
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; result?: Precomputed; error?: string }>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.result) p.resolve(e.data.result);
        else p.reject(new Error(e.data.error ?? 'Simulation failed'));
      };
      this.worker.onerror = () => {
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  run(text: string, opts: JobOptions): Promise<Precomputed> {
    const local = () => precompute(text, opts);
    if (!this.worker)
      return new Promise((res, rej) =>
        setTimeout(() => {
          try {
            res(local());
          } catch (e) {
            rej(e instanceof Error ? e : new Error(String(e)));
          }
        }, 0),
      );
    const id = this.next++;
    const w = this.worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        try {
          resolve(local());
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }, 4000);
      this.pending.set(id, {
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      w.postMessage({ id, text, opts });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
