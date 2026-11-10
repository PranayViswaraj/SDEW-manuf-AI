import { motion } from 'framer-motion';
import { Factory, Loader2, LogIn, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const POINTS = [
  'Engineer confirms every drawing value',
  'Programmer approves every program',
  'Operator ticks the safety checklist before Start',
  'Every action is written to the audit log',
];

export default function Login() {
  const { user, login } = useAuth();
  const [username, setUsername] = useState('');
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
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Username</span>
            <input
              className="input mt-1.5"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Password</span>
            <input
              className="input mt-1.5"
              type="password"
              autoComplete="current-password"
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
