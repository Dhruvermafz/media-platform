import { useCallback, useEffect, useState } from 'react';
import { api, Job } from '../api/client';

type Stats = Awaited<ReturnType<typeof api.getAdminStats>>;

export function AdminPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [failedJobs, setFailedJobs] = useState<Array<Job & { asset: { fileName: string } }>>([]);
  const [retrying, setRetrying] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [statsRes, failedRes] = await Promise.all([api.getAdminStats(), api.getFailedJobs()]);
    setStats(statsRes);
    setFailedJobs(failedRes);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function retry(jobId: string) {
    setRetrying(jobId);
    try {
      await api.retryJob(jobId);
      await refresh();
    } finally {
      setRetrying(null);
    }
  }

  if (!stats) return <p className="muted">Loading…</p>;

  const totalQueueDepth = Object.values(stats.queueDepths).reduce((a, b) => a + b, 0);
  const totalActiveWorkers = Object.values(stats.activeWorkers).reduce((a, b) => a + b, 0);

  return (
    <div>
      <h2>Operations Dashboard</h2>

      <div className="grid" style={{ marginBottom: 16 }}>
        <StatCard label="Total Assets" value={stats.totalAssets} />
        <StatCard label="Processing" value={stats.assetsByStatus.PROCESSING ?? 0} />
        <StatCard label="Completed" value={stats.assetsByStatus.READY ?? 0} />
        <StatCard label="Failed" value={stats.assetsByStatus.FAILED ?? 0} />
        <StatCard label="Queue Depth" value={totalQueueDepth} />
        <StatCard label="Active Workers" value={totalActiveWorkers} />
        <StatCard label="Avg Processing Time" value={formatMs(stats.averageProcessingTimeMs)} />
        <StatCard label="P95 Processing Time" value={formatMs(stats.p95ProcessingTimeMs)} />
        <StatCard label="Retry Count" value={stats.retryCount} />
        <StatCard label="Dead Letter Jobs" value={stats.deadLetterJobCount} />
      </div>

      <div className="card">
        <h3>Queue depth by worker</h3>
        <table>
          <thead><tr><th>Worker</th><th>Pending</th><th>Dead-lettered</th><th>Active consumers</th></tr></thead>
          <tbody>
            {Object.keys(stats.queueDepths).map((worker) => (
              <tr key={worker}>
                <td>{worker}</td>
                <td>{stats.queueDepths[worker]}</td>
                <td>{stats.deadLetterDepths[worker] ?? 0}</td>
                <td>{stats.activeWorkers[worker] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Failed jobs</h3>
        {failedJobs.length === 0 ? (
          <p className="muted">No failed jobs.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Asset</th><th>Type</th><th>Status</th><th>Attempt</th><th>Error</th><th>Updated</th><th></th></tr>
            </thead>
            <tbody>
              {failedJobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.asset?.fileName ?? j.assetId}</td>
                  <td>{j.type}</td>
                  <td><span className={`badge ${j.status}`}>{j.status}</span></td>
                  <td className="muted">{j.attempt}/{j.maxAttempts}</td>
                  <td className="muted" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {j.failureReason ?? '—'}
                  </td>
                  <td className="muted">{new Date(j.updatedAt).toLocaleString()}</td>
                  <td>
                    <button className="secondary" disabled={retrying === j.id} onClick={() => retry(j.id)}>
                      {retrying === j.id ? 'Retrying…' : 'Retry'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function formatMs(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
