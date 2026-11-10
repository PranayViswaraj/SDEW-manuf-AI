import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, renderApp } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.className = '';
});

describe('accessibility settings', () => {
  it('changes text size, contrast and motion, and remembers them', async () => {
    renderApp('/', makeUser(['operator']));
    fireEvent.click(await screen.findByRole('button', { name: 'Accessibility settings' }));
    const panel = screen.getByRole('dialog', { name: 'Accessibility settings' });

    fireEvent.click(within(panel).getByLabelText('Larger'));
    expect(document.documentElement).toHaveClass('a11y-text-larger');

    fireEvent.click(within(panel).getByRole('switch', { name: /High contrast/ }));
    expect(document.documentElement).toHaveClass('a11y-contrast');

    fireEvent.click(within(panel).getByRole('switch', { name: /Reduce motion/ }));
    expect(document.documentElement).toHaveClass('a11y-reduce-motion');

    expect(JSON.parse(localStorage.getItem('manufai.a11y') ?? '{}')).toEqual({
      textSize: 'larger',
      highContrast: true,
      reduceMotion: true,
    });
  });

  it('restores saved settings on the next visit', async () => {
    localStorage.setItem('manufai.a11y', JSON.stringify({ textSize: 'large', highContrast: true }));
    renderApp('/', makeUser(['operator']));
    await screen.findByText(/Welcome/);
    expect(document.documentElement).toHaveClass('a11y-text-large', 'a11y-contrast');
    expect(document.documentElement).not.toHaveClass('a11y-reduce-motion');
  });

  it('Esc closes the settings panel', async () => {
    renderApp('/', makeUser(['operator']));
    fireEvent.click(await screen.findByRole('button', { name: 'Accessibility settings' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Accessibility settings' })).not.toBeInTheDocument(),
    );
  });

  it('sets the browser tab title to the open page', async () => {
    renderApp('/materials', makeUser(['operator']), { 'GET /materials': [] });
    await screen.findByText('Raw materials');
    await waitFor(() => expect(document.title).toBe('Materials – ManufAI'));
  });
});
