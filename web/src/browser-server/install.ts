// Browser-server mode (GitHub Pages): /api requests are answered by the Python server running
// in a Web Worker instead of the network. Each browser keeps its own data.

type Pending = { resolve: (r: Response) => void; reject: (e: unknown) => void };

export function installBrowserServer(): void {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  const overlay = showOverlay();

  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
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
  worker.postMessage({ type: 'boot', zipUrl: `${import.meta.env.BASE_URL}pyserver.zip` });

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
      return realFetch(input, init);
    }
    const body =
      req.method === 'GET' || req.method === 'HEAD' ? new ArrayBuffer(0) : await req.arrayBuffer();
    const headers: [string, string][] = [];
    req.headers.forEach((v, k) => headers.push([k, v]));
    const id = nextId++;
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      req.signal.addEventListener('abort', () => {
        pending.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      });
      worker.postMessage(
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
    fail: (s: string) => {
      t.textContent = `Could not start: ${s}. Reload the page to try again.`;
      t.style.color = '#b91c1c';
    },
  };
}
