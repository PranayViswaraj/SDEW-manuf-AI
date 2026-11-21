/**
 * Build the simulation input from what the app already knows (machine, tool list, feature table,
 * generator setup). Only real values are passed on; anything missing stays null ("unknown").
 */

import type { Machine, Tool } from '../../api/types';
import { defaultTip, parseHolderCode, parseInsertCode } from './tools';
import type { DrawingProfile, SimInput, SimTool, ToolRole } from './types';

const ROLE: Record<string, ToolRole> = {
  od_rough: 'od',
  od_finish: 'od',
  bore: 'bore',
  drill: 'drill',
  groove: 'groove',
  thread: 'thread',
  stopper: 'stopper',
  parting: 'part',
  other: 'unknown',
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Generator setup values per operation, e.g. setup.part.width = "3". */
export type GenSetup = Record<string, Record<string, string>>;

export function simToolFromApp(t: Tool, setup: GenSetup = {}): SimTool {
  const digits = t.tool_code.replace(/\D/g, '');
  const number = digits.length >= 3 ? Number(digits.slice(0, -2)) : Number(digits);
  const role = ROLE[t.tool_type] ?? 'unknown';
  const insert = parseInsertCode(t.insert_type) ?? parseInsertCode(t.description);
  const holder = parseHolderCode(t.description) ?? parseHolderCode(t.insert_type);
  const text = `${t.description} ${t.insert_type}`.toUpperCase();
  const mm = text.match(/(\d+(?:\.\d+)?)\s*MM/);
  const lead = text.match(/(\d+(?:\.\d+)?)/);
  const op = role === 'part' ? setup.part : role === 'groove' ? setup.groove : undefined;
  const edge = op?.ref_edge;
  const tip = defaultTip(role);
  return {
    number,
    name: t.description || t.tool_code,
    role,
    roleSource: 'tool list',
    shape: insert?.shape ?? holder?.shape ?? null,
    insertSize: insert?.size ?? null,
    noseRadius: t.nose_radius ?? insert?.nose ?? null,
    tipDirection: tip,
    tipSource: 'tool type',
    holder: holder ? t.description : null,
    leadAngle: holder?.lead ?? null,
    barDiameter: holder?.bar ?? null,
    minBore: null,
    width: role === 'part' || role === 'groove' ? (num(op?.width) ?? (mm ? Number(mm[1]) : null)) : null,
    refEdge: edge === 'left' || edge === 'right' ? edge : null,
    threadAngle: role === 'thread' && /ISO|\b60\b|UN\b/.test(text) ? 60 : null,
    drillDiameter: role === 'drill' ? (mm ? Number(mm[1]) : lead ? Number(lead[1]) : null) : null,
    spindle: null,
  };
}

export function simInputFromApp(opts: {
  program: string;
  machine: Machine;
  barDiameter: number | null;
  material: string | null;
  setup?: GenSetup;
  drawing?: DrawingProfile | null;
}): SimInput {
  const { machine, setup = {} } = opts;
  const chuck = num((machine.limits.chuck_size ?? '').toString().replace(/[^\d.]/g, ''));
  const faceStock = num(setup.rough?.face_stock);
  return {
    program: opts.program,
    stock: { diameter: opts.barDiameter, length: null, stickOut: null, faceZ: faceStock },
    material: opts.material,
    tools: machine.tools.map((t) => simToolFromApp(t, setup)),
    machine: {
      name: machine.name,
      travelX: null,
      travelZ: null,
      maxRpm: machine.limits.spindle_rpm_max ?? null,
      rapidRate: null,
      indexTime: null,
      home: null,
      chuckDiameter: chuck,
      turretStations: machine.limits.turret_stations ?? null,
    },
    drawing: opts.drawing ?? null,
  };
}
