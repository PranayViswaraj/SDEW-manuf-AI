import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

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
    <div className="flex min-h-screen items-center justify-center bg-gray-100 px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 shadow">
        <h1 className="text-2xl font-bold">ManufAI</h1>
        <p className="text-sm text-gray-600">Sign in to continue.</p>
        <label className="block">
          <span className="text-sm font-medium">Username</span>
          <input
            className="input mt-1"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input
            className="input mt-1"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
            {error}
          </p>
        )}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
