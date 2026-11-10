import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Toolpath } from '../src/components/ToolpathView';
import { makeUser, renderApp } from './helpers';
import { DETAIL } from './programs.test';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const PATH: Toolpath = {
  segments: [
    {
      block: 2,
      line: 3,
      tool: 1,
      kind: 'rapid',
      cycle: false,
      points: [
        [10, 25],
        [2, 20],
      ],
    },
    {
      block: 3,
      line: 4,
      tool: 1,
      kind: 'feed',
      cycle: false,
      points: [
        [2, 20],
        [-10, 20],
      ],
    },
    {
      block: 4,
      line: 5,
      tool: 2,
      kind: 'feed',
      cycle: false,
      points: [
        [-10, 20],
        [-10, 15],
      ],
    },
  ],
  blocks: [
    { index: 0, line: 2, text: 'O0001(TEST)' },
    { index: 1, line: 3, text: 'T0101' },
    { index: 2, line: 3, text: 'G0X50.0Z10.0' },
    { index: 3, line: 4, text: 'G1X40.0Z-10.0F0.2' },
    { index: 4, line: 5, text: 'X30.0' },
  ],
  warnings: [{ line: 7, message: 'G83: drawn from the start point' }],
  tools: [1, 2],
  bounds: { z_min: -10, z_max: 10, r_min: 15, r_max: 25 },
  stock: null,
};

describe('tool path view', () => {
  it('draws rapid dashed and feed solid, with a block slider', async () => {
    renderApp('/programs/1', makeUser(['programmer']), {
      'GET /programs/1': DETAIL,
      'GET /programs/1/toolpath': PATH,
    });
    const svg = await screen.findByRole('img', { name: 'Tool path drawing' });
    const lines = svg.querySelectorAll('polyline');
    expect(lines).toHaveLength(3);
    expect(lines[0].getAttribute('stroke-dasharray')).toBe('4 3');
    expect(lines[1].getAttribute('stroke-dasharray')).toBeNull();
    expect(lines[1].getAttribute('points')).toBe('2,-20 -10,-20'); // radius drawn upwards
    expect(screen.getByTestId('current-block')).toHaveTextContent('X30.0');
    fireEvent.change(screen.getByLabelText('Block slider'), { target: { value: '0' } });
    expect(screen.getByTestId('current-block')).toHaveTextContent('G0X50.0Z10.0');
    expect(screen.getByText(/G83: drawn from the start point/)).toBeInTheDocument();
  });

  it('requests the stock outline when a bar diameter is entered', async () => {
    const { calls } = renderApp('/programs/1', makeUser(['operator']), {
      'GET /programs/1': DETAIL,
      'GET /programs/1/toolpath': PATH,
    });
    fireEvent.change(await screen.findByLabelText('Bar diameter'), { target: { value: '50' } });
    await waitFor(() =>
      expect(
        (vi.mocked(fetch).mock.calls as unknown as [string][]).some(([u]) => u.includes('bar_diameter=50')),
      ).toBe(true),
    );
    expect(calls.length).toBeGreaterThan(0);
  });
});
