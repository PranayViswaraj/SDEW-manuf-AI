import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, renderApp } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('app shell and dashboard', () => {
  it('Ctrl+K opens quick search, filters and navigates', async () => {
    renderApp('/', makeUser(['operator']), { 'GET /materials': [] });
    await screen.findByText(/Welcome/);
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      expect(screen.getByRole('dialog', { name: 'Quick search' })).toBeInTheDocument();
    });
    const dialog = screen.getByRole('dialog', { name: 'Quick search' });
    const input = within(dialog).getByLabelText('Search pages and actions');
    fireEvent.change(input, { target: { value: 'material' } });
    expect(within(dialog).getByText('Materials')).toBeInTheDocument();
    expect(within(dialog).queryByText('Audit log')).not.toBeInTheDocument(); // operator: no admin pages
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Raw materials')).toBeInTheDocument();
  });

  it('quick search button in the top bar also opens it', async () => {
    renderApp('/', makeUser(['admin']));
    fireEvent.click(await screen.findByRole('button', { name: 'Open quick search' }));
    const dialog = await screen.findByRole('dialog', { name: 'Quick search' });
    expect(within(dialog).getByText('Audit log')).toBeInTheDocument();
  });

  it('dashboard shows task buttons for the role and the 11-step flow', async () => {
    renderApp('/', makeUser(['operator'], { can_start_machine: true }), {
      'GET /machines': [],
      'GET /programs': [],
      'GET /feature-tables': [],
      'GET /runs': [],
    });
    expect(await screen.findByText('Run a part')).toBeInTheDocument();
    expect(screen.queryByText('Users and Start list')).not.toBeInTheDocument();
    expect(screen.getByText('allowed to press Start')).toBeInTheDocument();
    expect(screen.getByText('AI reads drawing')).toBeInTheDocument();
    expect(screen.getByText('First piece result')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('No runs yet.')).toBeInTheDocument());
  });

  it('has a skip link and a collapsible sidebar', async () => {
    renderApp('/', makeUser(['engineer']));
    await screen.findByText(/Welcome/);
    expect(screen.getByText('Skip to content')).toHaveAttribute('href', '#main');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(localStorage.getItem('manufai.sidebar.collapsed')).toBe('1');
  });
});
