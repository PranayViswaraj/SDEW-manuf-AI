import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { A11yProvider } from '../src/a11y/A11yContext';
import LatheSimDemo from '../src/pages/LatheSimDemo';

function renderDemo() {
  return render(
    <A11yProvider>
      <LatheSimDemo />
    </A11yProvider>,
  );
}

describe('3D lathe simulation (SIM Lathe demo)', () => {
  it('plays the demo program clean and allows approval', async () => {
    renderDemo();
    expect(await screen.findByTestId('sim-verdict')).toHaveTextContent('No simulation errors or warnings');
    expect(screen.getByTestId('demo-approve')).toBeEnabled();
    // Operations with times, the G-code pane, the disclaimer.
    for (const op of ['Face', 'Rough', 'Finish', 'Drill', 'Bore', 'Groove', 'Thread', 'Part-off'])
      expect(screen.getAllByText(op).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Program')).toHaveTextContent('G71P10Q20U0.4W0.1F0.25');
    expect(screen.getByTestId('sim-disclaimer')).toHaveTextContent('Advisory only');
    expect(screen.getByRole('button', { name: 'Play simulation' })).toBeInTheDocument();
  });

  it('shows the bad program errors on the scrub bar and keeps approval blocked', async () => {
    renderDemo();
    await screen.findByTestId('sim-verdict');
    fireEvent.click(screen.getByRole('radio', { name: /deliberately bad/ }));
    await waitFor(() => expect(screen.getByTestId('sim-verdict')).toHaveTextContent('approval blocked'));
    expect(screen.getAllByTestId('marker-error').length).toBeGreaterThan(5);
    expect(screen.getByTestId('demo-approve')).toBeDisabled();
    expect(screen.getByTestId('sim-checks')).toHaveTextContent('Rapid move of T01 into material');
    // Clicking a marker jumps to its line.
    fireEvent.click(screen.getAllByTestId('marker-error')[0]);
    expect(document.querySelector('[aria-current="true"][data-line]')).not.toBeNull();
  });
});
