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

describe('part report: before any value is entered', () => {
  it('shows one clear empty state that says what fills the report', () => {
    const empty: FeatureTableData = {
      header: { material_grade: c(null), bar_diameter: c(null), overall_length: c(null) },
      features: [],
    };
    render(
      <PartReport model={buildPartModel(empty)} partNumber="P-2" drawingRef="p2.pdf" programText={null} />,
    );
    expect(screen.getByText('Nothing read from this drawing yet')).toBeInTheDocument();
    expect(screen.getByText(/The AI reader is off on this server/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Characteristics' })).not.toBeInTheDocument();
  });
});

describe('part report: off-lathe features', () => {
  it('lists what the generated lathe program does not cut, from the AI 3D analysis', () => {
    render(
      <PartReport
        model={buildPartModel(DATA)}
        partNumber="P-1"
        drawingRef="p1.pdf"
        programText={null}
        nonTurned={['Flat on the Ø27 head, 10.93 from the axis, 2X R3']}
      />,
    );
    const op30 = screen.getByRole('list', { name: 'OP30 features' });
    expect(op30).toHaveTextContent('Flat on the Ø27 head');
    expect(screen.getByText('Not in the generated lathe program')).toBeInTheDocument();
  });
});

describe('part report: the point contour', () => {
  it('lists every point in mm and says it agrees with the table', () => {
    const withContour: FeatureTableData = {
      ...DATA,
      contour: {
        outer: [
          { z: 0, d: 31, segment: 'start', radius: null, evidence: 'Ø31' },
          { z: 22, d: 31, segment: 'line', radius: null, evidence: '22' },
          { z: 22, d: 38, segment: 'line', radius: null, evidence: 'Ø38' },
          { z: 32, d: 38, segment: 'line', radius: null, evidence: '10' },
        ],
        inner: [],
      },
    };
    withContour.header = { ...DATA.header, overall_length: c(32) };
    render(
      <PartReport
        model={buildPartModel(withContour)}
        partNumber="P-3"
        drawingRef="p3.pdf"
        programText={null}
      />,
    );
    const t = screen.getByRole('table', { name: 'Contour points' });
    expect(within(t).getAllByRole('row')).toHaveLength(5);
    expect(t).toHaveTextContent('22.000');
    expect(t).toHaveTextContent('Ø38.000');
    expect(screen.getByText(/agrees with the feature table to 0.02 mm/)).toBeInTheDocument();
    fireEvent.click(within(t).getAllByRole('row')[3]);
    expect(screen.getByText('P3: 22.000 mm from the front face, Ø38.000')).toBeInTheDocument();
  });
});
