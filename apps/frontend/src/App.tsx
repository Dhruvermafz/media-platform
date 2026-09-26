import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { PageSpinner } from "./components/ui/primitives";
import { useAuth } from "./context/AuthContext";
import { RealtimeProvider } from "./context/RealtimeContext";
import { UploadProvider } from "./context/UploadContext";
import { ActivityPage } from "./pages/Activity";
import { AdminPage } from "./pages/Admin";
import { AuthPage } from "./pages/Auth";
import { CollectionsPage } from "./pages/Collections";
import { LibraryPage } from "./pages/Library";
import { ProcessingPage } from "./pages/Processing";
import { PublicSharePage } from "./pages/PublicShare";
import { SettingsPage } from "./pages/Settings";
import { SharesPage } from "./pages/Shares";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageSpinner />;
  if (!user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  return (
    <RealtimeProvider>
      <UploadProvider>{children}</UploadProvider>
    </RealtimeProvider>
  );
}

// Old deep links (/assets/:id from the previous UI) keep working.
const LegacyAsset = () => (
  <Navigate to={`/library?asset=${useParams().id}`} replace />
);

export function App() {
  return (
    <Routes>
      <Route path="/s/:token" element={<PublicSharePage />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/library" element={<LibraryPage mode="library" />} />
        <Route path="/favorites" element={<LibraryPage mode="favorites" />} />
        <Route path="/trash" element={<LibraryPage mode="trash" />} />
        <Route path="/collections" element={<CollectionsPage />} />
        <Route
          path="/collections/:id"
          element={<LibraryPage mode="collection" />}
        />
        <Route path="/tags/:name" element={<LibraryPage mode="tag" />} />
        <Route path="/shares" element={<SharesPage />} />
        <Route path="/processing" element={<ProcessingPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/assets/:id" element={<LegacyAsset />} />
        <Route path="/assets" element={<Navigate to="/library" replace />} />
      </Route>
      <Route path="/" element={<Navigate to="/library" replace />} />
      <Route
        path="*"
        element={
          <div className="public-center">
            <h1>Page not found</h1>
            <a className="btn" href="/library">
              Go to library
            </a>
          </div>
        }
      />
    </Routes>
  );
}
