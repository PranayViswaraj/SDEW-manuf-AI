/**
 * Tool shapes for <cnc-simulator>. Edit freely.
 *
 * Each entry is the tool in a turret station (T0404 -> 4). `byOperation` gives a different shape
 * for an operation named in the program comment, for a station used for two jobs (T05 bores in
 * "12 MM CCMT" but turns the OD in "OD FIN").
 *
 * Shapes use the lathe simulation's tool model: role, ISO insert shape, size, nose radius, FANUC
 * tip direction (3 = OD turning, 2 = boring, 8 = grooving from above, 0 = on centre), lead angle.
 */
import type { SimTool } from '../sim/lathe/types';

/** A resolved tool: `axial` = face-groove blade that cuts along Z (its X word is the outer edge). */
export type CncTool = SimTool & { axial?: boolean; assumed?: boolean; insertNamed?: boolean };

type ToolDef = Omit<CncTool, 'number'> & { byOperation?: Record<string, Partial<CncTool>> };

const base = {
  shape: null,
  insertSize: null,
  noseRadius: null,
  tipDirection: null,
  holder: null,
  leadAngle: null,
  spindle: null,
} as const;

export const TOOLS: Record<number, ToolDef> = {
  1: {
    ...base,
    name: 'Centre drill',
    role: 'drill',
    drillDiameter: 5,
    tipDirection: 0,
    holder: 'centre drill holder',
  },
  2: {
    ...base,
    name: 'Drill Ø16.5 (118°)',
    role: 'drill',
    drillDiameter: 16.5,
    tipDirection: 0,
    holder: 'drill sleeve',
  },
  4: {
    ...base,
    name: 'CNMG 80° R0.8',
    role: 'od',
    shape: 'C',
    insertSize: 12,
    noseRadius: 0.8,
    tipDirection: 3,
    leadAngle: 95,
    holder: 'PCLNR 2525M12',
  },
  5: {
    ...base,
    name: 'CCMT 80° R0.4',
    role: 'od',
    shape: 'C',
    insertSize: 9,
    noseRadius: 0.4,
    tipDirection: 3,
    leadAngle: 95,
    holder: 'SCLCR 2020K09',
    byOperation: {
      '12 MM CCMT': {
        name: 'CCMT 80° R0.4 boring',
        role: 'bore',
        tipDirection: 2,
        insertSize: 6,
        barDiameter: 12,
      },
    },
  },
  7: {
    ...base,
    name: 'Boring bar 12 mm',
    role: 'bore',
    shape: 'C',
    insertSize: 6,
    noseRadius: 0.4,
    tipDirection: 2,
    leadAngle: 95,
    holder: 'S12M-SCLCR06',
    barDiameter: 12,
  },
  8: {
    ...base,
    name: 'Face groove 3 mm',
    role: 'groove',
    axial: true,
    width: 3,
    refEdge: 'right',
    tipDirection: 8,
    holder: 'face groove holder',
  },
};

/** Stations whose table tool is a face-groove blade (cuts along Z). */
export const AXIAL_GROOVE_TOOLS = new Set(
  Object.entries(TOOLS)
    .filter(([, t]) => t.axial)
    .map(([n]) => Number(n)),
);

let unknownDrill = 16;
/** Size for a drill whose comment gives none ("U DRILL"): set per program from its bores. */
export function setUnknownDrill(d: number) {
  if (d > 0 && Number.isFinite(d)) {
    if (d !== unknownDrill) cache.clear();
    unknownDrill = d;
  }
}
export function getUnknownDrill() {
  return unknownDrill;
}

const NUM = /(\d+(?:\.\d+)?)/;

/**
 * The tool an operation comment describes ("32.0 UDRILL", "WNMG 0.8 RG", "3MM PARTING",
 * "BORE FIN 12MM CCMT", "ID CSK", "STOPER"), with typical shop dimensions where the comment
 * says nothing. null when the comment does not say what the tool is.
 */
