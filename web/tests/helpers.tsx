import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import App from '../src/App';
import type { Role, User } from '../src/api/types';
import { AuthProvider } from '../src/auth/AuthContext';

export type Handler = (body: unknown, url: URL) => unknown;
/** Map of "METHOD /path" (path without /api, query ignored) -> response body or handler. */
export type Routes = Record<string, unknown>;

export class HttpError {
  constructor(
    public status: number,
    public detail: string,
  ) {}
}

export function mockServer(routes: Routes) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api/, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return { ok: false, status: 404, json: async () => ({ detail: `no mock for ${key}` }) } as Response;
    }
    let value = routes[key];
    try {
      if (typeof value === 'function') value = await (value as Handler)(body, url);
    } catch (e) {
      value = e;
    }
    if (value instanceof HttpError) {
      return { ok: false, status: value.status, json: async () => ({ detail: value.detail }) } as Response;
    }
    return { ok: true, status: 200, json: async () => value } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function makeUser(roles: Role[], extra: Partial<User> = {}): User {
  return {
    id: 1,
    username: roles[0] ?? 'nobody',
    full_name: 'Test',
    is_active: true,
    can_start_machine: false,
    roles,
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

export const HEALTH = { 'GET /health': { status: 'ok', version: '0.1.0', database: 'ok', time: '' } };

/** Render the whole app at `path`, logged in as `user` (or logged out if null). */
export function renderApp(path: string, user: User | null, routes: Routes = {}) {
  try {
    if (user) localStorage.setItem('manufai.token', 'test-token');
    else localStorage.removeItem('manufai.token');
  } catch {
    /* ignore */
  }
  const server = mockServer({ ...HEALTH, ...(user ? { 'GET /auth/me': user } : {}), ...routes });
  const utils = render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { ...utils, ...server };
}
