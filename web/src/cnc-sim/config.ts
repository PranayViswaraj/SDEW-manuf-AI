/**
 * <cnc-simulator> settings in one place. Change values here; nothing else needs editing.
 */
import type { SimMachine } from '../sim/lathe/types';

export const SIM_CONFIG = {
  /** Bar stock. 64 long = finished 62 + 1 mm face stock on each end (O0003 faces Z1 -> Z0). */
  stock: { diameter: 42, length: 64, faceStockFront: 1, faceStockBack: 1 },
  /** Material grid cell (mm) in radius and Z. */
  gridRes: 0.05,
  /** Revolve segments of the part mesh. */
  segments: 96,
  /** Rebuild the part mesh at most this often while playing (Hz). */
  meshHz: 30,
  /** Freshly cut surfaces fade from yellow back to blue over this much simulated time (s). */
  fadeSeconds: 3,
  /** Tool change and part flip animations: real seconds, at any speed. */
  toolChangeAnim: 0.4,
  flipAnim: 0.4,
  /** "Max" speed plays the whole job in about this many seconds. */
  maxSpeedSeconds: 3,
  /** Visual spindle spin cap (rev/s). */
  spinCap: 2,
  defaultSpeed: 10,
};

/** The lathe: rapid 8000 mm/min, G28 home X200 Z150, G30 home X150 Z100 (program coordinates). */
export const SIM_MACHINE: SimMachine = {
  name: 'Lathe',
  travelX: null,
  travelZ: null,
  maxRpm: null,
  rapidRate: 8000,
  indexTime: null,
  home: { x: 200, z: 150 },
  home30: { x: 150, z: 100 },
  chuckDiameter: 160,
  turretStations: 8,
};
