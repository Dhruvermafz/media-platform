import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye,
  FolderOpen,
  Image as ImageIcon,
  Link2,
  Lock,
  Trash2,
} from "lucide-react";
import { api } from "../api/client";
import type { ShareLink } from "../api/types";
import { CopyButton, shareUrl } from "../components/media/ShareDialog";
import {
  EmptyState,
  ErrorState,
  PageSpinner,
} from "../components/ui/primitives";
import { useToast } from "../context/ToastContext";
import { formatDateTime, pluralize, timeAgo } from "../lib/format";

const state = (l: ShareLink) =>
  l.revokedAt
    ? "Revoked"
    : l.expiresAt && new Date(l.expiresAt) < new Date()
      ? "Expired"
      : "Active";

export function SharesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["shares", "all"],
    queryFn: () => api.shares(),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeShare(id),
    onSuccess: () => {
      toast.success("Link revoked. It no longer works.");
      void qc.invalidateQueries({ queryKey: ["shares"] });
    },
    onError: (e) => toast.error(e),
  });
  if (isLoading) return <PageSpinner />;
  if (error)
    return (
      <ErrorState
        message={(error as Error).message}
        onRetry={() => void refetch()}
      />
    );

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Shared links</h1>
          <span className="muted">
            {pluralize(
              data?.filter((l) => state(l) === "Active").length ?? 0,
              "active link",
            )}
          </span>
        </div>
      </header>
      {data?.length === 0 ? (
        <EmptyState icon={<Link2 size={28} />} title="Nothing shared yet">
          Open a photo, video or collection and choose Share to create a link
          anyone can open, with optional password and expiry.
        </EmptyState>
      ) : (
        <ul className="table-list">
          {data?.map((l) => {
            const s = state(l);
            return (
              <li key={l.id} className={s !== "Active" ? "inactive" : ""}>
                <span className="tl-icon">
                  {l.targetType === "collection" ? (
                    <FolderOpen size={20} />
                  ) : (
                    <ImageIcon size={20} />
                  )}
                </span>
                <div className="tl-main">
                  <strong>{l.targetName}</strong>
                  <span className="muted small">
                    {l.hasPassword && (
                      <>
                        <Lock size={12} aria-hidden /> Password ·{" "}
                      </>
                    )}
                    {l.expiresAt
                      ? `Expires ${formatDateTime(l.expiresAt)}`
                      : "Never expires"}{" "}
                    · Created {timeAgo(l.createdAt)}
                  </span>
                </div>
                <span className="tl-meta muted small">
                  <Eye size={14} aria-hidden /> {pluralize(l.viewCount, "view")}
                </span>
                <span
                  className={`pill pill-${s === "Active" ? "ok" : "neutral"}`}
                >
                  {s}
                </span>
                {s === "Active" && (
                  <>
                    <CopyButton text={shareUrl(l)} label="Copy" />
                    <button
                      className="icon-btn danger"
                      aria-label={`Revoke link to ${l.targetName}`}
                      onClick={() => revoke.mutate(l.id)}
                    >
                      <Trash2 size={17} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
