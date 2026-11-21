import type { LucideIcon } from 'lucide-react';
import {
  Box,
  Boxes,
  Cpu,
  FileCode2,
  LayoutDashboard,
  Play,
  Radio,
  Ruler,
  ScrollText,
  Users,
  Wand2,
} from 'lucide-react';
import type { Role } from './api/types';

export type NavSection = 'Overview' | 'Production' | 'Engineering' | 'Admin';

export interface NavItem {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
  section: NavSection;
  roles?: Role[]; // undefined = any logged-in user
}

export const NAV: NavItem[] = [
  {
    to: '/',
    label: 'Home',
    description: 'Overview, live machines and your next steps',
    icon: LayoutDashboard,
    section: 'Overview',
  },
  {
    to: '/run',
    label: 'Run',
    description: 'Run a part: checklist, send, start, first piece',
    icon: Play,
    section: 'Production',
  },
  {
    to: '/machines',
    label: 'Machines',
    description: 'Machine register, limits, tools and live status',
    icon: Cpu,
    section: 'Production',
  },
  {
    to: '/make',
    label: 'Drawing to program',
    description: 'Upload a drawing, enter its values, generate and send the program',
    icon: Wand2,
    section: 'Engineering',
  },
  {
    to: '/parts',
    label: 'Parts',
    description: 'Feature tables an engineer confirms',
    icon: Ruler,
    section: 'Engineering',
  },
  {
    to: '/programs',
    label: 'Programs',
    description: 'CNC programs, checks, tool path and approval',
    icon: FileCode2,
    section: 'Engineering',
  },
  {
    to: '/simulate',
    label: 'Lathe simulation',
    description: '3D lathe simulation demo on the SIM Lathe',
    icon: Box,
    section: 'Engineering',
  },
  {
    to: '/materials',
    label: 'Materials',
    description: 'Raw material register and import',
    icon: Boxes,
    section: 'Engineering',
  },
  {
    to: '/users',
    label: 'Users',
    description: 'Roles and the allowed-to-start list',
    icon: Users,
    section: 'Admin',
    roles: ['admin'],
  },
  {
    to: '/bridges',
    label: 'Bridges',
    description: 'Factory bridge PCs and their connection',
    icon: Radio,
    section: 'Admin',
    roles: ['admin'],
  },
  {
    to: '/logs',
    label: 'Audit log',
    description: 'Every action, who did it and when',
    icon: ScrollText,
    section: 'Admin',
    roles: ['admin'],
  },
];

export const SECTIONS: NavSection[] = ['Overview', 'Production', 'Engineering', 'Admin'];
