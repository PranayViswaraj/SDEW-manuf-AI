import { readFileSync } from 'node:fs';
import { precompute } from '../src/cnc-sim/precompute';
import { toolFor } from '../src/cnc-sim/tools';

const dir = '../samples/programs/';
/** Proven programs with their part's bar (diameter, finished length) from known_drawings.json. */
const PROVEN: Record<string, [number, number]> = {
  O0001: [48, 23],
  O0002: [36, 19.8],
  O0003: [30, 30],
  O0004: [42, 22],
  O0009: [28, 50],
  O0003_3227C07701: [40, 62],
  O0003_3227C07701_FULL: [40, 62],
};
const read = (f: string) => readFileSync(dir + f, 'ascii');
const run = (text: string, stock?: [number, number], mode: 'full' | 'machine' = 'full') =>
  precompute(text, {
    mode,
    extras: false,
    stock: stock ? { diameter: stock[0], length: stock[1] } : undefined,
  }).job;

describe('<cnc-simulator> safety checks', () => {
  it.each(Object.entries(PROVEN))('raises no false alarm on proven %s', (name, stock) => {
    for (const mode of ['full', 'machine'] as const) {
      const job = run(read(name), stock, mode);
      expect(job.checks.map((c) => `${c.code} line ${c.line}: ${c.message}`)).toEqual([]);
    }
  });

  it('raises no false alarm on the demo program with the default bar', () => {
    expect(run(readFileSync('public/samples/O0003.nc', 'ascii')).checks).toEqual([]);
  });

  it('catches a rapid through the bar', () => {
    // O0009 N1 turns the OD with G1: make that pass a rapid
    const text = read('O0009').replace('G1Z-23.0F0.15', 'G0Z-23.0');
    const job = run(text, PROVEN.O0009);
    const c = job.checks.find((k) => k.code === 'rapid-into-material');
    expect(c?.severity).toBe('error');
    expect(job.lines[c!.line - 1]).toContain('G0Z-23.0');
    expect(c!.time).toBeGreaterThan(0);
  });

  it('catches cutting with the spindle stopped', () => {
    const text = read('O0009').replace('G97S2000M4', 'G97S2000M5');
    const job = run(text, PROVEN.O0009);
    expect(job.checks.some((k) => k.code === 'spindle-off' && k.severity === 'error')).toBe(true);
  });

  it('catches a turning tool driven past the centre line', () => {
    const text = read('O0009').replace('G1X-2.0F0.15', 'G1X-6.0F0.15');
    const job = run(text, PROVEN.O0009);
    expect(job.checks.some((k) => k.code === 'past-centre')).toBe(true);
  });
});

describe('tools from operation comments', () => {
  it('keeps the station table when the comment agrees', () => {
    expect(toolFor(7, '12.0MM BB')?.name).toBe('Boring bar 12 mm');
    expect(toolFor(8, '3MM GROOVE')?.axial).toBe(true);
    expect(toolFor(5, '12 MM CCMT')?.role).toBe('bore');
  });

  it('follows the comment when another turret layout puts a different tool there', () => {
    expect(toolFor(8, 'STOPER')?.role).toBe('stopper');
    expect(toolFor(6, '23 U DRILL')).toMatchObject({ role: 'drill', drillDiameter: 23 });
    expect(toolFor(1, '32.0 UDRILL')).toMatchObject({ role: 'drill', drillDiameter: 32 });
    expect(toolFor(4, '3MM PARTING')).toMatchObject({ role: 'part', width: 3 });
    expect(toolFor(7, 'WNMG -BOREING FINESH')).toMatchObject({ role: 'bore', shape: 'W' });
    expect(toolFor(2, 'TNMG 0.4')).toMatchObject({ role: 'od', shape: 'T', noseRadius: 0.4 });
    expect(toolFor(3, 'ID CSK')?.role).toBe('bore');
    expect(toolFor(9, 'WNMG 0.8 RG')).toMatchObject({ role: 'od', noseRadius: 0.8 });
  });
});
