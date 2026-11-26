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
    expect(m.op10.map((r) => r.type)).toEqual(['face', 'chamfer', 'od', 'od', 'drill', 'bore']);
    expect(m.op20.map((r) => r.type)).toEqual(['bore']);
    const [, ch, od1, od2] = m.op10;
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
});
