import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, RotateCw } from "lucide-react";
import { api } from "../api/client";
import {
  EmptyState,
  ErrorState,
  PageSpinner,
  Segmented,
  StatusPill,
} from "../components/ui/primitives";
import { useToast } from "../context/ToastContext";
import { jobLabel } from "../lib/labels";
import { displayName, timeAgo } from "../lib/format";

type F = "all" | "active" | "failed";

export function ProcessingPage() {
  const [filter, setFilter] = useState<F>("all");
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["jobs", "list"],
    queryFn: () => api.jobs(),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.retryJob(id),
    onSuccess: () => {
      toast.success("Retry queued");
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["assets"] });
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

  const c = data!.counts;
  const active = (c.PENDING ?? 0) + (c.PROCESSING ?? 0) + (c.RETRY ?? 0);
  const failed = (c.FAILED ?? 0) + (c.DEAD_LETTER ?? 0);
  const items = data!.items.filter((j) =>
    filter === "active"
      ? ["PENDING", "PROCESSING", "RETRY"].includes(j.status)
      : filter === "failed"
        ? ["FAILED", "DEAD_LETTER"].includes(j.status)
        : true,
  );

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Processing</h1>
          <span className="muted">Updates live as workers finish</span>
        </div>
      </header>
      <div className="stat-row">
        <div className="stat">
          <span className="stat-n">{active}</span>
          <span className="muted">In progress</span>
        </div>
        <div className="stat">
          <span className="stat-n">{c.COMPLETED ?? 0}</span>
          <span className="muted">Completed</span>
        </div>
        <div className={`stat ${failed ? "stat-bad" : ""}`}>
          <span className="stat-n">{failed}</span>
          <span className="muted">Failed</span>
        </div>
      </div>
      <div className="toolbar">
        <Segmented<F>
          label="Filter jobs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "failed", label: "Failed" },
          ]}
        />
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={<Cpu size={28} />}
          title={
            filter === "failed"
              ? "Nothing failed"
              : filter === "active"
                ? "All caught up"
                : "No processing yet"
          }
        >
          Jobs appear here when you upload files or request renditions.
        </EmptyState>
      ) : (
        <ul className="table-list">
          {items.map((j) => (
            <li key={j.id} className={j.asset.deletedAt ? "inactive" : ""}>
              <div className="tl-main">
                <strong>{jobLabel(j)}</strong>
                <span className="muted small">
                  <Link to={`/library?asset=${j.asset.id}`}>
                    {displayName(j.asset)}
                  </Link>{" "}
                  · {timeAgo(j.updatedAt)}
                  {j.attempt > 1
                    ? ` · attempt ${j.attempt}/${j.maxAttempts}`
                    : ""}
                </span>
                {j.failureReason && (
                  <span className="job-reason small">{j.failureReason}</span>
                )}
              </div>
              <StatusPill status={j.status} />
              {(j.status === "FAILED" || j.status === "DEAD_LETTER") && (
                <button
                  className="btn btn-sm"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(j.id)}
                >
                  <RotateCw size={14} />
                  Retry
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
