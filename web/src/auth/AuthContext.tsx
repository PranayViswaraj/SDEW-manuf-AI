import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, onUnauthorized, setToken } from '../api/client';
import type { Role, TokenResponse, User } from '../api/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(() => getToken() !== null);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => onUnauthorized(logout), [logout]);

  useEffect(() => {
    if (!getToken()) return;
    api
      .get<User>('/auth/me')
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post<TokenResponse>('/auth/login', { username, password });
    setToken(res.access_token);
    setUser(res.user);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login,
      logout,
      hasRole: (...roles) => !!user && roles.some((r) => user.roles.includes(r)),
    }),
    [user, loading, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
