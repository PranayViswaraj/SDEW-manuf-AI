import { act, fireEvent, render, screen } from '@testing-library/react';
import GeneratingCode from '../src/components/GeneratingCode';

const TEXT = '%\nO1000(P-100)\nN1(FACE)\nG0X40Z2\nN2(ROUGH)\nG1Z-20F0.2\nM30\n%';

describe('program being written out', () => {
  it('writes the lines one by one, names the operation, then hands over', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    render(<GeneratingCode text={TEXT} onDone={done} />);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const box = screen.getByLabelText('Generated program text');
    expect(box.textContent).not.toContain('M30');
    expect(screen.getByRole('status')).toHaveTextContent('Writing program');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(box).toHaveTextContent('M30');
    expect(done).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('can be skipped with Show all', () => {
    const done = vi.fn();
    render(<GeneratingCode text={TEXT} onDone={done} />);
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
    expect(screen.getByLabelText('Generated program text')).toHaveTextContent('M30');
    expect(done).toHaveBeenCalled();
  });

  it('does not animate when motion is reduced', () => {
    const done = vi.fn();
    render(<GeneratingCode text={TEXT} onDone={done} animate={false} />);
    expect(done).toHaveBeenCalled();
  });
});
