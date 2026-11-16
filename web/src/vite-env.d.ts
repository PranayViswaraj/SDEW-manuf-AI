/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Server address when the pages are hosted elsewhere (GitHub Pages). Empty = same site. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
