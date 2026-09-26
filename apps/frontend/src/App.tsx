import { Navigate, Route, Routes, Link, useLocation } from 'react-router-dom';
import { ReactNode } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginPage } from './pages/Login';
import { RegisterPage } from './pages/Register';
import { AssetsPage } from './pages/Assets';
import { AssetDetailPage } from './pages/AssetDetail';
import { AdminPage } from './pages/Admin';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Media Platform</h1>
        <nav>
          <Link to="/assets">Assets</Link>
          <Link to="/admin">Operations</Link>
        </nav>
        {user && (
          <div style={{ marginTop: 32 }}>
            <div className="muted">{user.email}</div>
            <button className="secondary" style={{ marginTop: 8 }} onClick={logout}>Log out</button>
          </div>
        )}
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/assets"
          element={
            <RequireAuth>
              <Shell><AssetsPage /></Shell>
            </RequireAuth>
          }
        />
        <Route
          path="/assets/:id"
          element={
            <RequireAuth>
              <Shell><AssetDetailPage /></Shell>
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <Shell><AdminPage /></Shell>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/assets" replace />} />
      </Routes>
    </AuthProvider>
  );
}
