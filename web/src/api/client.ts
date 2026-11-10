export interface Health {
  status: 'ok' | 'degraded';
  version: string;
  database: 'ok' | 'error';
  time: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    throw new ApiError(res.status, `Request to ${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const getHealth = (): Promise<Health> => apiGet<Health>('/health');
