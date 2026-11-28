// Browser-server mode (GitHub Pages): /api requests are answered by the Python server running
// in a Web Worker instead of the network. Each browser keeps its own data.

type Pending = { resolve: (r: Response) => void; reject: (e: unknown) => void };

// ---- AI reader with the user's own Anthropic key (hosted build). The key is kept in THIS
// browser's storage only and handed to the server worker; it is never sent anywhere but Anthropic.
const KEY_STORE = 'manufai.anthropicKey';
let serverWorker: Worker | null = null;

export const browserServerMode = import.meta.env.VITE_BROWSER_SERVER === '1';

export function getBrowserAiKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}

export function setBrowserAiKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    // storage blocked: the key still works until the page is closed
  }
  serverWorker?.postMessage({ type: 'ai-key', key });
}

const LOCK = 'manufai-server';

/**
 * Start the in-browser server, in ONE tab at a time. Each tab's server keeps its own copy of the
 * database and saves the whole copy to this browser's storage; two tabs would overwrite each
 * other's work (an AI read saved in one tab, lost when the other tab saved its older copy). A
 * browser lock decides which tab runs it; another tab shows a notice and runs nothing until the
 * user moves ManufAI to it (the first tab then stops at once, before it can save anything).
 */
export function installBrowserServer(): void {
  let worker: Worker | null = null;
  let stopped = false;
  let started: () => void = () => {};
  const ready = new Promise<void>((r) => (started = r));
  const pending = new Map<number, Pending>();
  let nextId = 1;
  const overlay = showOverlay();

  const start = () => {
    stopped = false;
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker = w;
    serverWorker = w;
    w.postMessage({ type: 'ai-key', key: getBrowserAiKey() });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'render-tiles') {
        void import('../lib/drawingTiles')
          .then(({ renderTiles }) => renderTiles(m.pdf))
          .then((r) => JSON.stringify(r))
          .catch(() => '{}')
          .then((result) => w.postMessage({ type: 'render-tiles-done', id: m.id, result }));
        return;
      }
      if (m.type === 'progress') overlay.text(m.text);
      else if (m.type === 'ready') overlay.remove();
      else if (m.type === 'failed') overlay.fail(m.text);
      else {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(new TypeError(`ManufAI server error: ${m.error}`));
        else
          p.resolve(
            new Response(nullBody(m.status) ? null : m.body, { status: m.status, headers: m.headers }),
          );
      }
    };
    w.postMessage({ type: 'boot', zipUrl: `${import.meta.env.BASE_URL}pyserver.zip` });
    started();
  };

  // Another tab took ManufAI over: stop this tab's server at once, so it can never save its
  // older copy of the data over the other tab's.
  const stop = () => {
    stopped = true;
    worker?.terminate();
    worker = null;
    serverWorker = null;
    for (const p of pending.values()) p.reject(new TypeError('ManufAI moved to another tab.'));
    pending.clear();
    overlay.elsewhere(
      'ManufAI is now open in another tab. This tab is paused so the two cannot overwrite each ' +
        'other’s work.',
      takeOver,
    );
  };

  // Hold the lock for as long as this page is open; `steal` takes it from the other tab.
  const hold = (steal: boolean) =>
    navigator.locks
      .request(LOCK, steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        overlay.text('Starting…');
        start();
        await new Promise<never>(() => {}); // released only when the page closes or is taken over
        return true;
      })
      .then((ok) => {
        if (ok === false) {
          // this tab runs nothing: requests fail at once instead of waiting
          stopped = true;
          started();
          overlay.elsewhere(
            'ManufAI is already open in another tab of this browser. Use that tab, or move ' +
              'ManufAI here (the other tab is paused; an AI read running there stops).',
            takeOver,
          );
        }
      })
      .catch(() => {
        if (worker) stop(); // the lock was taken over by another tab
      });

  function takeOver() {
    overlay.text('Starting…');
    void hold(true);
  }

  if ('locks' in navigator) void hold(false);
  else start(); // very old browser: no locks, run as before

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
      return realFetch(input, init);
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? new ArrayBuffer(0) : await req.arrayBuffer();
    const headers: [string, string][] = [];
    req.headers.forEach((v, k) => headers.push([k, v]));
    await ready;
    const w = worker;
    if (stopped || !w) throw new TypeError('ManufAI is open in another tab.');
    const id = nextId++;
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      req.signal.addEventListener('abort', () => {
        pending.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      });
      w.postMessage(
        { id, method: req.method, path: url.pathname, query: url.search.slice(1), headers, body },
        [body],
      );
    });
  };
}

function nullBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function showOverlay() {
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.style.cssText =
    'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
    'background:#f8fafc;color:#0f172a;font:16px/1.5 system-ui,sans-serif;padding:16px;' +
    'text-align:center';
  el.innerHTML =
    '<div style="max-width:440px"><div style="font-size:24px;font-weight:600;color:#24477f">' +
    'ManufAI</div><p data-t style="margin:12px 0 8px">Starting…</p>' +
    '<p style="margin:0;color:#64748b;font-size:14px">The ManufAI server runs inside your ' +
    'browser. The first start downloads about 15 MB and can take a minute; later starts are ' +
    'faster.</p></div>';
  document.body.appendChild(el);
  const t = el.querySelector('[data-t]') as HTMLElement;
  return {
    text: (s: string) => {
      t.textContent = s;
    },
    remove: () => el.remove(),
    elsewhere: (message: string, onTakeOver: () => void) => {
      if (!el.isConnected) document.body.appendChild(el);
      t.textContent = message;
      t.style.color = '#0f172a';
      const old = el.querySelector('[data-take]');
      old?.remove();
      const b = document.createElement('button');
      b.dataset.take = '1';
      b.textContent = 'Use ManufAI in this tab';
      b.style.cssText =
        'margin-top:12px;padding:8px 16px;border-radius:10px;border:0;background:#24477f;' +
        'color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer';
      b.onclick = () => {
        b.remove();
        onTakeOver();
      };
      t.after(b);
    },
    fail: (s: string) => {
      t.textContent = `Could not start: ${s}. Reload the page to try again.`;
      t.style.color = '#b91c1c';
    },
  };
}
