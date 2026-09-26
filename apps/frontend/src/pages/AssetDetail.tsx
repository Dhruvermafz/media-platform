import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, Asset, Job } from '../api/client';

export function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [retrying, setRetrying] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    const [assetRes, jobsRes] = await Promise.all([api.getAsset(id), api.getJobsForAsset(id)]);
    setAsset(assetRes);
    setJobs(jobsRes);
  }, [id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
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

  if (!asset) return <p className="muted">Loading…</p>;

  return (
    <div>
      <p><Link to="/assets">&larr; Back to assets</Link></p>
      <h2>{asset.fileName}</h2>
      <div className="card">
        <div className="grid">
          <div><div className="muted">Status</div><span className={`badge ${asset.status}`}>{asset.status}</span></div>
          <div><div className="muted">Kind</div>{asset.kind}</div>
          <div><div className="muted">MIME type</div>{asset.mimeType}</div>
          <div><div className="muted">Uploaded</div>{new Date(asset.createdAt).toLocaleString()}</div>
        </div>
      </div>

      <div className="card">
        <h3>Variants</h3>
        {!asset.variants || asset.variants.length === 0 ? (
          <p className="muted">No variants ready yet.</p>
        ) : (
          <table>
            <thead><tr><th>Type</th><th>Dimensions</th><th></th></tr></thead>
            <tbody>
              {asset.variants.map((v) => (
                <tr key={v.id}>
                  <td>{v.type}</td>
                  <td className="muted">{v.width && v.height ? `${v.width}×${v.height}` : '—'}</td>
                  <td><a href={v.downloadUrl} target="_blank" rel="noreferrer">Download</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Processing jobs</h3>
        <table>
          <thead><tr><th>Type</th><th>Status</th><th>Attempt</th><th>Error</th><th></th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.type}</td>
                <td><span className={`badge ${j.status}`}>{j.status}</span></td>
                <td className="muted">{j.attempt}/{j.maxAttempts}</td>
                <td className="muted">{j.failureReason ?? '—'}</td>
                <td>
                  {(j.status === 'FAILED' || j.status === 'DEAD_LETTER') && (
                    <button className="secondary" disabled={retrying === j.id} onClick={() => retry(j.id)}>
                      {retrying === j.id ? 'Retrying…' : 'Retry'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
