import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => vi.unstubAllGlobals());

describe('App shell', () => {
  it('shows server OK when health is ok', async () => {
    mockFetch({
      ok: true,
      json: async () => ({ status: 'ok', version: '0.1.0', database: 'ok', time: '' }),
    });
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Server OK/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/health', undefined);
  });

  it('shows a plain error when the server is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Server unreachable/)).toBeInTheDocument();
  });

  it('shows an error when the database is degraded', async () => {
    mockFetch({
      ok: true,
      json: async () => ({ status: 'degraded', version: '0.1.0', database: 'error', time: '' }),
    });
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/database down/)).toBeInTheDocument();
  });
});
