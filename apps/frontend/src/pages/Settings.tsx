import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Download as InstallIcon, LogOut } from "lucide-react";
import { api } from "../api/client";
import { Field, ProgressBar, Segmented } from "../components/ui/primitives";
import { useAuth } from "../context/AuthContext";
import { useTheme, type ThemeMode } from "../context/ThemeContext";
import { useToast } from "../context/ToastContext";
import { formatBytes, pluralize } from "../lib/format";
import { useUsage } from "../lib/queries";

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

const SHORTCUTS: [string, string][] = [
  ["/", "Search"],
  ["U", "Upload files"],
  ["← →", "Previous / next in viewer"],
  ["F", "Favorite (in viewer)"],
  ["I", "Toggle details (in viewer)"],
  ["Shift + click", "Select a range"],
  ["Esc", "Close / clear selection"],
];

export function SettingsPage() {
  const { user, setUser, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const toast = useToast();
  const { data: usage } = useUsage();
  const [name, setName] = useState(user?.displayName ?? "");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [installEvt, setInstallEvt] = useState<InstallEvent | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", on);
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);

  const saveProfile = useMutation({
    mutationFn: () => api.updateMe(name.trim()),
    onSuccess: (p) => {
      setUser(p);
      toast.success("Profile saved");
    },
    onError: (e) => toast.error(e),
  });
  const changePw = useMutation({
    mutationFn: () => api.changePassword(cur, next),
    onSuccess: () => {
      setCur("");
      setNext("");
      toast.success("Password updated");
    },
    onError: (e) => toast.error(e),
  });

  const pct =
    usage && usage.quotaBytes ? usage.usedBytes / usage.quotaBytes : 0;
  return (
    <div className="page narrow">
      <header className="page-head">
        <div className="page-title">
          <h1>Settings</h1>
        </div>
      </header>

      <section className="panel">
        <h2>Profile</h2>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            saveProfile.mutate();
          }}
        >
          <Field label="Email">
            <input className="input" value={user?.email ?? ""} disabled />
          </Field>
          <Field label="Display name">
            <input
              className="input"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div>
            <button
              className="btn btn-primary"
              disabled={
                saveProfile.isPending ||
                name.trim() === (user?.displayName ?? "")
              }
            >
              Save
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Storage</h2>
        {usage ? (
          <>
            <div className="usage-head">
              <strong className="display">
                {formatBytes(usage.usedBytes)}
              </strong>
              <span className="muted">
                of {formatBytes(usage.quotaBytes)} used
              </span>
            </div>
            <ProgressBar value={pct} tone={pct > 0.9 ? "bad" : "accent"} />
            <dl className="facts two">
              <div>
                <dt>Photos</dt>
                <dd>
                  {pluralize(usage.counts.images, "file")} ·{" "}
                  {formatBytes(usage.breakdown.imageBytes)}
                </dd>
              </div>
              <div>
                <dt>Videos</dt>
                <dd>
                  {pluralize(usage.counts.videos, "file")} ·{" "}
                  {formatBytes(usage.breakdown.videoBytes)}
                </dd>
              </div>
              <div>
                <dt>In trash</dt>
                <dd>
                  {pluralize(usage.counts.trashed, "file")} ·{" "}
                  {formatBytes(usage.trashBytes)}
                </dd>
              </div>
            </dl>
            <p className="muted small">
              Only your original uploads count toward the limit. Generated
              thumbnails and renditions are free. Trash counts until it’s
              emptied.
            </p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="panel">
        <h2>Appearance</h2>
        <Segmented<ThemeMode>
          label="Theme"
          value={mode}
          onChange={setMode}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </section>

      <section className="panel">
        <h2>Password</h2>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            changePw.mutate();
          }}
        >
          <Field label="Current password">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={cur}
              onChange={(e) => setCur(e.target.value)}
              required
            />
          </Field>
          <Field label="New password" hint="At least 8 characters">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={72}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </Field>
          <div>
            <button className="btn" disabled={changePw.isPending}>
              Change password
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>App</h2>
        {installEvt ? (
          <button className="btn" onClick={() => void installEvt.prompt()}>
            <InstallIcon size={16} />
            Install on this device
          </button>
        ) : (
          <p className="muted small">
            On iOS, use Share → Add to Home Screen. On Android and desktop
            Chrome an install button appears here when available.
          </p>
        )}
        <h3 className="section-title">Keyboard shortcuts</h3>
        <dl className="facts two">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      <button className="btn btn-block only-mobile" onClick={logout}>
        <LogOut size={16} />
        Sign out
      </button>
    </div>
  );
}
