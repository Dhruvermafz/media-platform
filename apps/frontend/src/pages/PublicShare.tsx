import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  LayoutGrid,
  Link2Off,
  Lock,
  Play,
  X,
} from "lucide-react";
import { api, ApiError } from "../api/client";
import type { PublicShare, PublicShareItem } from "../api/types";
import { Field, PageSpinner, Spinner } from "../components/ui/primitives";
import { formatDuration, pluralize } from "../lib/format";

type State =
  | { kind: "loading" }
  | { kind: "password"; error?: string }
  | { kind: "gone"; title: string; text: string }
  | { kind: "ok"; share: PublicShare };

/** Public, no-login page for /s/:token. */
export function PublicSharePage() {
  const { token = "" } = useParams();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(
    async (pw?: string) => {
      setBusy(true);
      try {
        setState({ kind: "ok", share: await api.publicShare(token, pw) });
      } catch (e) {
        const err = e as ApiError;
        if (err.code === "PASSWORD_REQUIRED") setState({ kind: "password" });
        else if (err.code === "PASSWORD_INVALID")
          setState({ kind: "password", error: "That password isn’t right." });
        else if (err.code === "TOO_MANY_ATTEMPTS")
          setState({ kind: "password", error: err.message });
        else if (err.status === 410)
          setState({
            kind: "gone",
            title: "This link has expired",
            text: "Ask the person who shared it to send you a new one.",
          });
        else if (err.status === 404)
          setState({
            kind: "gone",
            title: "Link not available",
            text: "It may have been removed or revoked by its owner.",
          });
        else
          setState({
            kind: "gone",
            title: "Couldn’t load this link",
            text: err.message,
          });
      } finally {
        setBusy(false);
      }
    },
    [token],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") return <PageSpinner />;
  if (state.kind === "gone")
    return (
      <div className="public-center">
        <Link2Off size={36} />
        <h1>{state.title}</h1>
        <p className="muted">{state.text}</p>
      </div>
    );
  if (state.kind === "password") {
    return (
      <div className="public-center">
        <Lock size={32} />
        <h1>This link is protected</h1>
        <p className="muted">Enter the password you were given to view it.</p>
        <form
          className="stack pw-form"
          onSubmit={(e) => {
            e.preventDefault();
            void load(password);
          }}
        >
          <Field label="Password" error={state.error}>
            <input
              className="input"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <button
            className="btn btn-primary btn-block"
            disabled={busy || !password}
          >
            {busy ? <Spinner /> : "View"}
          </button>
        </form>
      </div>
    );
  }

  const { share } = state;
  return (
    <div className="public">
      <header className="public-head">
        <span className="brand-mark">
          <LayoutGrid size={18} />
        </span>
        <div>
          <h1>{share.title}</h1>
          <span className="muted">
            {pluralize(share.items.length, "item")}
            {share.expiresAt
              ? ` · available until ${new Date(share.expiresAt).toLocaleDateString()}`
              : ""}
          </span>
        </div>
      </header>
      <div className="grid public-grid" data-size="l">
        {share.items.map((it, i) => (
          <div
            key={it.id}
            className="tile"
            style={{ backgroundColor: it.dominantColor ?? undefined }}
          >
            <button
              className="tile-main"
              onClick={() => setOpen(i)}
              aria-label={`Open ${it.name}`}
            >
              {it.thumbnailUrl || it.kind === "IMAGE" ? (
                <img
                  className="in"
                  src={it.thumbnailUrl ?? it.viewUrl}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className="tile-ph">
                  <Film size={26} />
                </span>
              )}
              {it.kind === "VIDEO" && (
                <span className="tile-badge">
                  <Play size={11} fill="currentColor" />
                  {it.durationMs ? formatDuration(it.durationMs) : "Video"}
                </span>
              )}
            </button>
          </div>
        ))}
      </div>
      {open !== null && (
        <Lightbox
          items={share.items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: PublicShareItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const it = items[index];
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < items.length - 1)
        onIndex(index + 1);
    };
    window.addEventListener("keydown", on);
    const o = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", on);
      document.body.style.overflow = o;
    };
  }, [index, items.length, onIndex, onClose]);
  return (
    <div
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label={it.name}
    >
      <header className="viewer-bar">
        <button
          className="icon-btn on-dark"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={22} />
        </button>
        <div className="viewer-title">
          <strong>{it.name}</strong>
          <span className="small">
            {index + 1} of {items.length}
          </span>
        </div>
        <div className="viewer-actions">
          {it.downloadUrl && (
            <a
              className="icon-btn on-dark"
              href={it.downloadUrl}
              aria-label="Download"
              download
            >
              <Download size={20} />
            </a>
          )}
        </div>
      </header>
      <div className="viewer-body">
        <div className="viewer-stage">
          {index > 0 && (
            <button
              className="nav-btn left"
              aria-label="Previous"
              onClick={() => onIndex(index - 1)}
            >
              <ChevronLeft size={28} />
            </button>
          )}
          {index < items.length - 1 && (
            <button
              className="nav-btn right"
              aria-label="Next"
              onClick={() => onIndex(index + 1)}
            >
              <ChevronRight size={28} />
            </button>
          )}
          <div className="stage-media">
            {it.kind === "IMAGE" ? (
              <img
                key={it.id}
                className="stage-img"
                src={it.viewUrl}
                alt={it.name}
              />
            ) : (
              <video
                key={it.id}
                className="stage-video"
                src={it.viewUrl}
                poster={it.thumbnailUrl ?? undefined}
                controls
                playsInline
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
