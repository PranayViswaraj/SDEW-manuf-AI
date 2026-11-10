import type { Role } from './api/types';

export interface NavItem {
  to: string;
  label: string;
  roles?: Role[]; // undefined = any logged-in user
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Home' },
  { to: '/machines', label: 'Machines' },
  { to: '/materials', label: 'Materials' },
  { to: '/run', label: 'Run' },
  { to: '/parts', label: 'Parts' },
  { to: '/programs', label: 'Programs' },
  { to: '/users', label: 'Users', roles: ['admin'] },
  { to: '/bridges', label: 'Bridges', roles: ['admin'] },
  { to: '/logs', label: 'Audit log', roles: ['admin'] },
];
