import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { NAV } from '../nav';
import { Notice } from '../components/ui';

export default function Home() {
  const { user, hasRole } = useAuth();
  const links = NAV.filter((n) => n.to !== '/' && (!n.roles || hasRole(...n.roles)));
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Welcome, {user?.full_name || user?.username}</h1>
      <Notice tone="warn">
        ManufAI never replaces the machine&apos;s physical emergency stop. Always use the red E-stop on the
        machine in an emergency.
      </Notice>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((n) => (
          <Link key={n.to} to={n.to} className="rounded border bg-white p-4 hover:border-blue-400">
            <div className="font-medium">{n.label}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
