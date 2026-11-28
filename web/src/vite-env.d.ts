/// <reference types="vite/client" />

/** This build's id (the deployed commit), compared with version.json to update open tabs. */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** Server address when the pages are hosted elsewhere (GitHub Pages). Empty = same site. */
  readonly VITE_API_BASE?: string;
  /** '1' = run the Python server inside the browser (GitHub Pages, no server to host). */
  readonly VITE_BROWSER_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
