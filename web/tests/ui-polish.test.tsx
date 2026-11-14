import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import GcodeView from '../src/components/GcodeView';
import { ToastProvider, useToast } from '../src/components/Toast';

const PROGRAM =
  '%\nO1000(SLEEVE)\nN1(32.0 UDRILL)\nT0101\nG74Z-31.0Q5000F0.05\nM30\n(2ND OPN - PART TURNED AROUND)\nM30\n%\n';

describe('G-code viewer', () => {
  it('keeps the program text exact, with line numbers', () => {
    render(<GcodeView text={PROGRAM} />);
    const pre = screen.getByLabelText('Generated program text');
    expect(pre.textContent).toContain('  5  G74Z-31.0Q5000F0.05');
    expect(pre.textContent?.split('\n')).toHaveLength(9);
  });

  it('colours words by meaning and summarises the program', () => {
    const { container } = render(<GcodeView text={PROGRAM} />);
    expect(container.querySelector('.gc-t')?.textContent).toBe('T0101');
    expect(container.querySelector('.gc-g')?.textContent).toBe('G74');
    expect(container.querySelector('.gc-comment')?.textContent).toBe('(SLEEVE)');
    expect(screen.getByText('2 clampings')).toBeInTheDocument();
    expect(screen.getByText('1 tools')).toBeInTheDocument();
  });
});

function Pusher() {
  const toast = useToast();
  return <button onClick={() => toast('Program accepted', { detail: 'Next: send it' })}>push</button>;
}

describe('toasts', () => {
  it('shows a toast, then it can be dismissed', async () => {
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    expect(screen.getByText('Program accepted')).toBeInTheDocument();
    expect(screen.getByText('Next: send it')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    await waitFor(() => expect(screen.queryByText('Program accepted')).not.toBeInTheDocument());
  });
});
