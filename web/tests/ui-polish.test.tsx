import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import GcodeView from '../src/components/GcodeView';
import { ToastProvider, useToast } from '../src/components/Toast';
import { renderApp } from './helpers';

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

describe('login in production', () => {
  it('hides the shared role tiles and asks for a personal user name', async () => {
    renderApp('/login', null, {
      'GET /health': { status: 'ok', version: '1', database: 'ok', time: '', mode: 'production' },
    });
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.queryByText('Sign in as')).not.toBeInTheDocument();
  });

  it('keeps the role tiles on a dev or test install', async () => {
    renderApp('/login', null);
    expect(await screen.findByText('Sign in as')).toBeInTheDocument();
  });
});

function EditableView({ original }: { original: string }) {
  const [text, setText] = useState(original);
  const [editing, setEditing] = useState(false);
  return (
    <GcodeView
      text={text}
      original={original}
      editing={editing}
      onEditingChange={setEditing}
      onChange={setText}
    />
  );
}

describe('editing the program on screen', () => {
  it('edits in capitals, counts changed lines and resets to the generated text', () => {
    render(<EditableView original={PROGRAM} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    const area = screen.getByLabelText('Edit program text') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: PROGRAM.replace('G74Z-31.0', 'g74z-30.0') } });
    expect(area.value).toContain('G74Z-30.0');
    expect(screen.getByText('Edited · 1 line changed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reset to generated/ }));
    expect((screen.getByLabelText('Edit program text') as HTMLTextAreaElement).value).toBe(PROGRAM);
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(screen.getByLabelText('Generated program text')).toBeInTheDocument();
  });

  it('is read-only without an edit handler (operators)', () => {
    render(<GcodeView text={PROGRAM} />);
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });
});
