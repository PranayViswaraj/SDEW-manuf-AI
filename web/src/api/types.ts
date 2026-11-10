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

export interface Material {
  id: number;
  grade: string;
  bar_diameter: number;
  available_length: number | null;
  stock_quantity: number | null;
  quantity_unit: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export type MaterialField = 'grade' | 'bar_diameter' | 'available_length' | 'stock_quantity' | 'notes';

export interface ImportPreview {
  headers: string[];
  sample_rows: string[][];
  row_count: number;
  suggested_mapping: Record<MaterialField, string | null>;
  target_fields: MaterialField[];
}

export interface ImportReport {
  dry_run: boolean;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  rows: { row_number: number; status: string; message: string }[];
}

export type LiveState = 'online' | 'machine_unreachable' | 'stale' | 'offline';

export interface MachineStatusData {
  mode: string;
  run_state: 'idle' | 'running' | 'feed_hold' | 'stopped';
  alarm: boolean;
  alarms: { code: number; message: string }[];
  emergency: boolean;
  program_number: number | null;
  sequence_number: number | null;
  spindle_speed: number | null;
  feed_override: number | null;
  part_count: number | null;
  timestamp: string;
}

export interface LiveStatus {
  machine_id: number;
  state: LiveState;
  bridge_id: string | null;
  bridge_connected: boolean;
  machine_connected: boolean;
  driver: string | null;
  age_s: number | null;
  received_at: string | null;
  status: MachineStatusData | null;
  loaded_program: number | null;
  error: string | null;
  remote_control_enabled: boolean;
  stale_after_s: number;
}

export interface BridgeInfo {
  id: number;
  name: string;
  created_at: string;
  connected: boolean;
  connected_at: string | null;
  bridge_version: string | null;
  reported_machines: { id: string; driver: string }[];
  assigned_machines: string[];
}

export const oNumber = (n: number | null | undefined): string => (n ? `O${String(n).padStart(4, '0')}` : '–');

export type ProgramStatus = 'draft' | 'approved' | 'rejected' | 'retired';

export interface ProgramSummary {
  id: number;
  machine_id: number;
  machine_name: string;
  part_number: string;
  program_number: number;
  name: string;
  title: string;
  version: number;
  is_latest: boolean;
  sha256: string;
  status: ProgramStatus;
  source: string;
  source_note: string;
  approved_by_name: string | null;
  approved_at: string | null;
  proven: boolean;
  created_at: string;
  error_count: number;
  warning_count: number;
}

export interface Issue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number | null;
}

export interface ProgramDetail extends ProgramSummary {
  text: string;
  lines: string[];
  approved_hash: string | null;
  status_note: string;
  proven_note: string;
  validation: { ok: boolean; errors: Issue[]; warnings: Issue[]; infos: Issue[] };
  versions: { id: number; version: number; status: ProgramStatus; sha256: string; created_at: string }[];
  sendable_problem: string | null;
}
