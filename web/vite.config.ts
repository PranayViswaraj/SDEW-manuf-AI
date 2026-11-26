/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { Agent } from 'node:http';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, '..', ''), ...process.env };
  return {
    // '/' normally; '/SDEW-manuf-AI/' for GitHub Pages (set by .github/workflows/pages.yml).
    base: env.VITE_BASE_PATH ?? '/',
    plugins: [react(), tailwindcss()],
    server: {
      host: true,
      port: Number(env.WEB_PORT ?? 5173),
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000',
          changeOrigin: true,
          ws: true,
          // A fresh connection per request: on Windows the dev proxy sometimes lost the end of
          // large replies (drawings) when it reused a kept-alive connection.
          agent: new Agent({ keepAlive: false }),
        },
      },
    },
    test: {
      environment: 'jsdom',
      // page tests click through several steps; give them room when the PC is busy
      testTimeout: 30000,
      globals: true,
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.{ts,tsx}'],
    },
  };
});
