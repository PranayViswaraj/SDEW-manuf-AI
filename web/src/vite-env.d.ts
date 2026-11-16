/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Server address when the pages are hosted elsewhere (GitHub Pages). Empty = same site. */
  readonly VITE_API_BASE?: string;
  /** '1' = run the Python server inside the browser (GitHub Pages, no server to host). */
  readonly VITE_BROWSER_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
