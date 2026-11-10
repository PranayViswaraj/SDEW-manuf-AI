import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, renderApp } from './helpers';
import { DETAIL } from './programs.test';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const PATH = {
  segments: [
    {
      block: 2,
      line: 4,
      tool: 1,
      kind: 'rapid',
      cycle: false,
      op: 1,
      label: 'TNMG 0.4 FIN',
      points: [
        [10, 25],
        [2, 20],
      ],
    },
    {
      block: 3,
      line: 5,
      tool: 1,
      kind: 'feed',
      cycle: false,
      op: 1,
      label: 'TNMG 0.4 FIN',
      points: [
        [2, 20],
        [-20, 20],
      ],
    },
    {
      block: 4,
      line: 6,
      tool: 2,
      kind: 'feed',
      cycle: false,
      op: 1,
      label: '3MM PARTING',
      points: [
        [-21, 26],
        [-21, 10],
      ],
    },
    {
      block: 9,
      line: 20,
      tool: 3,
      kind: 'feed',
      cycle: false,
      op: 2,
      label: 'BORE FIN',
      points: [
        [2, 8],
        [-10, 8],
      ],
    },
  ],
  blocks: [
    { index: 2, line: 4, text: 'G0X50.0Z10.0' },
    { index: 3, line: 5, text: 'G1Z-20.0F0.2' },
    { index: 4, line: 6, text: 'G1X20.0F0.05' },
    { index: 9, line: 20, text: 'G1Z-10.0' },
  ],
  warnings: [],
  tools: [1, 2, 3],
  bounds: { z_min: -21, z_max: 10, r_min: 8, r_max: 26 },
  stock: null,
};

describe('machining simulation', () => {
  it('shows the bar, steps block by block and offers operations', async () => {
    renderApp('/programs/1', makeUser(['operator']), {
      'GET /programs/1': DETAIL,
      'GET /programs/1/toolpath': PATH,
    });
    const section = await screen.findByRole('region', { name: 'Machining simulation' });
    const sim = within(section);
    expect(sim.getByRole('img', { name: /bar being cut/ })).toBeInTheDocument();
    expect(sim.getByTestId('sim-block')).toHaveTextContent('1 / 3');
    fireEvent.click(sim.getByRole('button', { name: 'Next block' }));
    expect(sim.getByTestId('sim-block')).toHaveTextContent('2 / 3');
    expect(sim.getByText('TNMG 0.4 FIN')).toBeInTheDocument();
    fireEvent.click(sim.getByRole('button', { name: 'Restart simulation' }));
    expect(sim.getByTestId('sim-block')).toHaveTextContent('1 / 3');
    expect(sim.getByRole('button', { name: 'Play simulation' })).toBeInTheDocument();
    fireEvent.change(sim.getByLabelText('Operation'), { target: { value: '2' } });
    expect(sim.getByTestId('sim-block')).toHaveTextContent('1 / 1');
    expect(sim.getByText(/Shown on a fresh bar/)).toBeInTheDocument();
  });

  it('speed buttons are a labelled radio group', async () => {
    renderApp('/programs/1', makeUser(['operator']), {
      'GET /programs/1': DETAIL,
      'GET /programs/1/toolpath': PATH,
    });
    const group = await screen.findByRole('radiogroup', { name: 'Simulation speed' });
    fireEvent.click(within(group).getByRole('radio', { name: '5×' }));
    expect(within(group).getByRole('radio', { name: '5×' })).toHaveAttribute('aria-checked', 'true');
  });
});
