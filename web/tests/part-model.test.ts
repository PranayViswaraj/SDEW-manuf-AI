import type { Cell, FeatureTableData } from '../src/api/types';
import { buildPartModel, midTol, xWords } from '../src/lib/partModel';

const c = (v: number | string | null): Cell => ({ ai: null, value: v, confirmed: true });

const DATA: FeatureTableData = {
  header: { material_grade: c('EN8'), bar_diameter: c(40), overall_length: c(62) },
  features: [
    { type: 'face', fields: { position: c(0) } },
    { type: 'chamfer', fields: { size: c(1), angle: c(45) } },
    { type: 'od', fields: { diameter: c(31), length: c(22), tol_plus: c(0), tol_minus: c(-0.1) } },
    { type: 'od', fields: { diameter: c(38), length: c(10) } },
    { type: 'drill', fields: { diameter: c(16.5), depth: c(40) } },
    { type: 'bore', fields: { diameter: c(19), depth: c(30), tol_plus: c(0.05), tol_minus: c(0) } },
    { type: 'flip', fields: {} },
    { type: 'bore', fields: { diameter: c(22), depth: c(29) } },
  ],
};

describe('part model from the feature table', () => {
  const m = buildPartModel(DATA);

  it('cuts toleranced sizes mid-tolerance, like the generator', () => {
    expect(midTol(31, 0, -0.1)).toBe(30.95);
    expect(midTol(31, null, null)).toBe(31);
    const od = m.chars.find((k) => k.label === 'Ø31.00')!;
    expect(od).toMatchObject({ programmed: 30.95, upper: 0, lower: -0.1, op: 'OP10', xWord: true });
  });

  it('places every feature in its operation with Z from its clamping face', () => {
    expect(m.op10.map((r) => r.type)).toEqual(['face', 'chamfer', 'od', 'shoulder', 'od', 'drill', 'bore']);
    expect(m.op20.map((r) => r.type)).toEqual(['bore']);
    const [, ch, od1, sh, od2] = m.op10;
    expect(sh).toMatchObject({ nominal: 'Ø31 / Ø38', zFrom: -22, derived: true });
    expect(od1.drawing).toBe('Ø31.00, 22.00');
    expect(m.op10.map((r) => r.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']);
    expect([od1.zFrom, od1.zTo, od1.length]).toEqual([-0, -22, 22]);
    expect([od2.zFrom, od2.zTo]).toEqual([-22, -32]);
    expect([ch.zFrom, ch.zTo]).toEqual([-0, -1]); // on the front corner of the next OD
    expect(m.op20[0]).toMatchObject({ zFrom: -0, zTo: -29 });
  });

  it('builds the outline: turned steps, bar where not turned, bores from both ends', () => {
    expect(m.length).toBe(62);
    expect(m.maxDia).toBe(38);
    expect(m.outer[0]).toEqual([0, 15.475]);
    expect(m.outer.at(-1)).toEqual([62, 20]); // the back 30 mm is not turned: bar Ø40
    expect(m.inner[0][1]).toBeCloseTo(9.5125, 4); // Ø19.025 bore at the front
    expect(m.inner.at(-1)).toEqual([62, 11]); // Ø22 bore from the back
  });

  it('finds which line of the program cuts a size', () => {
    const words = xWords('%\nO1(X99 IN A COMMENT)\nG0X40.Z2.\nG1X30.95F0.1\n%');
    expect(words.get('30.950')).toBe(4);
    expect(words.has('99.000')).toBe(false);
  });

  it("carries the AI's own reading, the engineer's tick and where each dimension is", () => {
    const withAi: FeatureTableData = {
      ...DATA,
      features: [
        {
          type: 'od',
          fields: { diameter: { ai: 31.05, value: 31, confirmed: true }, length: c(22) },
        },
        {
          type: 'od',
          fields: { diameter: { ai: 38, value: null, confirmed: false }, length: c(10) },
        },
      ],
    };
    const k = buildPartModel(withAi).chars;
    const d1 = k.find((x) => x.what === 'OD (row 1)');
    expect(d1).toMatchObject({ nominal: 31, ai: 31.05, confirmed: true, pending: false, span: [0, 22] });
    const d2 = k.find((x) => x.what === 'OD (row 2)');
    expect(d2).toMatchObject({ nominal: 38, ai: 38, pending: true, span: [22, 32] });
  });
});

describe('tapers', () => {
  const pin: FeatureTableData = {
    header: { material_grade: c('H13'), bar_diameter: c(32), overall_length: c(132.24) },
    features: [
      { type: 'face', fields: { position: c(0) } },
      {
        type: 'taper',
        fields: { diameter_start: c(3.4), diameter_end: c(3.5), length: c(3.48), angle: c(1) },
      },
      {
        type: 'taper',
        fields: { diameter_start: c(16.3), diameter_end: c(21.3), length: c(71.59), angle: c(2) },
      },
      { type: 'od', fields: { diameter: c(21.3), length: c(17) } },
      { type: 'od', fields: { diameter: c(27), length: c(8), tol_plus: c(0), tol_minus: c(-0.1) } },
    ],
  };
  const m = buildPartModel(pin);

  it('plans a taper as one taper turn, with a shoulder where the size steps up', () => {
    expect(m.op10.map((r) => r.type)).toEqual(['face', 'taper', 'shoulder', 'taper', 'od', 'shoulder', 'od']);
    const t = m.op10[3];
    expect(t).toMatchObject({ typeLabel: 'Taper turn', zFrom: -3.48, zTo: -75.07, length: 71.59 });
    expect(t.nominal).toBe('Ø16.3 → Ø21.3, 2°/side, L 71.59');
    expect(t.drawing).toBe('Ø16.30, Ø21.30, 71.59, 2°');
  });

  it('draws the taper as a slope in the outline (3D and section)', () => {
    const at = (p: number) => m.outer.filter(([q]) => Math.abs(q - p) < 1e-9).map(([, r]) => r);
    expect(at(3.48)).toEqual([1.75, 8.15]); // step up from the tip taper to the long taper
    expect(at(75.07)).toEqual([10.65, 10.65]); // the taper ends at the parallel's size
  });
});

describe('point contour', () => {
  const pt = (z: number, d: number, segment: 'start' | 'line' = 'line') => ({
    z,
    d,
    segment,
    radius: null,
    evidence: '',
  });
  const base: FeatureTableData = {
    header: { material_grade: c('H13'), bar_diameter: c(30), overall_length: c(96.59) },
    features: [
      {
        type: 'taper',
        fields: { diameter_start: c(16.3), diameter_end: c(21.3), length: c(71.59), angle: c(2) },
      },
      { type: 'od', fields: { diameter: c(21.3), length: c(17), tol_plus: c(0), tol_minus: c(-0.02) } },
      { type: 'od', fields: { diameter: c(27), length: c(8) } },
    ],
  };
  const contour = (endOfTaper: number) => ({
    outer: [pt(0, 16.3, 'start'), pt(71.59, endOfTaper), pt(88.59, 21.3), pt(88.59, 27), pt(96.59, 27)],
    inner: [],
  });

  it('agrees with the table and draws the 3D outline from its points', () => {
    const m = buildPartModel({ ...base, contour: contour(21.3) });
    expect(m.contourCheck).toEqual([]);
    expect(m.outer).toEqual([
      [0, 8.15],
      [71.59, 10.65],
      [88.59, 10.65],
      [88.59, 13.5],
      [96.59, 13.5],
    ]);
  });

  it('shows where the contour and the table disagree', () => {
    const m = buildPartModel({ ...base, contour: contour(21.4) });
    expect(m.contourCheck).toHaveLength(2);
    expect(m.contourCheck[0]).toContain('At 35.795 mm: contour Ø18.850, table Ø18.800');
  });
});
