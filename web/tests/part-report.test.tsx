import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Cell, FeatureTableData } from '../src/api/types';
import PartReport from '../src/components/PartReport';
import { buildPartModel } from '../src/lib/partModel';

vi.mock('../src/components/PartPreview3D', () => ({ default: () => <div data-testid="part-3d" /> }));

const c = (value: number | string | null, ai: number | string | null = value, confirmed = true): Cell => ({
  ai,
  value,
  confirmed,
});

const DATA: FeatureTableData = {
  header: { material_grade: c('EN8'), bar_diameter: c(40), overall_length: c(62) },
  features: [
    {
      type: 'od',
      fields: { diameter: c(31, 31.05, true), length: c(22), tol_plus: c(0), tol_minus: c(-0.2) },
    },
    { type: 'od', fields: { diameter: c(38), length: c(10) } },
  ],
};

describe('part report: characteristics read twice', () => {
  it('flags a dimension where the AI reading and the engineer value differ', () => {
    render(
      <PartReport model={buildPartModel(DATA)} partNumber="P-1" drawingRef="p1.pdf" programText={null} />,
    );
    const table = screen.getByRole('table', { name: 'Characteristics' });
    const rows = within(table).getAllByRole('row');
    const od = rows.find((r) => r.textContent?.includes('Ø31.00'))!;
    expect(od).toHaveTextContent('31.0500');
    expect(od).toHaveTextContent('+0.0500');
    expect(od).toHaveTextContent('readings differ');
    expect(od).toHaveTextContent('engineer value checked on the drawing');
    const big = rows.find((r) => r.textContent?.includes('Ø38.00'))!;
    expect(big).toHaveTextContent('matches');
    expect(screen.getByText('5 / 5 · 1 differ')).toBeInTheDocument();
  });

  it('shows the selected dimension on the part and in the plan', () => {
    render(
      <PartReport model={buildPartModel(DATA)} partNumber="P-1" drawingRef="p1.pdf" programText={null} />,
    );
    const table = screen.getByRole('table', { name: 'Characteristics' });
    const od = within(table)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('Ø38.00'))!;
    fireEvent.click(od);
    expect(od).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/D4 Ø38.00: OD \(row 2\), OP10/)).toBeInTheDocument();
    const plan = screen.getByRole('table', { name: 'OP10 features' });
    const planRow = within(plan)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('Ø38 × 10'))!;
    expect(planRow.className).toContain('bg-sky-50');
  });
});
