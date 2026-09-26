import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { api } from "../api/client";
import type { AdminUser } from "../api/types";
import {
  ErrorState,
  PageSpinner,
  Segmented,
} from "../components/ui/primitives";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { formatBytes, pluralize, timeAgo } from "../lib/format";
import { jobTypeLabel } from "../lib/labels";

type Tab = "overview" | "failed" | "users";
const ms = (n: number | null) =>
  n == null
    ? "—"
    : n < 1000
      ? `${Math.round(n)} ms`
      : `${(n / 1000).toFixed(1)} s`;

export function AdminPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  if (!isAdmin) return <Navigate to="/library" replace />;
  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Operations</h1>
          <span className="muted">Whole-platform view. Admins only.</span>
        </div>
      </header>
      <div className="toolbar">
        <Segmented<Tab>
          label="Section"
          value={tab}
          onChange={setTab}
          options={[
            { value: "overview", label: "Overview" },
            { value: "failed", label: "Failed jobs" },
            { value: "users", label: "Users" },
          ]}
        />
      </div>
      {tab === "overview" && <Overview />}
      {tab === "failed" && <Failed />}
      {tab === "users" && <Users />}
    </div>
  );
}

function Overview() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: api.adminStats,
    refetchInterval: 5000,
  });
  if (isLoading) return <PageSpinner />;
  if (error || !data)
    return (
      <ErrorState
        message={(error as Error)?.message ?? "Failed"}
        onRetry={() => void refetch()}
      />
    );
  const workers = Object.keys(data.queueDepths);
  const bar = (rec: Record<string, number>) => {
    const total = Object.values(rec).reduce((a, b) => a + b, 0) || 1;
    return (
      <div className="statusbar">
        {Object.entries(rec)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => (
            <span
              key={k}
              className={`sb-${k.toLowerCase()}`}
              style={{ flexGrow: v }}
              title={`${k}: ${v}`}
            >
              {v / total > 0.08
                ? `${k.replace("_", " ").toLowerCase()} ${v}`
                : ""}
            </span>
          ))}
      </div>
    );
  };
  return (
    <>
      <div className="stat-row">
        <div className="stat">
          <span className="stat-n">{data.totalAssets.toLocaleString()}</span>
          <span className="muted">Assets</span>
        </div>
        <div className="stat">
          <span className="stat-n">{ms(data.averageProcessingTimeMs)}</span>
          <span className="muted">Avg job time (24h)</span>
        </div>
        <div className="stat">
          <span className="stat-n">{ms(data.p95ProcessingTimeMs)}</span>
          <span className="muted">p95 job time</span>
        </div>
        <div className={`stat ${data.deadLetterJobCount ? "stat-bad" : ""}`}>
          <span className="stat-n">{data.deadLetterJobCount}</span>
          <span className="muted">Dead-lettered</span>
        </div>
        <div className="stat">
          <span className="stat-n">{data.retryCount}</span>
          <span className="muted">Retrying</span>
        </div>
      </div>
      <section className="panel">
        <h2>Workers</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Worker</th>
                <th className="num">Queue depth</th>
                <th className="num">Dead-letter</th>
                <th className="num">Active replicas</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <tr key={w}>
                  <td>
                    <strong>{w}</strong>
                  </td>
                  <td className="num">{data.queueDepths[w]}</td>
                  <td
                    className={`num ${data.deadLetterDepths[w] ? "bad-text" : ""}`}
                  >
                    {data.deadLetterDepths[w]}
                  </td>
                  <td className="num">{data.activeWorkers[w]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Jobs by status</h2>
        {bar(data.jobsByStatus)}
        <h2 className="mt">Assets by status</h2>
        {bar(data.assetsByStatus)}
      </section>
    </>
  );
}

function Failed() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "failed"],
    queryFn: api.adminFailedJobs,
    refetchInterval: 8000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.adminRetryJob(id),
    onSuccess: () => {
      toast.success("Retry queued");
      void qc.invalidateQueries({ queryKey: ["admin"] });
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
  if (!data?.length)
    return <p className="muted pad">No failed jobs. Everything is healthy.</p>;
  return (
    <ul className="table-list">
      {data.map((j) => (
        <li key={j.id}>
          <div className="tl-main">
            <strong>{jobTypeLabel(j.type)}</strong>
            <span className="muted small">
              {j.asset.fileName} · attempt {j.attempt} · {timeAgo(j.updatedAt)}
            </span>
            {j.failureReason && (
              <span className="job-reason small">{j.failureReason}</span>
            )}
          </div>
          <span
            className={`pill pill-${j.status === "DEAD_LETTER" ? "bad" : "warn"}`}
          >
            {j.status.replace("_", " ").toLowerCase()}
          </span>
          <button
            className="btn btn-sm"
            disabled={retry.isPending}
            onClick={() => retry.mutate(j.id)}
          >
            <RotateCw size={14} />
            Retry
          </button>
        </li>
      ))}
    </ul>
  );
}

function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: api.adminUsers,
  });
  const update = useMutation({
    mutationFn: (v: {
      id: string;
      role?: AdminUser["role"];
      quotaGb?: number;
    }) =>
      api.adminUpdateUser(v.id, {
        role: v.role,
        storageQuotaBytes:
          v.quotaGb !== undefined
            ? Math.round(v.quotaGb * 1024 ** 3)
            : undefined,
      }),
    onSuccess: () => {
      toast.success("User updated");
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
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
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th className="num">Files</th>
            <th className="num">Used</th>
            <th className="num">Quota (GB)</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.displayName || u.email}</strong>
                {u.displayName && (
                  <span className="muted small block">{u.email}</span>
                )}
              </td>
              <td>
                <select
                  className="input input-sm"
                  value={u.role}
                  disabled={u.id === me?.id}
                  aria-label={`Role for ${u.email}`}
                  onChange={(e) =>
                    update.mutate({
                      id: u.id,
                      role: e.target.value as AdminUser["role"],
                    })
                  }
                >
                  <option>USER</option>
                  <option>ADMIN</option>
                </select>
              </td>
              <td className="num">{pluralize(u.assetCount, "file")}</td>
              <td className="num">{formatBytes(u.usedBytes)}</td>
              <td className="num">
                <input
                  className="input input-sm quota"
                  type="number"
                  min={0}
                  step={1}
                  defaultValue={+(u.storageQuotaBytes / 1024 ** 3).toFixed(2)}
                  aria-label={`Quota in GB for ${u.email}`}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (
                      Number.isFinite(v) &&
                      Math.round(v * 1024 ** 3) !== u.storageQuotaBytes
                    )
                      update.mutate({ id: u.id, quotaGb: v });
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small pad">
        Role changes take effect when the user’s current sign-in expires (up to
        1 hour). <Link to="/settings">Settings</Link>
      </p>
    </div>
  );
}
