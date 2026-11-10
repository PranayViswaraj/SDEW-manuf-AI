import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityResponse } from '../src/components/CapablePanel';
import type { FeatureTable } from '../src/api/types';
import { makeUser, renderApp } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const done = (v: number | string) => ({ ai: null, value: v, confirmed: true });

const CONFIRMED: FeatureTable = {
  id: 4,
  part_number: 'DEMO-SIM-001',
  drawing_ref: '',
  source: 'manual',
  status: 'confirmed',
  data: {
    header: { material_grade: done('EN8'), bar_diameter: done(45), overall_length: done(20) },
    features: [],
  },
  unconfirmed: [],
  confirmed_by_name: 'Dev seed (demo part)',
  confirmed_at: '2026-11-10T00:00:00Z',
  updated_at: '',
  programs: [],
};

const CAP: CapabilityResponse = {
  part_number: 'DEMO-SIM-001',
  available: [
    {
      machine_id: 2,
      machine_name: 'SIM Lathe (dev - simulated)',
      live_state: 'online',
      verdict: 'capable',
      summary: 'Capable',
      reasons: [],
    },
  ],
  excluded: [
    {
      machine_id: 1,
      machine_name: 'LMW Lathe 1',
      live_state: 'online',
      verdict: 'unknown',
      summary: 'Unknown – machine limits not entered',
      reasons: [],
      excluded_because: ['Unknown – machine limits not entered (bar diameter limit).'],
    },
  ],
};

describe('capable machines', () => {
  it('lists available machines and explains excluded ones', async () => {
    renderApp('/parts/4', makeUser(['engineer']), {
      'GET /feature-tables/schema': { header: [], feature_types: [] },
      'GET /feature-tables/4': CONFIRMED,
      'GET /capability': CAP,
    });
    expect(await screen.findByText('SIM Lathe (dev - simulated)')).toBeInTheDocument();
    expect(screen.getByText('available')).toBeInTheDocument();
    expect(screen.getByText('LMW Lathe 1')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(
      screen.getByText('Unknown – machine limits not entered (bar diameter limit).'),
    ).toBeInTheDocument();
  });

  it('is not shown for a draft table', async () => {
    renderApp('/parts/4', makeUser(['engineer']), {
      'GET /feature-tables/schema': { header: [], feature_types: [] },
      'GET /feature-tables/4': { ...CONFIRMED, status: 'draft' },
    });
    await screen.findByText('draft');
    expect(screen.queryByText('Machines for this part')).not.toBeInTheDocument();
  });
});