export function toolFromLabel(n: number, opLabel: string): CncTool | null {
  const t = opLabel.trim().toUpperCase();
  if (!t || t === 'PROGRAM') return null;
  const size = t.match(NUM);
  const insert = t.match(/\b([CDTVWS])[NC]?M?[GT]\b|\b([CDTVWS])NMG|\b([CDTVWS])CMT/);
  const letter = (insert?.[1] ?? insert?.[2] ?? insert?.[3] ?? null) as SimTool['shape'];
  const nose = t.match(/\b0?\.(4|8|2)\b/);
  const common = {
    ...base,
    number: n,
    name: opLabel.trim(),
    assumed: true,
    roleSource: 'program comment' as const,
    insertNamed: !!letter,
  };
  if (/STOP/.test(t)) return { ...common, role: 'stopper' };
  if (/CENT(ER|RE)|SPOT/.test(t) && !/DRILL\s*\d/.test(t))
    return { ...common, role: 'drill', drillDiameter: 5, tipDirection: 0 };
  if (/DRILL|\bU\s?D\b/.test(t))
    return {
      ...common,
      role: 'drill',
      drillDiameter: size ? Number(size[1]) : unknownDrill,
      tipDirection: 0,
    };
  if (/PART|GROOV|CUT\s?OFF/.test(t)) {
    const w = t.match(/(\d+(?:\.\d+)?)\s*MM/);
    return {
      ...common,
      role: /PART|CUT/.test(t) ? 'part' : 'groove',
      width: w ? Number(w[1]) : 3,
      refEdge: 'right',
      tipDirection: 8,
    };
  }
  if (/THREAD/.test(t)) return { ...common, role: 'thread', threadAngle: 60, tipDirection: 3 };
  if (/\bBB\b|BOR|\bID\b|CSK/.test(t)) {
    const bar = t.match(/(\d+(?:\.\d+)?)\s*MM/);
    return {
      ...common,
      role: 'bore',
      shape: letter ?? 'C',
      insertSize: letter === 'W' || letter === 'T' ? 8 : 6,
      noseRadius: nose ? Number(`0.${nose[1]}`) : 0.4,
      tipDirection: 2,
      leadAngle: 95,
      barDiameter: bar ? Number(bar[1]) : 12,
    };
  }
  if (/FAC|\bOD\b|\bRG\b|ROUGH|FIN|TURN|M[GN]G|\bCCMT\b/.test(t) || letter) {
    const rough = /\bRG\b|ROUGH/.test(t);
    return {
      ...common,
      role: 'od',
      shape: letter ?? 'C',
      insertSize: letter === 'T' ? 16 : letter === 'W' ? 8 : 12,
      noseRadius: nose ? Number(`0.${nose[1]}`) : rough ? 0.8 : 0.4,
      tipDirection: 3,
      leadAngle: letter === 'T' || letter === 'D' || letter === 'V' ? 93 : 95,
    };
  }
  return null;
}

const sameKind = (a: CncTool, b: CncTool) => {
  const ra = a.role === 'part' ? 'groove' : a.role;
  const rb = b.role === 'part' ? 'groove' : b.role;
  if (ra !== rb) return false;
  // the comment names a different insert ("WNMG" on a CCMT station)
  if (b.insertNamed && a.shape && b.shape && a.shape !== b.shape) return false;
  if (
    ra === 'drill' &&
    a.drillDiameter &&
    b.drillDiameter &&
    Math.abs(a.drillDiameter - b.drillDiameter) > 0.5
  )
    return false;
  return true;
};

const cache = new Map<string, CncTool | undefined>();

/**
 * The tool in station n for an operation (label from the N-block comment). The station table is
 * used when it agrees with the comment; when the comment names a different tool (another
 * machine's turret layout) the comment wins, with typical sizes.
 */
export function toolFor(n: number, opLabel: string): CncTool | undefined {
  const key = `${n}|${opLabel}`;
  if (cache.has(key)) return cache.get(key);
  const label = opLabel.trim().toUpperCase();
  const t = TOOLS[n];
  let out: CncTool | undefined;
  const over = t?.byOperation?.[label] ?? t?.byOperation?.[opLabel.trim()];
  const guess = toolFromLabel(n, opLabel);
  if (t) {
    const table: CncTool = { ...t, ...over, number: n };
    delete (table as ToolDef).byOperation;
    out = over || !guess || sameKind(table, guess) ? table : guess;
  } else out = guess ?? undefined;
  cache.set(key, out);
  return out;
}

/** Face-groove blade (cuts along Z) for this station and operation? */
export function isAxial(n: number, opLabel: string) {
  return !!toolFor(n, opLabel)?.axial;
}
