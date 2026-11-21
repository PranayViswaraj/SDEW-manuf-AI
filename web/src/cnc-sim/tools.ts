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

type ToolDef = Omit<SimTool, 'number'> & { byOperation?: Record<string, Partial<SimTool>> };

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
    width: 3,
    refEdge: 'right',
    tipDirection: 8,
    holder: 'face groove holder',
  },
};

/** The face-groove tool cuts along Z (axial), its X word is the blade's outer edge. */
export const AXIAL_GROOVE_TOOLS = new Set([8]);

/** The tool shape for a station in an operation (label from the N-block comment). */
export function toolFor(n: number, opLabel: string): SimTool | undefined {
  const t = TOOLS[n];
  if (!t) return undefined;
  const { byOperation, ...rest } = t;
  const over = byOperation?.[opLabel.trim().toUpperCase()] ?? byOperation?.[opLabel.trim()];
  return { ...rest, ...over, number: n };
}
