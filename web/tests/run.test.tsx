import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunDetail } from '../src/api/types';
import { makeUser, renderApp } from './helpers';
import { ONLINE } from './live.test';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const CHECK = [
  'Correct raw material loaded',
  'Tools and offsets match the program',
  'Chuck clamped',
  'Door closed',
  'No alarm on machine',
  'Operator at machine',
];

function run(over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: 5,
    status: 'checklist',
    status_note: '',
    machine: { id: 2, name: 'SIM Lathe (dev - simulated)', remote_control_enabled: true },
    program: { id: 9, name: 'O9000', title: 'DEMO', version: 1, status: 'approved', proven: false },
    program_hash: 'abc',
    part_number: 'DEMO-SIM-001',
    required_material: { material_grade: 'EN8', bar_diameter: 45, overall_length: 20 },
    material: null,
    material_note: '',
    checklist: CHECK.map((label, i) => ({ key: `k${i}`, label, ticked: false, by: null, at: null })),
    created_at: '',
    sent_at: null,
    started_at: null,
    finished_at: null,
    start_mode: null,
    first_piece: { result: null, measurements: [], notes: '', at: null },
    live: { ...ONLINE, status: { ...ONLINE.status!, run_state: 'idle' } },
    send_blockers: ['Tick every safety checklist item: Door closed.'],
    start_blockers: ['Send the program first.'],
    ...over,
  };
}

const base = { 'GET /materials': [] };

