import { fireEvent, render, screen } from '@testing-library/react';
import BrowserAiKey from '../src/components/BrowserAiKey';

describe('own API key on the hosted site', () => {
  afterEach(() => localStorage.clear());

  it('keeps the key in this browser only and shows just its last 4 characters', () => {
    const changed = vi.fn();
    render(<BrowserAiKey onChange={changed} />);
    const input = screen.getByLabelText('Anthropic API key');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'not-a-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save in this browser' }));
    expect(screen.getByText(/does not look like an Anthropic API key/)).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();

    const key = `sk-ant-api03-${'x'.repeat(60)}WXYZ`;
    fireEvent.change(input, { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: 'Save in this browser' }));
    expect(localStorage.getItem('manufai.anthropicKey')).toBe(key);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/AI reader on in this browser \(key …WXYZ\)/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(key.slice(0, 20));

    fireEvent.click(screen.getByRole('button', { name: 'Forget key' }));
    expect(localStorage.getItem('manufai.anthropicKey')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
