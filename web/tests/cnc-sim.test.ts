import { readFileSync } from 'node:fs';
import { interpret, parseBlocks } from '../src/sim/lathe/gcode';
import { SIM_MACHINE } from '../src/cnc-sim/config';
import { precompute } from '../src/cnc-sim/precompute';
import { Grid } from '../src/cnc-sim/grid';

const run = (body: string) => interpret(`%\nO1\n${body}\nM30\n%`, SIM_MACHINE);
const last = (body: string) => run(body).moves.at(-1)!;

describe('<cnc-simulator> parser', () => {
  it('tokenizes packed words, leading-dot numbers, comments and single-word lines', () => {
    const { blocks } = parseBlocks('G0X0.0Z10.0M8\nF.16\nU-.5\nN2222(12 MM CCMT)\nX18.5');
    expect(blocks[0].words.map((w) => `${w.letter}${w.value}`)).toEqual(['G0', 'X0', 'Z10', 'M8']);
    expect(blocks[1].words[0]).toMatchObject({ letter: 'F', value: 0.16 });
    expect(blocks[2].words[0]).toMatchObject({ letter: 'U', value: -0.5 });
    expect(blocks[3]).toMatchObject({ seq: 2222, comment: '12 MM CCMT' });
    expect(blocks[4].words).toHaveLength(1);
  });

  it('A angle end points match hand calculations', () => {
    // Z0.0A315 from X40.5 Z-2: +2 in Z, -2 on radius -> X36.5
    expect(last('G97S500M4\nG0X40.5Z-2.0\nG1Z0.0A315.0F0.15').to[1] * 2).toBeCloseTo(36.5, 6);
    // X19.0A225 from X20.5 Z0.03: -0.75 on radius, -0.75 in Z -> Z-0.72
    expect(last('G97S500M4\nG0X20.5Z0.03\nG1X19.0A225.0F0.12').to[0]).toBeCloseTo(-0.72, 6);
    // A135 X38 from X35.7 Z0: +1.15 on radius -> Z-1.15
    expect(last('G97S500M4\nG0X35.7Z0.0\nG1A135.0X38.0F0.15').to[0]).toBeCloseTo(-1.15, 6);
  });

  it('G02 X28.22 Z-34 R3 from X22.22 Z-31 is a 90 degree fillet about (Z-31, r 14.11)', () => {
    const r = run('G97S500M4\nG0X22.22Z-31.0\nG02X28.22Z-34.0R3.0F0.1');
    const arc = r.moves.filter((m) => m.kind === 'feed');
    const centre: [number, number] = [-31, 14.11]; // concave fillet: centre outside the material
    for (const m of arc) expect(Math.hypot(m.to[0] - centre[0], m.to[1] - centre[1])).toBeCloseTo(3, 4);
    expect(arc.at(-1)!.to[1] * 2).toBeCloseTo(28.22, 6);
  });

  it('G74 pecks, G71 / G72 pass depths and allowance', () => {
    const g74 = run('G97S500M4\nG0X0Z2.0\nG74R1.0\nG74Z-40.0Q5000F0.1');
    expect(g74.moves.filter((m) => m.kind === 'feed')).toHaveLength(9); // 8 pecks of 5 + to Z-40
    const g71 = run(
      'G97S2000M4\nG0X40.0Z0.5\nG71U.5R0.5\nG71P50Q60U0.5W0.0F0.3\nN50G0X22.22\nG1Z-31.0\nG1X30.9\nZ-56.0\nN60X38.0',
    );
    const levels = g71.moves.filter(
      (m) => m.kind === 'feed' && m.from[1] === m.to[1] && m.cycle === 'G71 rough',
    );
    expect(levels[0].to[1]).toBeCloseTo(19.5, 6); // 0.5 per side from r20
    expect(Math.min(...levels.map((m) => m.to[1]))).toBeCloseTo(11.11 + 0.25, 6); // U0.5 on diameter
    const g72 = run('G97S1800M4\nG0X45.0Z1.0\nG72W0.5R0.5\nG72P81Q82W0.5F0.18\nN81G0Z0.0\nN82G1X12.0');
    const faces = g72.moves.filter(
      (m) => m.kind === 'feed' && m.from[0] === m.to[0] && m.cycle === 'G72 rough',
    );
    expect(faces[0].to[0]).toBeCloseTo(0.5, 6);
  });

  it('F0.1 at S500 is 50 mm/min', () => {
    expect(last('G97S500M4\nG0X20Z2\nG1Z-10.0F0.1').feedMin).toBeCloseTo(50, 6);
  });
});

describe('<cnc-simulator> job for O0003', () => {
  const text = readFileSync('public/samples/O0003.nc', 'utf8');
  const p = precompute(text, { mode: 'full', extras: false });

  it('runs 3 setups and 12 named operations, extras off, M99 noted', () => {
    expect(p.job.setups.map((s) => s.name)).toEqual(['1ST OP', '2ND OP', '3RD OP']);
    expect(p.job.ops.map((o) => o.name)).toEqual([
      'CENTER',
      '16.5 DRILL',
      'FACING',
      '12.0MM BB',
      'CENTER',
      '16.5 DRILL',
      'FACING',
      '12.0MM BB',
      '3MM GROOVE',
      '12 MM CCMT',
      'OD RG',
      'OD FIN',
    ]);
    expect(p.job.m99Target).toBe(4);
    expect(p.job.warnings.join('\n')).toMatch(/T05 is used for 2 jobs/);
  });

  it('cuts the finished part: bore 19, D22.2 spigot, D30.9 body, flange face groove', () => {
    const g = new Grid();
    g.restore(p.final);
    const runs = (pp: number) => {
      const j = Math.floor((pp - g.pMin) / g.res);
      const out: [number, number][] = [];
      let k = 0;
      while (k < g.nr) {
        if (!g.occ[j * g.nr + k]) {
          k++;
          continue;
        }
        const k0 = k;
        while (k < g.nr && g.occ[j * g.nr + k]) k++;
        out.push([k0 * g.res, k * g.res]);
      }
      return out;
    };
    expect(runs(20)[0][0]).toBeCloseTo(9.5, 1);
    expect(runs(20)[0][1]).toBeCloseTo(11.1, 1);
    expect(runs(40)[0][1]).toBeCloseTo(15.45, 1);
    expect(runs(61)).toHaveLength(2); // face groove splits the flange section
  });

  it('machine-accurate mode starts at N4 only', () => {
    const m = precompute(text, { mode: 'machine', extras: false });
    expect(m.job.setups).toHaveLength(1);
    expect(m.job.ops[0].name).toBe('CENTER');
  });
});

describe('<cnc-simulator> programs without setup markers', () => {
  it('simulates the N4-N8 extract (no "(1ST OPN)" comments) instead of showing nothing', () => {
    const text = readFileSync('../samples/programs/O0003_3227C07701', 'ascii');
    const p = precompute(text, { mode: 'full', extras: false });
    expect(p.job.setups).toHaveLength(1);
    expect(p.job.count).toBeGreaterThan(50);
    expect(p.job.ops.map((o) => o.name)).toEqual([
      'CENTER',
      '16.5 DRILL',
      'FACING',
      '12.0MM BB',
      '3MM GROOVE',
    ]);
  });
});
