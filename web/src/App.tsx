import { NavLink, Route, Routes } from 'react-router-dom';
import HealthBadge from './components/HealthBadge';

// Pages are filled in milestone by milestone (Login, Machines, Programs, Run, Logs, Materials).
const NAV = [
  { to: '/', label: 'Home' },
  { to: '/machines', label: 'Machines' },
  { to: '/programs', label: 'Programs' },
  { to: '/materials', label: 'Materials' },
  { to: '/logs', label: 'Logs' },
];

function Placeholder({ title }: { title: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-gray-600">Not built yet.</p>
    </div>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="flex items-center justify-between border-b bg-white px-4 py-3">
        <div className="flex items-center gap-6">
          <span className="text-lg font-bold">ManufAI</span>
          <nav className="flex gap-4 text-sm">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end
                className={({ isActive }) => (isActive ? 'font-semibold text-blue-700' : 'text-gray-600')}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <HealthBadge />
      </header>
      <main className="p-4">
        <Routes>
          <Route path="/" element={<Placeholder title="ManufAI" />} />
          <Route path="/machines" element={<Placeholder title="Machines" />} />
          <Route path="/programs" element={<Placeholder title="Programs" />} />
          <Route path="/materials" element={<Placeholder title="Materials" />} />
          <Route path="/logs" element={<Placeholder title="Logs" />} />
        </Routes>
      </main>
    </div>
  );
}
