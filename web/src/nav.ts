import type { Role } from './api/types';

export interface NavItem {
  to: string;
  label: string;
  roles?: Role[]; // undefined = any logged-in user
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Home' },
  { to: '/machines', label: 'Machines' },
  { to: '/users', label: 'Users', roles: ['admin'] },
  { to: '/logs', label: 'Audit log', roles: ['admin'] },
];
