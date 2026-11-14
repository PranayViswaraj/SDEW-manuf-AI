import { motion } from 'framer-motion';
import {
  Factory,
  FileCode2,
  Layers,
  Loader2,
  LogIn,
  Play,
  Ruler,
  ShieldCheck,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const POINTS = [
  'Engineer confirms every drawing value',
  'Programmer approves every program',
  'Operator ticks the safety checklist before Start',
  'Every action is written to the audit log',
];

/** Sign in by choosing a role. Each role is a shared account with that username; "Other user"
 * types a personal username instead. */
const ROLES: { username: string; label: string; hint: string; icon: LucideIcon }[] = [
  { username: 'operator', label: 'Operator', hint: 'Run parts', icon: Play },
  { username: 'engineer', label: 'Engineer', hint: 'Confirm parts', icon: Ruler },
  { username: 'programmer', label: 'Programmer', hint: 'Approve programs', icon: FileCode2 },
  { username: 'admin', label: 'Admin', hint: 'Users & settings', icon: Users },
  { username: 'sample', label: 'Sample', hint: 'All four roles in one account', icon: Layers },
];
const OTHER = '';

export default function Login() {
  const { user, login } = useAuth();
  const [role, setRole] = useState<string>(ROLES[0].username); // OTHER = type a username
  const [typed, setTyped] = useState('');
  const username = role === OTHER ? typed : role;
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="hidden border-r border-slate-200 bg-white p-12 lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Factory className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="text-xl font-bold tracking-tight text-slate-900">ManufAI</span>
        </div>
        <div>
          <h2 className="text-3xl leading-tight font-bold tracking-tight text-slate-900">
            From drawing
            <br />
            to machined part.
          </h2>
          <ul className="mt-8 space-y-3">
            {POINTS.map((p) => (
              <li key={p} className="flex items-center gap-3 text-slate-700">
                <ShieldCheck className="h-5 w-5 text-slate-500" aria-hidden="true" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-slate-600">
          The machine&apos;s red emergency stop is always the emergency stop.
        </p>
      </div>

      {/* Form */}
      <div className="flex items-center justify-center bg-slate-50 px-4 py-12">
        <motion.form
          onSubmit={onSubmit}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="card w-full max-w-sm space-y-5 p-8"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight">ManufAI</h1>
            <p className="mt-1 text-sm text-slate-600">Sign in to continue.</p>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">Sign in as</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {ROLES.map((r) => {
                const on = role === r.username;
                const Icon = r.icon;
                return (
                  <label
                    key={r.username}
                    className={`${r.username === 'sample' ? 'col-span-2 ' : ''}flex cursor-pointer items-center gap-2.5 rounded-xl border-2 p-3 transition has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-200 ${
                      on ? 'border-brand-600 bg-brand-50' : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="role"
                      className="sr-only"
                      checked={on}
                      onChange={() => setRole(r.username)}
                    />
                    <Icon
                      className={`h-5 w-5 shrink-0 ${on ? 'text-brand-700' : 'text-slate-500'}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-900">{r.label}</span>
                      <span className="block text-xs text-slate-600">{r.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <label
              className={`mt-2 flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-sm has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-200 ${
                role === OTHER ? 'font-semibold text-brand-700' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <input
                type="radio"
                name="role"
                className="sr-only"
                checked={role === OTHER}
                onChange={() => setRole(OTHER)}
              />
              <UserRound className="h-4 w-4" aria-hidden="true" />
              Other user (type a username)
            </label>
          </fieldset>
          {role === OTHER && (
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Username</span>
              <input
                className="input mt-1.5"
                autoComplete="username"
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                required
              />
            </label>
          )}
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Password</span>
            <input
              className="input mt-1.5"
              type="password"
              autoComplete="current-password"
              autoFocus={role !== OTHER}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && (
            <motion.p
              role="alert"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: [0, -6, 6, -4, 4, 0] }}
              transition={{ duration: 0.4 }}
              className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-800"
            >
              {error}
            </motion.p>
          )}
          <button className="btn-primary w-full py-2.5" disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogIn className="h-4 w-4" aria-hidden="true" />
            )}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </motion.form>
      </div>
    </div>
  );
}
