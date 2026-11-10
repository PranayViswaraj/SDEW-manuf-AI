import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, makeUser, renderApp } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('login', () => {
  it('redirects to the login page when logged out', async () => {
    renderApp('/', null);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('logs in and shows the home page', async () => {
    const user = makeUser(['operator']);
    renderApp('/login', null, {
      'POST /auth/login': { access_token: 't', token_type: 'bearer', user },
    });
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'operator' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Welcome/)).toBeInTheDocument();
    expect(localStorage.getItem('manufai.token')).toBe('t');
  });

  it('shows a plain error on wrong password', async () => {
    renderApp('/login', null, {
      'POST /auth/login': () => {
        throw new HttpError(401, 'Wrong username or password.');
      },
    });
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password.');
  });
});

describe('shell', () => {
  it('shows server status and the emergency stop reminder', async () => {
    renderApp('/', makeUser(['operator']));
    expect(await screen.findByText(/Server OK/)).toBeInTheDocument();
    expect(screen.getByText(/never replaces the machine's physical emergency stop/)).toBeInTheDocument();
  });

  it('hides admin pages from an operator', async () => {
    renderApp('/', makeUser(['operator']));
    const nav = await screen.findByRole('navigation');
    expect(within(nav).queryByText('Audit log')).not.toBeInTheDocument();
    expect(within(nav).queryByText('Users')).not.toBeInTheDocument();
  });

  it('refuses an admin page for a non-admin', async () => {
    renderApp('/logs', makeUser(['engineer']));
    expect(await screen.findByText(/You need the admin role/)).toBeInTheDocument();
  });

  it('never shows anything labelled as an emergency stop button', async () => {
    renderApp('/', makeUser(['admin', 'operator']), {
      'GET /users': [],
      'GET /audit-log': { total: 0, items: [] },
    });
    await screen.findByText(/Welcome/);
    for (const b of screen.queryAllByRole('button')) {
      expect(b.textContent ?? '').not.toMatch(/e-?stop|emergency/i);
    }
  });
});

describe('admin pages', () => {
  it('lists audit entries', async () => {
    renderApp('/logs', makeUser(['admin']), {
      'GET /audit-log': {
        total: 1,
        items: [
          {
            id: 1,
            timestamp: '2026-11-10T10:00:00Z',
            user_id: 1,
            username: 'admin',
            machine_id: null,
            program_id: null,
            program_hash: null,
            action: 'login',
            payload: {},
            result: 'ok',
            error: null,
          },
        ],
      },
    });
    expect(await screen.findByText('login')).toBeInTheDocument();
    expect(screen.getByText('1 entries')).toBeInTheDocument();
  });

  it('toggles the allowed-to-start flag', async () => {
    const op = makeUser(['operator'], { id: 7, username: 'op1' });
    const { calls } = renderApp('/users', makeUser(['admin']), {
      'GET /users': [op],
      'PATCH /users/7': { ...op, can_start_machine: true },
    });
    fireEvent.click(await screen.findByLabelText('op1 can start'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/users/7')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ can_start_machine: true });
  });
});
