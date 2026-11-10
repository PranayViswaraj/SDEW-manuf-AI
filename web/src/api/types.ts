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
