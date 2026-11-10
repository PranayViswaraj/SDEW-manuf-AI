import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Role } from './api/types';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import Home from './pages/Home';
import Login from './pages/Login';
import Logs from './pages/Logs';
import Users from './pages/Users';

function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { user, loading, hasRole } = useAuth();
  if (loading) return <p className="p-4 text-gray-600">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !hasRole(...roles)) {
    return (
      <p role="alert" className="p-4 text-red-800">
        You need the {roles.join(' or ')} role to open this page.
      </p>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Home />} />
        <Route
          path="/users"
          element={
            <RequireAuth roles={['admin']}>
              <Users />
            </RequireAuth>
          }
        />
        <Route
          path="/logs"
          element={
            <RequireAuth roles={['admin']}>
              <Logs />
            </RequireAuth>
          }
        />
        <Route path="*" element={<p className="text-gray-600">Page not found.</p>} />
      </Route>
    </Routes>
  );
}
