import { readFileSync } from 'node:fs';
import { materialAt, runSimulation } from '../src/sim/lathe/engine';
import { BAD_PROGRAM, DEMO_PROGRAM, SIM_LATHE, demoInput } from '../src/sim/lathe/demo';
import { interpret, listSections, parseBlocks } from '../src/sim/lathe/gcode';
import { parseHolderCode, parseInsertCode, toolGeometry } from '../src/sim/lathe/tools';
import type { SimInput, SimMachine } from '../src/sim/lathe/types';

const machine: SimMachine = { ...SIM_LATHE };
const prog = (body: string) => `%\nO1\n${body}\nM30\n%`;

describe('lathe interpreter', () => {
  it('reads words and comments per line', () => {
    const { blocks } = parseBlocks('N10G1X20.Z-5(HELLO)F.1');
    expect(blocks[0].seq).toBe(10);
    expect(blocks[0].comment).toBe('HELLO');
    expect(blocks[0].words.map((w) => w.letter)).toEqual(['N', 'G', 'X', 'Z', 'F']);
  });

  it('stores X as radius and times feed moves from mm/rev x rpm', () => {
    const r = interpret(prog('G97S1000M3\nG0X40.0Z2.0\nG99G1Z-48.0F0.2'), machine);
    const feed = r.moves.find((m) => m.kind === 'feed')!;
    expect(feed.from).toEqual([2, 20]);
    expect(feed.feedMin).toBeCloseTo(200);
    expect(feed.realTime).toBeCloseTo(50 / (200 / 60), 6); // 50 mm at 200 mm/min = 15 s
  });

  it('G96 sets rpm from the diameter, limited by G50 S', () => {
    const r = interpret(prog('G50S2000\nG96S200M4\nG0X100.0Z2.0\nG1Z0F0.1\nG1X2.0'), machine);
    const atD100 = r.moves.find((m) => m.kind === 'feed')!;
    expect(atD100.rpm).toBeCloseTo((1000 * 200) / (Math.PI * 100), 3); // 636.6 rpm at Ø100
    const facing = r.moves.filter((m) => m.kind === 'feed')[1];
    expect(facing.rpm).toBeLessThanOrEqual(2000);
    expect(r.checks.some((c) => c.code === 'g96-no-g50')).toBe(false);
  });

  it('warns about G96 without G50', () => {
    const r = interpret(prog('G96S200M4\nG0X50Z2'), machine);
    expect(r.checks.map((c) => c.code)).toContain('g96-no-g50');
  });

  it('counts rapids at the rapid rate and dwells', () => {
    const r = interpret(prog('G0X40.0Z100.0\nG0Z0.0\nG4X1.5'), machine);
    const rapid = r.moves.filter((m) => m.kind === 'rapid')[1];
    expect(rapid.realTime).toBeCloseTo(100 / (20000 / 60), 6);
    expect(r.moves.find((m) => m.kind === 'dwell')!.realTime).toBe(1.5);
  });

  it('expands G71 into real roughing passes', () => {
    const text = prog(
      'G97S800M4\nG0X52.0Z2.0\nG71U2.0R0.5\nG71P10Q20U0.4W0.1F0.25\nN10G0X30.0\nG1Z-20.0\nN20G1X52.0\nG0X100Z100',
    );
    const r = interpret(text, machine);
    const passes = r.moves.filter(
      (m) => m.kind === 'feed' && m.cycle === 'G71 rough' && m.from[1] === m.to[1],
    );
    // From r=26 down to r=15.2 in 2 mm steps, then the contour pass along Z.
    expect(passes.map((m) => m.to[1])).toEqual([24, 22, 20, 18, 16, 15.2]);
  });

  it('expands G76 threading and G75 grooving', () => {
    const r = interpret(
      prog('G97S1000M4\nG0X34.0Z5.0\nG76P010060Q50R0.02\nG76X28.16Z-14.0P920Q300F1.5'),
      machine,
    );
    const thread = r.moves.filter((m) => m.kind === 'thread');
    expect(thread.length).toBeGreaterThan(5);
    expect(Math.min(...thread.map((m) => m.to[1]))).toBeCloseTo(14.08, 5);
    expect(thread[0].pitch).toBe(1.5);
    const g = interpret(prog('G97S800M4\nG0X34.0Z-18.0\nG75R0.5\nG75X27.0P1000F0.08'), machine);
    expect(g.moves.filter((m) => m.kind === 'feed').at(-1)!.to[1]).toBeCloseTo(13.5);
  });

  it('marks positions unknown after G28 when home is not known', () => {
    const r = interpret(prog('G0X50Z5\nG28U0W0\nG0X40Z2'), { ...machine, home: null });
    expect(r.moves.at(-1)!.known).toBe(false);
  });
});

describe('tool data', () => {
  it('reads ISO insert and holder codes', () => {
    expect(parseInsertCode('CNMG 120408')).toEqual({ shape: 'C', size: 12, nose: 0.8 });
    expect(parseHolderCode('PCLNR 2525M12')).toMatchObject({ shape: 'C', lead: 95, hand: 'R' });
    expect(parseHolderCode('S20S-SCLCR09')).toMatchObject({ lead: 95, bar: 20 });
  });

  it('turns a tool with unknown shape into a tip point', () => {
    const g = toolGeometry({
      number: 1,
      name: 'X',
      role: 'od',
      shape: null,
      insertSize: null,
      noseRadius: null,
      tipDirection: 3,
      holder: null,
      leadAngle: null,
    });
    expect(g.shaped).toBe(false);
    expect(g.missing).toContain('insert shape');
  });
});

