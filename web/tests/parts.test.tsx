import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureSchema, FeatureTable } from '../src/api/types';
import { makeUser, renderApp } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SCHEMA: FeatureSchema = {
  header: [
    { key: 'material_grade', label: 'Material grade', kind: 'text' },
    { key: 'bar_diameter', label: 'Bar diameter', kind: 'mm' },
    { key: 'overall_length', label: 'Overall length', kind: 'mm' },
  ],
  feature_types: [
    {
      type: 'od',
      label: 'OD (outside diameter)',
      fields: [
        { key: 'diameter', label: 'Diameter', kind: 'mm' },
        { key: 'length', label: 'Length', kind: 'mm' },
        { key: 'tol_plus', label: 'Tolerance +', kind: 'tol' },
        { key: 'tol_minus', label: 'Tolerance -', kind: 'tol' },
      ],
    },
  ],
};

const empty = { ai: null, value: null, confirmed: false };
const done = (v: number | string) => ({ ai: null, value: v, confirmed: true });

function table(over: Partial<FeatureTable> = {}): FeatureTable {
  return {
    id: 3,
    part_number: '3773480M01',
    drawing_ref: '',
    source: 'manual',
    status: 'draft',
    data: { header: { material_grade: empty, bar_diameter: empty, overall_length: empty }, features: [] },
    unconfirmed: ['Material grade', 'Bar diameter', 'Overall length'],
    confirmed_by_name: null,
    confirmed_at: null,
    updated_at: '',
    programs: [],
    ...over,
  };
}

const routes = { 'GET /feature-tables/schema': SCHEMA };

describe('feature table screen', () => {
  it('shows AI and confirmed columns; confirm locked until everything is ticked', async () => {
    renderApp('/parts/3', makeUser(['engineer']), { ...routes, 'GET /feature-tables/3': table() });
    expect(await screen.findByText('AI value', { selector: 'th' })).toBeInTheDocument();
    expect(screen.getByText('3 values still to enter / confirm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm table' })).toBeDisabled();
  });

  it('editing a value clears its confirmed tick; adding a feature and saving sends the data', async () => {
    const ticked = table({
      data: {
        header: { material_grade: done('EN8'), bar_diameter: done(50), overall_length: done(27) },
        features: [],
      },
    });
    const { calls } = renderApp('/parts/3', makeUser(['engineer']), {
      ...routes,
      'GET /feature-tables/3': ticked,
      'PUT /feature-tables/3': (body: unknown) => ({
        ...ticked,
        data: (body as { data: FeatureTable['data'] }).data,
      }),
    });
    const input = await screen.findByLabelText('Bar diameter value');
    fireEvent.change(input, { target: { value: '52' } });
    fireEvent.blur(input);
    expect(screen.getByLabelText('Bar diameter confirmed')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Add feature' }));
    expect(screen.getByText('1. OD (outside diameter)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const sent = calls.find((c) => c.method === 'PUT')!.body as { data: FeatureTable['data'] };
    expect(sent.data.header.bar_diameter).toEqual({ ai: null, value: 52, confirmed: false });
    expect(sent.data.features[0].type).toBe('od');
  });

  it('confirms a complete, saved table', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const complete = table({
      data: {
        header: { material_grade: done('EN8'), bar_diameter: done(50), overall_length: done(27) },
        features: [
          {
            type: 'od',
            fields: { diameter: done(44.7), length: done(26), tol_plus: done(0), tol_minus: done(-0.05) },
          },
        ],
      },
      unconfirmed: [],
    });
    renderApp('/parts/3', makeUser(['engineer']), {
      ...routes,
      'GET /feature-tables/3': complete,
      'POST /feature-tables/3/confirm': {
        ...complete,
        status: 'confirmed',
        confirmed_by_name: 'Dev Engineer',
        confirmed_at: '2026-11-10T12:00:00Z',
      },
    });
    const btn = await screen.findByRole('button', { name: 'Confirm table' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(await screen.findByText(/Confirmed by Dev Engineer/)).toBeInTheDocument();
  });

  it('is read-only for an operator', async () => {
    renderApp('/parts/3', makeUser(['operator']), { ...routes, 'GET /feature-tables/3': table() });
    expect(await screen.findByLabelText('Material grade value')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Confirm table' })).not.toBeInTheDocument();
  });

  it('lists parts with their status', async () => {
    renderApp('/parts', makeUser(['engineer']), {
      'GET /feature-tables': [
        {
          id: 3,
          part_number: 'DEMO-SIM-001',
          drawing_ref: '',
          status: 'confirmed',
          features: 2,
          unconfirmed: 0,
          confirmed_by_name: 'Dev seed (demo part)',
          confirmed_at: '',
          material_grade: 'EN8',
          bar_diameter: 45,
        },
      ],
    });
    expect(await screen.findByText('DEMO-SIM-001')).toBeInTheDocument();
    expect(screen.getByText('confirmed by Dev seed (demo part)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });
});
