import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../src/api/types';
import { makeUser, renderApp } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

export const LMW: Machine = {
  id: 1,
  key: 'lmw-lathe-1',
  name: 'LMW Lathe 1',
  make: 'LMW',
  model: '',
  controller: 'FANUC 0i-TF',
  ip_address: null,
  focas_port: 8193,
  status: 'in_service',
  bridge_id: null,
  remote_control_enabled: false,
  limits: {
    max_turning_diameter: null,
    max_turning_length: null,
    max_bar_diameter: null,
    spindle_rpm_min: null,
    spindle_rpm_max: null,
    chuck_size: null,
    turret_stations: null,
  },
  notes: '',
  created_at: '',
  updated_at: 'v1',
  tools: [],
  limits_missing: [
    'max_turning_diameter',
    'max_turning_length',
    'max_bar_diameter',
    'spindle_rpm_min',
    'spindle_rpm_max',
    'chuck_size',
    'turret_stations',
  ],
};

describe('machines', () => {
  it('lists the LMW lathe with limits not entered', async () => {
    renderApp('/machines', makeUser(['operator']), { 'GET /machines': [LMW] });
    expect(await screen.findByText('LMW Lathe 1')).toBeInTheDocument();
    expect(screen.getByText('Not entered – from nameplate')).toBeInTheDocument();
    expect(screen.getByText('FANUC 0i-TF')).toBeInTheDocument();
  });

  it('shows limits as "Not entered" placeholders and is read-only for an operator', async () => {
    renderApp('/machines/1', makeUser(['operator']), { 'GET /machines/1': LMW });
    const input = await screen.findByLabelText('Max turning diameter');
    expect(input).toHaveAttribute('placeholder', 'Not entered – from nameplate');
    expect(input).toBeDisabled();
    expect(screen.queryByText('Save machine')).not.toBeInTheDocument();
    expect(screen.getByText(/No tools entered/)).toBeInTheDocument();
  });

  it('admin saves limits; empty stays null (never invented)', async () => {
    const { calls } = renderApp('/machines/1', makeUser(['admin']), {
      'GET /machines/1': LMW,
      'PATCH /machines/1': { ...LMW, updated_at: 'v2' },
    });
    fireEvent.change(await screen.findByLabelText('Max turning diameter'), { target: { value: '250' } });
    fireEvent.click(screen.getByText('Save machine'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const body = calls.find((c) => c.method === 'PATCH')!.body as { limits: Record<string, unknown> };
    expect(body.limits.max_turning_diameter).toBe(250);
    expect(body.limits.max_turning_length).toBeNull();
  });

  it('programmer adds a tool', async () => {
    const { calls } = renderApp('/machines/1', makeUser(['programmer']), {
      'GET /machines/1': LMW,
      'POST /machines/1/tools': {},
    });
    fireEvent.click(await screen.findByText('Add tool'));
    fireEvent.change(screen.getByLabelText('tool station'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('tool tool_code'), { target: { value: 't0101' } });
    fireEvent.change(screen.getByLabelText('tool type'), { target: { value: 'drill' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      station: 1,
      tool_code: 'T0101',
      tool_type: 'drill',
      nose_radius: null,
    });
  });
});
