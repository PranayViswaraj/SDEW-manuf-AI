import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Role } from './api/types';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import Bridges from './pages/Bridges';
import Home from './pages/Home';
import Login from './pages/Login';
import Logs from './pages/Logs';
import MachineDetail from './pages/MachineDetail';
import Machines from './pages/Machines';
import Materials from './pages/Materials';
import PartDetail from './pages/PartDetail';
import Parts from './pages/Parts';
import ProgramDetail from './pages/ProgramDetail';
import Programs from './pages/Programs';
import Run from './pages/Run';
import RunDetail from './pages/RunDetail';
import Users from './pages/Users';

function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { user, loading, hasRole } = useAuth();
  if (loading)
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-slate-50"
        role="status"
        aria-label="Loading"
      >
        <span className="h-10 w-10 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
      </div>
    );
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
        <Route path="/machines" element={<Machines />} />
        <Route path="/machines/:id" element={<MachineDetail />} />
        <Route path="/materials" element={<Materials />} />
        <Route path="/programs" element={<Programs />} />
        <Route path="/programs/:id" element={<ProgramDetail />} />
        <Route path="/run" element={<Run />} />
        <Route path="/parts" element={<Parts />} />
        <Route path="/parts/:id" element={<PartDetail />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route
          path="/users"
          element={
            <RequireAuth roles={['admin']}>
              <Users />
            </RequireAuth>
          }
        />
        <Route
          path="/bridges"
          element={
            <RequireAuth roles={['admin']}>
              <Bridges />
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