describe('demo program on the SIM Lathe', () => {
  const r = runSimulation(demoInput(DEMO_PROGRAM));

  it('plays end to end with no errors or warnings', () => {
    expect(r.checks).toEqual([]);
    expect(r.blocked).toBe(false);
  });

  it('has every operation, in order, with times', () => {
    const ops = r.ops.filter((o) => o.op !== 'Other').map((o) => o.op);
    expect(ops).toEqual(['Face', 'Rough', 'Finish', 'Drill', 'Bore', 'Groove', 'Thread', 'Part-off']);
    for (const o of r.ops.filter((x) => x.op !== 'Other')) expect(o.time).toBeGreaterThan(1);
    expect(r.realTimePartial).toBe(false);
    expect(r.realTime).toBeGreaterThan(120);
    expect(r.realTime).toBeLessThan(240);
  });

  it('cuts the right shape', () => {
    const f = r.final;
    const g = r.grid;
    const at = (z: number) => Math.floor((z - g.zMin) / g.res);
    expect(f.partedAt).toBeCloseTo(-45, 0);
    expect(f.outer[at(-30)]).toBeCloseTo(22, 2); // Ø44
    expect(f.outer[at(-8)]).toBeCloseTo(15, 2); // Ø30 (thread major)
    expect(f.outer[at(-16.5)]).toBeCloseTo(13.5, 2); // groove Ø27
    expect(f.inner[at(-10)]).toBeCloseTo(10, 2); // bore Ø20
    expect(f.inner[at(-35)]).toBeCloseTo(8, 2); // drill Ø16
    expect(f.threads).toHaveLength(1);
    expect(f.threads[0].pitch).toBe(1.5);
    expect(f.threads[0].minor).toBeCloseTo(14.08, 2);
    expect(r.compare!.summary).toMatch(/matches the drawing/);
  });

  it('rebuilds any moment from snapshots the same as the full run', () => {
    const end = materialAt(r, demoInput(), r.moves.length, 0);
    expect(Array.from(end.outer)).toEqual(Array.from(r.final.outer));
    expect(end.partedAt).toBe(r.final.partedAt);
  });
});

describe('deliberately bad program', () => {
  const r = runSimulation(demoInput(BAD_PROGRAM));
  const codes = (sev: string) => new Set(r.checks.filter((c) => c.severity === sev).map((c) => c.code));

  it('shows its errors with lines and blocks approval', () => {
    expect(r.blocked).toBe(true);
    for (const code of [
      'rapid-into-material',
      'chuck-collision',
      'insert-rubbing',
      'past-centre',
      'bar-too-big',
      'spindle-off',
      'cut-after-partoff',
      'undersize',
    ])
      expect(codes('error')).toContain(code);
    for (const code of ['g96-no-g50', 'spindle-direction', 'oversize'])
      expect(codes('warning')).toContain(code);
    for (const c of r.checks.filter((x) => x.code !== 'undersize' && x.code !== 'oversize')) {
      expect(c.line).not.toBeNull();
      expect(c.time).not.toBeNull();
    }
  });
});

describe('missing input', () => {
  it('shows unknowns as warnings and never guesses them', () => {
    const input: SimInput = {
      program: DEMO_PROGRAM,
      stock: { diameter: null, length: null, stickOut: null, faceZ: null },
      material: null,
      tools: [],
      machine: { name: 'X', travelX: null, travelZ: null, maxRpm: null, rapidRate: null },
      drawing: null,
    };
    const r = runSimulation(input);
    expect(r.unknowns).toEqual(expect.arrayContaining(['Bar diameter', 'Material', 'Rapid rate']));
    const codes = r.checks.map((c) => c.code);
    expect(codes).toContain('tool-unknown');
    expect(codes).toContain('travel-unknown');
    expect(r.realTimePartial).toBe(true);
  });
});

describe('proven program O0003 for 3227C07701 (BOSS-SUCTION PIPE)', () => {
  const text = readFileSync('../samples/programs/O0003_3227C07701_FULL', 'ascii');
  const base: SimInput = {
    program: text,
    stock: { diameter: 40, length: null, stickOut: null, faceZ: null },
    material: 'EN3A / EN3B',
    tools: [],
    machine: { name: 'LMW Lathe 1', travelX: null, travelZ: null, maxRpm: 3000, rapidRate: null },
    drawing: null,
  };

  it('splits the file into its operations at M30', () => {
    expect(listSections(text).map((s) => s.label)).toEqual([
      '1ST OPN',
      '2ND OPRN',
      '12 MM CCMT',
      'Operation 4',
      '16.5 DRILL',
    ]);
  });

  it('runs every operation with no errors, naming tools from the program comments', () => {
    const r = listSections(text).map((s) => runSimulation({ ...base, section: s.index }));
    for (const x of r) expect(x.checks.filter((c) => c.severity === 'error')).toEqual([]);
    expect(r[1].ops.map((o) => o.op)).toEqual(['Drill', 'Drill', 'Face', 'Bore', 'Groove']);
    expect(r[0].checks.map((c) => c.message)).toContain(
      'M99 P4 jump is not followed: every block of this operation is shown.',
    );
    // The 16.5 drill makes its hole: material at the centre is gone down to Z-36 in op 2.
    const g = r[1].grid;
    expect(r[1].final.inner[Math.floor((-20 - g.zMin) / g.res)]).toBeGreaterThanOrEqual(8.25 - 1e-3);
  });
});