describe('run screen', () => {
  it('shows checklist, live status and locked buttons with reasons', async () => {
    renderApp('/runs/5', makeUser(['operator'], { can_start_machine: true }), {
      ...base,
      'GET /runs/5': run(),
    });
    expect(await screen.findByText('Chuck clamped')).toBeInTheDocument();
    expect(screen.getByText('0 / 6 ticked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send program' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByText('Tick every safety checklist item: Door closed.')).toBeInTheDocument();
    expect(screen.getByText(/EN8 bar Ø45 mm/)).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('ticks a checklist item through the API', async () => {
    const { calls } = renderApp('/runs/5', makeUser(['operator']), {
      ...base,
      'GET /runs/5': run(),
      'PUT /runs/5/checklist': run(),
    });
    fireEvent.click(await screen.findByLabelText('Door closed'));
    await waitFor(() => expect(calls.some((c) => c.path === '/runs/5/checklist')).toBe(true));
    expect(calls.find((c) => c.path === '/runs/5/checklist')?.body).toEqual({ item: 'k3', ticked: true });
  });

  it('asks for confirmation before sending, then sends', async () => {
    const ready = run({ send_blockers: [] });
    const { calls } = renderApp('/runs/5', makeUser(['operator']), {
      ...base,
      'GET /runs/5': ready,
      'POST /runs/5/send': {
        action: { action: 'send_program', result: 'ok', error: null },
        run: run({ status: 'sent', send_blockers: ['already sent'], start_blockers: [] }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Send program' }));
    const dialog = screen.getByRole('dialog', { name: 'Send program to the machine?' });
    expect(calls.some((c) => c.path === '/runs/5/send')).toBe(false); // nothing sent yet
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send program' }));
    expect(await screen.findByText('Program sent and verified on the machine.')).toBeInTheDocument();
  });

  it('confirms before Start', async () => {
    renderApp('/runs/5', makeUser(['operator'], { can_start_machine: true }), {
      ...base,
      'GET /runs/5': run({ status: 'sent', send_blockers: ['sent'], start_blockers: [] }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(screen.getByRole('dialog', { name: 'Start the machine?' })).toBeInTheDocument();
  });

  it('remote control off: no Start button, tells the operator to press Cycle Start', async () => {
    renderApp('/runs/5', makeUser(['operator']), {
      ...base,
      'GET /runs/5': run({
        status: 'sent',
        machine: { id: 1, name: 'LMW Lathe 1', remote_control_enabled: false },
        live: { ...ONLINE, remote_control_enabled: false },
      }),
    });
    expect(await screen.findByText('Program sent. Press Cycle Start at the machine.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Feed hold' })).not.toBeInTheDocument();
  });

  it('no button is presented as an emergency stop', async () => {
    renderApp('/runs/5', makeUser(['operator']), {
      ...base,
      'GET /runs/5': run({ status: 'running' }),
    });
    await screen.findByRole('button', { name: 'Stop' });
    for (const b of screen.getAllByRole('button')) {
      expect(b.textContent ?? '').not.toMatch(/e-?stop|emergency/i);
    }
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveAttribute(
      'title',
      'Program reset through the control. NOT an emergency stop.',
    );
  });

  it('records a passing first piece', async () => {
    const { calls } = renderApp('/runs/5', makeUser(['operator']), {
      ...base,
      'GET /runs/5': run({ status: 'completed' }),
      'POST /runs/5/first-piece': run({
        status: 'closed',
        program: { ...run().program, proven: true },
        first_piece: { result: 'pass', measurements: [], notes: '', at: '' },
      }),
    });
    fireEvent.change(await screen.findByLabelText('feature 1'), { target: { value: 'OD 40' } });
    fireEvent.change(screen.getByLabelText('measured 1'), { target: { value: '39.98' } });
    fireEvent.click(screen.getByLabelText('Pass'));
    fireEvent.click(screen.getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/runs/5/first-piece')).toBe(true));
    expect(calls.find((c) => c.path === '/runs/5/first-piece')?.body).toMatchObject({
      result: 'pass',
      measurements: [{ feature: 'OD 40', nominal: '', measured: '39.98' }],
    });
  });

  it('run log shows who ran which program, where, when and the first piece result', async () => {
    renderApp('/run', makeUser(['operator']), {
      'GET /machines': [],
      'GET /runs': [
        {
          id: 7,
          status: 'closed',
          operator: 'Dev Operator',
          sent_at: '2026-11-10T10:00:00Z',
          started_at: '2026-11-10T10:01:00Z',
          finished_at: '2026-11-10T10:05:00Z',
          start_mode: 'at_machine',
          first_piece_by: 'Dev Operator',
          first_piece_at: '2026-11-10T10:10:00Z',
          machine_name: 'LMW Lathe 1',
          program_name: 'O0009',
          program_version: 1,
          part_number: '3216C11701',
          created_at: '2026-11-10T09:58:00Z',
          first_piece_result: 'pass',
        },
      ],
    });
    expect(await screen.findByText('Run log')).toBeInTheDocument();
    expect(screen.getAllByText('Dev Operator').length).toBeGreaterThan(0);
    expect(screen.getByText('2026-11-10 10:01')).toBeInTheDocument();
    expect(screen.getByText('started at machine')).toBeInTheDocument();
    expect(screen.getByText('pass')).toBeInTheDocument();
  });

  it('pre-fills the first piece from the confirmed feature table and marks values out of tolerance', async () => {
    const { calls } = renderApp('/runs/5', makeUser(['operator']), {
      ...base,
      'GET /runs/5': run({
        status: 'completed',
        inspection_plan: [
          { feature: '1. OD diameter', nominal: 44.7, unit: 'mm', min: 44.65, max: 44.7 },
          { feature: '1. OD length', nominal: 26, unit: 'mm', min: null, max: null },
        ],
      }),
      'POST /runs/5/first-piece': run({ status: 'closed' }),
    });
    expect(await screen.findByText('1. OD diameter')).toBeInTheDocument();
    expect(screen.getByText('44.65 to 44.7')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('measured 1'), { target: { value: '44.80' } });
    expect(screen.getByText('OUT')).toBeInTheDocument();
    expect(screen.getByText('1 value is outside the tolerance.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('measured 1'), { target: { value: '44,68' } });
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('Every toleranced value is within the limits.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Fail'));
    fireEvent.click(screen.getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/runs/5/first-piece')).toBe(true));
    expect(calls.find((c) => c.path === '/runs/5/first-piece')?.body).toMatchObject({
      result: 'fail',
      measurements: [{ feature: '1. OD diameter', nominal: '44.7 (44.65 to 44.7)', measured: '44,68' }],
    });
  });

  it('warns when the chosen bar is not what the part needs', async () => {
    renderApp('/runs/5', makeUser(['operator']), {
      ...base,
      'GET /runs/5': run({ material: { id: 3, grade: 'EN 24', bar_diameter: 45, notes: '' } }),
    });
    expect(await screen.findByText(/Not the grade or size this part needs/)).toBeInTheDocument();
  });

  it('shows the next step and offers to continue an open run', async () => {
    renderApp('/run', makeUser(['operator']), {
      'GET /machines': [],
      'GET /runs': [
        {
          id: 8,
          status: 'sent',
          operator: 'Dev Operator',
          sent_at: null,
          started_at: null,
          finished_at: null,
          start_mode: null,
          first_piece_by: null,
          first_piece_at: null,
          machine_name: 'LMW Lathe 1',
          program_name: 'O0001',
          program_version: 1,
          part_number: '3773480M01',
          created_at: '2026-11-10T09:58:00Z',
          first_piece_result: null,
        },
      ],
    });
    const link = await screen.findByRole('link', { name: /Continue run #8: O0001 on LMW Lathe 1/ });
    expect(link).toHaveAttribute('href', '/runs/8');
    expect(screen.getByText(/next: start the machine/)).toBeInTheDocument();
  });
});
