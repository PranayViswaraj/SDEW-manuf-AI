import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { NAV } from '../nav';
import HealthBadge from './HealthBadge';

export default function Layout() {
  const { user, logout, hasRole } = useAuth();
  const items = NAV.filter((n) => !n.roles || hasRole(...n.roles));
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-6">
          <span className="text-lg font-bold">ManufAI</span>
          <nav className="flex flex-wrap gap-4 text-sm">
            {items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  isActive ? 'font-semibold text-blue-700' : 'text-gray-600 hover:text-gray-900'
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <HealthBadge />
          {user && (
            <>
              <span className="text-gray-700">
                {user.username} <span className="text-gray-500">({user.roles.join(', ') || 'no roles'})</span>
              </span>
              <button className="btn" onClick={logout}>
                Log out
              </button>
            </>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4">
        <Outlet />
      </main>
    </div>
  );
}
