import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setUnauthorizedHandler, tokenStore } from '../api/client';
import type { Profile, User } from '../api/types';

interface AuthState {
  user: (User & Partial<Pick<Profile, 'storageQuotaBytes'>>) | null;
  loading: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => void;
  setUser: (u: User) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<AuthState['user']>(null);
  const [loading, setLoading] = useState(() => Boolean(tokenStore.get()));

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    qc.clear(); // never let the next person on this device see cached library data
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  // Restore the session. /me also refreshes the role, which can change server-side.
  useEffect(() => {
    if (!tokenStore.get()) return;
    api.me().then(setUser).catch(() => { /* 401 -> handler logs out; network error -> stay signed out this load */ }).finally(() => setLoading(false));
  }, []);

  const finish = useCallback((res: { user: User; accessToken: string }) => {
    tokenStore.set(res.accessToken);
    qc.clear();
    setUser(res.user);
  }, [qc]);

  const value = useMemo<AuthState>(() => ({
    user, loading, isAdmin: user?.role === 'ADMIN',
    login: async (email, password) => finish(await api.login(email, password)),
    register: async (email, password, name) => finish(await api.register(email, password, name)),
    logout,
    setUser,
  }), [user, loading, logout, finish]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
