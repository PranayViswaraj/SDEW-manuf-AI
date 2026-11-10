import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgramDetail, ProgramSummary } from '../src/api/types';
import { makeUser, renderApp } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SUMMARY: ProgramSummary = {
  id: 1,
  machine_id: 1,
  machine_name: 'LMW Lathe 1',
  part_number: '3773480M01',
  program_number: 1,
  name: 'O0001',
  title: 'SLEEVE 4WD',
  version: 1,
  is_latest: true,
  sha256: '92e55218576f6beec6fb2b8e1949d5489d323905c7283e54e7cce50a44fbfef9',
  status: 'approved',
  source: 'trusted_import',
  source_note: 'trusted, supplied by company',
  approved_by_name: 'Company (trusted import)',
  approved_at: '2026-11-10T00:00:00Z',
  proven: true,
  created_at: '',
  error_count: 0,
  warning_count: 6,
};

export const DETAIL: ProgramDetail = {
  ...SUMMARY,
  text: '%\r\nO0001(3773480M01 SLEEVE 4WD)\r\nM00\r\nM30\r\n%',
  lines: ['%', 'O0001(3773480M01 SLEEVE 4WD)', 'M00', 'M30', '%'],
  approved_hash: SUMMARY.sha256,
  status_note: '',
  proven_note: 'Supplied by the company as proven on LMW Lathe 1.',
  validation: {
    ok: true,
    errors: [],
    warnings: [{ code: 'W_M00_STOP', severity: 'warning', message: 'M00 program stop', line: 3 }],
    infos: [],
  },
  versions: [{ id: 1, version: 1, status: 'approved', sha256: SUMMARY.sha256, created_at: '' }],
  sendable_problem: null,
};

describe('programs', () => {
  it('lists the trusted programs as approved and proven', async () => {
    renderApp('/programs', makeUser(['operator']), {
      'GET /programs': [SUMMARY],
      'GET /machines': [],
    });
    expect(await screen.findByText('O0001')).toBeInTheDocument();
    expect(screen.getByText('approved')).toBeInTheDocument();
    expect(screen.getByText('proven')).toBeInTheDocument();
    expect(screen.getByText('no errors')).toBeInTheDocument();
    expect(screen.getByText('trusted, supplied by company')).toBeInTheDocument();
    expect(screen.queryByText('Upload program')).not.toBeInTheDocument();
  });

  it('shows detail with hash, warnings and text; operator sees no approve button', async () => {
    renderApp('/programs/1', makeUser(['operator']), { 'GET /programs/1': DETAIL });
    expect(await screen.findByText(SUMMARY.sha256)).toBeInTheDocument();
    expect(screen.getByText('M00 program stop')).toBeInTheDocument();
    expect(screen.getByText('O0001(3773480M01 SLEEVE 4WD)')).toBeInTheDocument();
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
  });

  it('programmer approves a draft with no errors', async () => {
    const draft = { ...DETAIL, status: 'draft' as const, sendable_problem: 'not approved' };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = renderApp('/programs/1', makeUser(['programmer']), {
      'GET /programs/1': draft,
      'POST /programs/1/approve': DETAIL,
    });
    fireEvent.click(await screen.findByText('Approve'));
    await waitFor(() => expect(calls.some((c) => c.path === '/programs/1/approve')).toBe(true));
    expect(await screen.findByText(/Approved by Company/)).toBeInTheDocument();
  });

  it('approve is disabled while there are validation errors', async () => {
    const bad = {
      ...DETAIL,
      status: 'draft' as const,
      validation: {
        ok: false,
        errors: [
          { code: 'E_END', severity: 'error' as const, message: 'Program must end with M30', line: 4 },
        ],
        warnings: [],
        infos: [],
      },
    };
    renderApp('/programs/1', makeUser(['programmer']), { 'GET /programs/1': bad });
    expect(await screen.findByText('Approve')).toBeDisabled();
    expect(screen.getByText('Program must end with M30')).toBeInTheDocument();
  });
});
