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
      <div className="relative hidden overflow-hidden bg-ink p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -top-32 -left-24 h-96 w-96 animate-float rounded-full bg-brand-500/30 blur-3xl" />
        <div
          className="pointer-events-none absolute right-0 bottom-0 h-96 w-96 animate-float rounded-full bg-emerald-500/20 blur-3xl"
          style={{ animationDelay: '-6s' }}
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
            backgroundSize: '44px 44px',
          }}
        />
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative flex items-center gap-3"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 shadow-lg">
            <Factory className="h-6 w-6" aria-hidden="true" />
          </span>
          <span className="text-xl font-bold tracking-tight">ManufAI</span>
        </motion.div>
        <div className="relative">
          <motion.h2
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.6 }}
            className="text-4xl leading-tight font-bold tracking-tight"
          >
            From drawing
            <br />
            to machined part.
          </motion.h2>
          <ul className="mt-8 space-y-3">
            {POINTS.map((p, i) => (
              <motion.li
                key={p}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + i * 0.1 }}
                className="flex items-center gap-3 text-slate-300"
              >
                <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                {p}
              </motion.li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-500">
          The machine&apos;s red emergency stop is always the emergency stop.
        </p>
      </div>

      {/* Form */}
      <div className="flex items-center justify-center bg-slate-50 px-4 py-12">
        <motion.form
          onSubmit={onSubmit}
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          className="card w-full max-w-sm space-y-5 p-8"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight">ManufAI</h1>
            <p className="mt-1 text-sm text-slate-500">Sign in to continue.</p>
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
