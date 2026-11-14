import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UsbDownload from '../src/components/UsbDownload';

afterEach(() => vi.restoreAllMocks());

describe('USB download', () => {
  it('shows the server refusal (never downloads an unapproved program)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Cannot download for the machine: O1000 v1 is not approved.' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(<UsbDownload programId={7} programName="O1000" />);
    fireEvent.click(screen.getByRole('button', { name: /Download O1000.NC/ }));
    await waitFor(() => expect(screen.getByText(/is not approved/)).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith('/api/programs/7/file', expect.anything());
  });

  it('saves the approved file as O1000.NC', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('%\r\nO1000\r\nM30\r\n%', { status: 200 }));
    const url = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: url, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<UsbDownload programId={7} programName="O1000" />);
    fireEvent.click(screen.getByRole('button', { name: /Download O1000.NC/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(url).toHaveBeenCalled();
  });
});
