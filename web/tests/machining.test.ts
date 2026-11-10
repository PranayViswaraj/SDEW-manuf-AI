import { describe, expect, it } from 'vitest';
import {
  Material,
  buildTimeline,
  classifyTool,
  positionAt,
  samplesAlong,
  stockFor,
  type SimSegment,
} from '../src/sim/machining';

describe('tool classification from the program comments', () => {
  it.each([
    ['32.0 UDRILL', 'drill', 32],
    ['23 U DRILL', 'drill', 23],
    ['26 UD', 'drill', 26],
    ['19 UD', 'drill', 19],
    ['3MM PARTING', 'groove', 3],
    ['2MM PARTING', 'groove', 2],
    ['3MM GROOVING', 'groove', 3],
    ['BORE FIN', 'internal', null],
    ['WNMG -BOREING FINESH', 'internal', null],
    ['ID CSK', 'internal', null],
    ['TNMG 0.4 FIN', 'external', null],
    ['WNMG 0.8 RG', 'external', null],
    ['STOPER', 'none', null],
  ])('%s -> %s', (label, kind, size) => {
    const t = classifyTool(label);
    expect(t.kind).toBe(kind);
    if (size !== null) expect(t.size).toBe(size);
  });
});

describe('material removal', () => {
  const fresh = () => new Material(-30, 5, 25, 1);

  it('starts as a full bar up to the facing allowance', () => {
    const m = fresh();
    expect(m.outer[m.idx(-10)]).toBe(25);
    expect(m.outer[m.idx(0.9)]).toBe(25);
    expect(m.outer[m.idx(3)]).toBe(0); // in front of the bar: air
  });

  it('external turning cuts from the tip towards the face only', () => {
    const m = fresh();
    m.cut(-20, 22, classifyTool('WNMG 0.8 RG'));
    expect(m.outer[m.idx(-10)]).toBeCloseTo(22);
    expect(m.outer[m.idx(-25)]).toBe(25); // behind the tip: untouched
  });

  it('parting only cuts its own width', () => {
    const m = fresh();
    m.cut(-20, 15, classifyTool('3MM PARTING'));
    expect(m.outer[m.idx(-21)]).toBeCloseTo(15);
    expect(m.outer[m.idx(-10)]).toBe(25);
  });

  it('a drill opens a hole of its diameter; boring opens it further', () => {
    const m = fresh();
    m.cut(-25, 0, classifyTool('32.0 UDRILL'));
    expect(m.inner[m.idx(-10)]).toBeCloseTo(16);
    m.cut(-24, 17.4, classifyTool('BORE FIN'));
    expect(m.inner[m.idx(-10)]).toBeCloseTo(17.4);
    expect(m.inner[m.idx(-27)]).toBe(0); // deeper than the drill: solid
  });

  it('an unnamed tool is guessed from where its tip is', () => {
    const unnamed = classifyTool('');
    expect(unnamed).toMatchObject({ kind: 'external', guessed: true });
    const m = fresh();
    m.cut(-25, 0, classifyTool('20 UD')); // hole r = 10
    m.cut(-20, 12, unnamed); // tip in the inner half of the wall -> boring
    expect(m.inner[m.idx(-10)]).toBeCloseTo(12);
    expect(m.outer[m.idx(-10)]).toBe(25);
    m.cut(-20, 23, unnamed); // tip in the outer half -> turning
    expect(m.outer[m.idx(-10)]).toBeCloseTo(23);
  });

  it('reports removed area and draws a closed path', () => {
    const m = fresh();
    const removed = m.cut(-10, 20, classifyTool('TNMG 0.4 FIN'));
    expect(removed).toBeGreaterThan(0);
    expect(m.cut(-10, 20, classifyTool('TNMG 0.4 FIN'))).toBe(0); // nothing left to cut there
    const d = m.toPath();
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });
});

describe('timeline', () => {
  const segs: SimSegment[] = [
    {
      block: 1,
      line: 3,
      tool: 1,
      kind: 'rapid',
      points: [
        [10, 25],
        [2, 20],
      ],
    },
    {
      block: 2,
      line: 4,
      tool: 1,
      kind: 'feed',
      points: [
        [2, 20],
        [-23, 20],
      ],
    },
  ];

  it('feed moves take longer than rapids and positions interpolate', () => {
    const tl = buildTimeline(segs);
    expect(tl.moves).toHaveLength(2);
    expect(tl.moves[1].t1 - tl.moves[1].t0).toBeGreaterThan(tl.moves[0].t1 - tl.moves[0].t0);
    const mid = positionAt(tl, (tl.moves[1].t0 + tl.moves[1].t1) / 2);
    expect(mid?.point[0]).toBeCloseTo(-10.5);
    expect(mid?.move.seg.kind).toBe('feed');
    expect(tl.blocks).toEqual([1, 2]);
  });

  it('samples a move evenly and ends exactly on the end point', () => {
    const s = samplesAlong([0, 0], [-1, 0], 0.25);
    expect(s).toHaveLength(4);
    expect(s[3]).toEqual([-1, 0]);
  });

  it('estimates stock from the cuts when no bar size is given', () => {
    const st = stockFor(segs, null);
    expect(st.estimated).toBe(true);
    expect(st.barR).toBe(21);
    expect(stockFor(segs, 50).barR).toBe(25);
  });
});
