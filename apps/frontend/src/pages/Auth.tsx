import { useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { Check, LayoutGrid } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { errorMessage } from "../context/ToastContext";
import { Field, Spinner } from "../components/ui/primitives";

const STEPS = ["Thumbnail", "Viewer copy", "Optimised copy", "Metadata"];

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { user, login, register } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isLogin = mode === "login";

  if (user)
    return (
      <Navigate
        to={(location.state as { from?: string } | null)?.from ?? "/library"}
        replace
      />
    );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await (isLogin
        ? login(email, password)
        : register(email, password, name));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <aside className="auth-hero" aria-hidden>
        <div className="brand">
          <span className="brand-mark">
            <LayoutGrid size={18} />
          </span>
          <span className="brand-name">Media</span>
        </div>
        <div className="auth-copy">
          <h2>Every upload, processed while you watch.</h2>
          <p>
            Drop in photos and video. Workers build thumbnails, optimised copies
            and metadata in the background, and your library updates live.
          </p>
          <ul className="auth-steps">
            {STEPS.map((s, i) => (
              <li key={s} style={{ animationDelay: `${0.6 + i * 0.7}s` }}>
                <span>
                  <Check size={14} strokeWidth={3} />
                </span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="auth-panel">
        <form className="auth-form" onSubmit={submit}>
          <div className="brand only-mobile">
            <span className="brand-mark">
              <LayoutGrid size={18} />
            </span>
            <span className="brand-name">Media</span>
          </div>
          <h1>{isLogin ? "Welcome back" : "Create your account"}</h1>
          <p className="muted">
            {isLogin
              ? "Sign in to open your library."
              : "Start with 5 GB of free storage."}
          </p>
          {!isLogin && (
            <Field label="Name (optional)">
              <input
                className="input"
                autoComplete="name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          )}
          <Field label="Email">
            <input
              className="input"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field
            label="Password"
            hint={isLogin ? undefined : "At least 8 characters"}
          >
            <input
              className="input"
              type="password"
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
              minLength={isLogin ? undefined : 8}
              maxLength={72}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-block btn-lg" disabled={busy}>
            {busy ? <Spinner /> : isLogin ? "Sign in" : "Create account"}
          </button>
          <p className="auth-alt">
            {isLogin ? (
              <>
                New here? <Link to="/register">Create an account</Link>
              </>
            ) : (
              <>
                Already have an account? <Link to="/login">Sign in</Link>
              </>
            )}
          </p>
        </form>
      </main>
    </div>
  );
}
