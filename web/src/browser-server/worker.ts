/// <reference lib="webworker" />
// Runs the ManufAI Python server (server/app) in this worker with Pyodide. Used when the web app
// is hosted without a server (GitHub Pages). Data is kept in this browser's IndexedDB.

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
const PACKAGES = ['micropip', 'sqlite3', 'sqlalchemy', 'pydantic'];
// Versions that work with the packages bundled in Pyodide 0.27.
const WHEELS = [
  'fastapi==0.115.6',
  'starlette==0.41.3',
  'pydantic-settings==2.6.1',
  'pyjwt',
  'python-multipart==0.0.20',
  'alembic==1.13.3',
  'argon2-cffi',
  'openpyxl',
];

type Req = {
  id: number;
  method: string;
  path: string;
  query: string;
  headers: [string, string][];
  body: ArrayBuffer;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
let py: any;
let handle: any;

function progress(text: string) {
  postMessage({ type: 'progress', text });
}

async function persist() {
  await new Promise<void>((resolve) => py.FS.syncfs(false, () => resolve()));
}

async function boot(zipUrl: string) {
  progress('Loading Python…');
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE}pyodide.mjs`);
  py = await loadPyodide({ indexURL: PYODIDE });
  progress('Loading server libraries…');
  await py.loadPackage(PACKAGES);
  await py.pyimport('micropip').install(WHEELS);
  progress('Loading ManufAI…');
  py.FS.mkdirTree('/srv');
  py.FS.mkdirTree('/data');
  py.FS.mount(py.FS.filesystems.IDBFS, {}, '/data');
  await new Promise<void>((resolve) => py.FS.syncfs(true, () => resolve()));
  const zip = await fetch(zipUrl, { cache: 'no-cache' });
  py.unpackArchive(await zip.arrayBuffer(), 'zip', { extractDir: '/srv' });
  py.runPython("import sys; sys.path.insert(0, '/srv')");
  progress('Preparing the database…');
  await py.runPythonAsync('import browser_boot');
  handle = py.pyimport('browser_boot').handle;
  await persist();
}

let ready: Promise<void> | null = null;
let chain: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'boot') {
    ready = boot(msg.zipUrl);
    ready.then(
      () => postMessage({ type: 'ready' }),
      (err) => postMessage({ type: 'failed', text: String(err?.message ?? err) }),
    );
    return;
  }
  const req = msg as Req;
  // One request at a time: the SQLite file is shared and Pyodide has one thread.
  chain = chain.then(async () => {
    try {
      await ready;
      const res = await handle(
        req.method,
        req.path,
        req.query,
        py.toPy(req.headers),
        py.toPy(new Uint8Array(req.body)),
      );
      const status: number = res.get(0);
      const headersPy = res.get(1);
      const headers: [string, string][] = headersPy.toJs();
      headersPy.destroy();
      const bodyPy = res.get(2);
      const bytes: Uint8Array = bodyPy.toJs();
      bodyPy.destroy();
      res.destroy();
      const copy = bytes.slice().buffer;
      if (req.method !== 'GET' && req.method !== 'HEAD') await persist();
      postMessage({ id: req.id, status, headers, body: copy }, [copy]);
    } catch (err: any) {
      postMessage({ id: req.id, error: String(err?.message ?? err) });
    }
  });
};
