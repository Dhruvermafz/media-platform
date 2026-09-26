import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Asset, uploadFileDirect } from '../api/client';

export function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await api.listAssets();
    setAssets(res.items);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    // Polling is the simplest way for the dashboard to reflect async job
    // completion without adding websockets to the MVP — see docs/decisions.md.
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const { uploadUrl, storageKey } = await api.getUploadUrl(file.name, file.type, file.size);
      await uploadFileDirect(uploadUrl, file);
      await api.confirmUpload(storageKey, file.name, file.type);
      await refresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  return (
    <div>
      <h2>Assets</h2>
      <div className="card">
        <label>
          <strong>Upload a file</strong>
          <div className="muted" style={{ marginBottom: 8 }}>
            Uploads go directly to object storage via a presigned URL — the API never sees the file bytes.
          </div>
          <input type="file" accept="image/*,video/*" onChange={onFileSelected} disabled={uploading} />
        </label>
        {uploading && <p className="muted">Uploading…</p>}
        {uploadError && <p className="error-text">{uploadError}</p>}
      </div>

      <div className="card">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : assets.length === 0 ? (
          <p className="muted">No assets yet. Upload one above.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th>Size</th>
                <th>Status</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/assets/${a.id}`}>{a.fileName}</Link></td>
                  <td>{a.kind}</td>
                  <td>{formatBytes(a.fileSize)}</td>
                  <td><span className={`badge ${a.status}`}>{a.status}</span></td>
                  <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
