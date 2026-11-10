import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import {
  ClipboardCheck,
  Factory,
  FilePlus2,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { NAV, SECTIONS, type NavItem } from '../nav';
import CommandPalette, { type Command } from './CommandPalette';
import HealthBadge from './HealthBadge';
import { PageTransition } from './motion';

const COLLAPSE_KEY = 'manufai.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function SidebarLinks({
  items,
  collapsed,
  onNavigate,
}: {
  items: NavItem[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <LayoutGroup id="sidebar">
      {SECTIONS.map((section) => {
        const list = items.filter((n) => n.section === section);
        if (list.length === 0) return null;
        return (
          <div key={section} className="mb-4">
            {!collapsed && (
              <div className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                {section}
              </div>
            )}
            <ul className="space-y-0.5">
              {list.map((n) => {
                const Icon = n.icon;
                return (
                  <li key={n.to}>
                    <NavLink
                      to={n.to}
                      end={n.to === '/'}
                      onClick={onNavigate}
                      title={collapsed ? n.label : undefined}
                      className={({ isActive }) =>
                        `group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                          isActive ? 'text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white'
                        } ${collapsed ? 'justify-center' : ''}`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && (
                            <motion.span
                              layoutId="nav-active"
                              className="absolute inset-0 rounded-lg bg-gradient-to-r from-brand-600 to-brand-500 shadow-lg shadow-brand-900/40"
                              transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                            />
                          )}
                          <Icon className="relative h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                          {!collapsed && <span className="relative">{n.label}</span>}
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </LayoutGroup>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 px-3 ${collapsed ? 'justify-center' : ''}`}>
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 shadow-lg shadow-brand-900/50">
        <Factory className="h-5 w-5 text-white" aria-hidden="true" />
      </span>
      {!collapsed && (
        <span className="leading-tight">
          <span className="block text-base font-bold tracking-tight text-white">ManufAI</span>
          <span className="block text-[11px] text-slate-400">Drawing to machined part</span>
        </span>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout, hasRole } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const items = useMemo(() => NAV.filter((n) => !n.roles || hasRole(...n.roles)), [hasRole]);
  const current = NAV.find((n) =>
    n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to),
  );

  const commands: Command[] = useMemo(() => {
    const pages: Command[] = items.map((n) => ({
      id: n.to,
      label: n.label,
      hint: n.description,
      to: n.to,
      icon: n.icon,
      group: 'Page',
    }));
    const actions: Command[] = [];
    if (hasRole('operator'))
      actions.push({
        id: 'a-run',
        label: 'Start a run',
        hint: 'Pick a machine and an approved program',
        to: '/run',
        icon: ClipboardCheck,
        group: 'Action',
      });
    if (hasRole('programmer'))
      actions.push({
        id: 'a-upload',
        label: 'Upload or approve a program',
        hint: 'Programs page',
        to: '/programs',
        icon: Upload,
        group: 'Action',
      });
    if (hasRole('engineer'))
      actions.push({
        id: 'a-part',
        label: 'New feature table',
        hint: 'Enter and confirm a part',
        to: '/parts',
        icon: FilePlus2,
        group: 'Action',
      });
    return [...actions, ...pages];
  }, [items, hasRole]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true); // Esc closes it
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const initials = (user?.full_name || user?.username || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-brand-600 px-4 py-2 font-medium text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 hidden flex-col bg-ink py-5 transition-[width] duration-300 lg:flex ${
          collapsed ? 'w-[76px]' : 'w-64'
        }`}
      >
        <Brand collapsed={collapsed} />
        <nav className="mt-7 flex-1 overflow-y-auto px-3" aria-label="Main">
          <SidebarLinks items={items} collapsed={collapsed} />
        </nav>
        <div className="px-3">
          <button
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-white/5 hover:text-white ${collapsed ? 'justify-center' : ''}`}
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-[18px] w-[18px]" />
            ) : (
              <PanelLeftClose className="h-[18px] w-[18px]" />
            )}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Mobile drawer: only rendered when open, so the page has one navigation landmark. */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            className="fixed inset-0 z-40 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div
              className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="absolute inset-y-0 left-0 flex w-72 flex-col bg-ink py-5"
              initial={{ x: -300 }}
              animate={{ x: 0 }}
              exit={{ x: -300 }}
              transition={{ type: 'spring', stiffness: 380, damping: 36 }}
            >
              <div className="flex items-center justify-between pr-3">
                <Brand collapsed={false} />
                <button
                  className="rounded-lg p-2 text-slate-400 hover:text-white"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close menu"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="mt-7 flex-1 overflow-y-auto px-3" aria-label="Main">
                <SidebarLinks items={items} collapsed={false} onNavigate={() => setMobileOpen(false)} />
              </nav>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`transition-[padding] duration-300 ${collapsed ? 'lg:pl-[76px]' : 'lg:pl-64'}`}>
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200/80 bg-white/80 px-4 backdrop-blur-xl sm:px-6">
          <button
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="hidden min-w-0 sm:block">
            <div className="truncate text-sm font-semibold text-slate-900">{current?.label ?? 'ManufAI'}</div>
            <div className="truncate text-xs text-slate-500">{current?.description}</div>
          </div>
          <button
            className="ml-auto flex h-10 w-full max-w-xs items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 transition hover:border-slate-300 hover:bg-white sm:w-72"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open quick search"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="flex-1 text-left">Search or jump to…</span>
            <span className="hidden items-center gap-0.5 sm:flex">
              <span className="kbd">Ctrl</span>
              <span className="kbd">K</span>
            </span>
          </button>
          <div className="hidden md:block">
            <HealthBadge />
          </div>
          {user && (
            <div className="flex items-center gap-2">
              <div className="hidden text-right leading-tight sm:block">
                <div className="text-sm font-medium text-slate-900">{user.username}</div>
                <div className="text-xs text-slate-500">({user.roles.join(', ') || 'no roles'})</div>
              </div>
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-bold text-white shadow-md shadow-brand-600/30"
                aria-hidden="true"
              >
                {initials}
              </span>
              <button className="btn px-2.5" onClick={logout} aria-label="Log out" title="Log out">
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span className="hidden xl:inline">Log out</span>
              </button>
            </div>
          )}
        </header>

        <main id="main" className="app-main mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <PageTransition id={location.pathname}>
            <Outlet />
          </PageTransition>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
}
