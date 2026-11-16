// Thin fetch wrapper: adds the login token, turns error responses into plain messages.

const TOKEN_KEY = 'manufai.token';

/** Where the server lives. Empty = same site (served by the server, or the dev proxy).
 *  Set VITE_API_BASE (e.g. https://manufai-server.onrender.com) when the pages are hosted
 *  separately, such as on GitHub Pages. */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

/** Full address of a server path, e.g. apiUrl('/programs/1/file'). */
export function apiUrl(path: string): string {
  return `${API_BASE}/api${path}`;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: token lives for this page load only */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

function detailToMessage(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    // FastAPI validation errors
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) => {
        const field = (d.loc ?? []).filter((x) => x !== 'body').join('.');
        return field ? `${field}: ${d.msg}` : (d.msg ?? '');
      })
      .join('; ');
  }
  return `Request failed (${status})`;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'Cannot reach the ManufAI server. Check the network connection.');
  }
  if (res.status === 401 && path !== '/auth/login') {
    unauthorizedListeners.forEach((fn) => fn());
  }
  if (!res.ok) {
    let detail: unknown = undefined;
    try {
      detail = ((await res.json()) as { detail?: unknown }).detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detailToMessage(detail, res.status));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export interface Health {
  status: 'ok' | 'degraded';
  version: string;
  database: 'ok' | 'error';
  time: string;
  mode?: 'dev' | 'test' | 'production';
}

export const getHealth = (): Promise<Health> => api.get<Health>('/health');
