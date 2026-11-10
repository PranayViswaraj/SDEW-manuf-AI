export type Role = 'admin' | 'engineer' | 'programmer' | 'operator';
export const ALL_ROLES: Role[] = ['admin', 'engineer', 'programmer', 'operator'];

export interface User {
  id: number;
  username: string;
  full_name: string;
  is_active: boolean;
  can_start_machine: boolean;
  roles: Role[];
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  user_id: number | null;
  username: string | null;
  machine_id: number | null;
  program_id: number | null;
  program_hash: string | null;
  action: string;
  payload: Record<string, unknown>;
  result: string;
  error: string | null;
}

export interface AuditPage {
  total: number;
  items: AuditEntry[];
}

export type MachineState = 'in_service' | 'maintenance' | 'retired';
export type ToolType =
  'od_rough' | 'od_finish' | 'bore' | 'drill' | 'groove' | 'thread' | 'stopper' | 'parting' | 'other';
export const TOOL_TYPES: { value: ToolType; label: string }[] = [
  { value: 'od_rough', label: 'OD rough' },
  { value: 'od_finish', label: 'OD finish' },
  { value: 'bore', label: 'Bore' },
  { value: 'drill', label: 'Drill' },
  { value: 'groove', label: 'Groove' },
  { value: 'thread', label: 'Thread' },
  { value: 'stopper', label: 'Stopper' },
  { value: 'parting', label: 'Parting' },
  { value: 'other', label: 'Other' },
];

export interface MachineLimits {
  max_turning_diameter: number | null;
  max_turning_length: number | null;
  max_bar_diameter: number | null;
  spindle_rpm_min: number | null;
  spindle_rpm_max: number | null;
  chuck_size: string | null;
  turret_stations: number | null;
}

export const LIMIT_FIELDS: {
  key: keyof MachineLimits;
  label: string;
  unit: string;
  kind: 'num' | 'int' | 'text';
}[] = [
  { key: 'max_turning_diameter', label: 'Max turning diameter', unit: 'mm', kind: 'num' },
  { key: 'max_turning_length', label: 'Max turning length', unit: 'mm', kind: 'num' },
  { key: 'max_bar_diameter', label: 'Max bar diameter', unit: 'mm', kind: 'num' },
  { key: 'spindle_rpm_min', label: 'Spindle speed min', unit: 'rpm', kind: 'int' },
  { key: 'spindle_rpm_max', label: 'Spindle speed max', unit: 'rpm', kind: 'int' },
  { key: 'chuck_size', label: 'Chuck size', unit: '', kind: 'text' },
  { key: 'turret_stations', label: 'Turret stations', unit: '', kind: 'int' },
];

export interface Tool {
  id: number;
  machine_id: number;
  station: number;
  tool_code: string;
  description: string;
  insert_type: string;
  nose_radius: number | null;
  tool_type: ToolType;
}

export interface Machine {
  id: number;
  key: string;
  name: string;
  make: string;
  model: string;
  controller: string;
  ip_address: string | null;
  focas_port: number;
  status: MachineState;
  bridge_id: string | null;
  remote_control_enabled: boolean;
  limits: MachineLimits;
  notes: string;
  created_at: string;
  updated_at: string;
  tools: Tool[];
  limits_missing: (keyof MachineLimits)[];
}
