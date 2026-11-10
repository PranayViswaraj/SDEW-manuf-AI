import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveStatus } from '../src/api/types';
import { makeUser, renderApp } from './helpers';
import { LMW } from './machines.test';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

export const ONLINE: LiveStatus = {
  machine_id: 1,
  state: 'online',
  bridge_id: 'dev-bridge',
  bridge_connected: true,
  machine_connected: true,
  driver: 'simulated',
  age_s: 0.4,
  received_at: '',
  status: {
    mode: 'MEM',
    run_state: 'running',
    alarm: false,
    alarms: [],
    emergency: false,
    program_number: 9000,
    sequence_number: 2,
    spindle_speed: 1500,
    feed_override: 100,
    part_count: 7,
    timestamp: '',
  },
  loaded_program: 9000,
  error: null,
  remote_control_enabled: false,
  stale_after_s: 5,
};

describe('live status', () => {
  it('shows online status with all fields and the SIMULATED tag', async () => {
    renderApp('/machines/1', makeUser(['operator']), {
      'GET /machines/1': LMW,
      'GET /machines/1/live': ONLINE,
    });
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(screen.getByText('SIMULATED')).toBeInTheDocument();
    expect(screen.getByText('O9000')).toBeInTheDocument();
    expect(screen.getByText('1500 rpm')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText(/Cycle Start is pressed at the machine/)).toBeInTheDocument();
  });

  it('warns when status is stale', async () => {
    renderApp('/machines/1', makeUser(['operator']), {
      'GET /machines/1': LMW,
      'GET /machines/1/live': { ...ONLINE, state: 'stale', age_s: 7.2 },
    });
    expect(await screen.findByText('Stale')).toBeInTheDocument();
    expect(screen.getByText(/No update from the machine for 7.2 s/)).toBeInTheDocument();
  });

  it('shows offline when the bridge is down', async () => {
    renderApp('/machines/1', makeUser(['operator']), {
      'GET /machines/1': LMW,
      'GET /machines/1/live': { ...ONLINE, state: 'offline', status: null, bridge_connected: false },
    });
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    expect(screen.getByText(/bridge "dev-bridge" is not connected/)).toBeInTheDocument();
    expect(screen.queryByText('1500 rpm')).not.toBeInTheDocument();
  });

  it('shows alarms', async () => {
    renderApp('/machines/1', makeUser(['operator']), {
      'GET /machines/1': LMW,
      'GET /machines/1/live': {
        ...ONLINE,
        status: { ...ONLINE.status!, alarm: true, alarms: [{ code: 1001, message: 'SPINDLE ALARM' }] },
      },
    });
    expect(await screen.findByText('1001 SPINDLE ALARM')).toBeInTheDocument();
  });
});
