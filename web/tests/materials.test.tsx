import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, renderApp } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const EN8 = {
  id: 1,
  grade: 'EN8',
  bar_diameter: 28,
  available_length: 3000,
  stock_quantity: 12,
  quantity_unit: 'bars',
  notes: 'SAMPLE DATA - not real stock',
  created_at: '',
  updated_at: '',
};

describe('materials', () => {
  it('lists and searches materials', async () => {
    const { calls } = renderApp('/materials', makeUser(['operator']), { 'GET /materials': [EN8] });
    expect(await screen.findByText('EN8')).toBeInTheDocument();
    expect(screen.queryByText('Import CSV / XLSX')).not.toBeInTheDocument(); // operator read-only
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'c45' } });
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.path === '/materials')).toBe(true));
    await waitFor(() =>
      expect(
        (vi.mocked(fetch).mock.calls as unknown as [string][]).some(([u]) => String(u).includes('q=c45')),
      ).toBe(true),
    );
  });

  it('runs the import wizard with the suggested mapping', async () => {
    const { calls } = renderApp('/materials', makeUser(['engineer']), {
      'GET /materials': [],
      'POST /materials/import/preview': {
        headers: ['Material Grade', 'Bar Dia (mm)'],
        sample_rows: [['EN8', '28']],
        row_count: 1,
        suggested_mapping: {
          grade: 'Material Grade',
          bar_diameter: 'Bar Dia (mm)',
          available_length: null,
          stock_quantity: null,
          notes: null,
        },
        target_fields: ['grade', 'bar_diameter', 'available_length', 'stock_quantity', 'notes'],
      },
      'POST /materials/import': {
        dry_run: false,
        created: 1,
        updated: 0,
        skipped: 0,
        errors: 0,
        rows: [{ row_number: 2, status: 'created', message: 'EN8 Ø28' }],
      },
    });
    fireEvent.click(await screen.findByText('Import CSV / XLSX'));
    const file = new File(['Material Grade,Bar Dia (mm)\nEN8,28\n'], 'stock.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Register file'), { target: { files: [file] } });
    expect(await screen.findByLabelText('map grade')).toHaveValue('Material Grade');
    fireEvent.click(screen.getByText('Import'));
    expect(await screen.findByText(/1 new, 0 updated/)).toBeInTheDocument();
    const sent = calls.find((c) => c.path === '/materials/import')!.body as FormData;
    expect(JSON.parse(sent.get('mapping') as string).grade).toBe('Material Grade');
    expect(sent.get('on_duplicate')).toBe('skip');
  });
});
