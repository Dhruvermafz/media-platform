import { useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronUp, RotateCw, X } from 'lucide-react';
import { useUploads } from '../../context/UploadContext';
import { formatBytes } from '../../lib/format';
import { ProgressBar } from '../ui/primitives';

export function UploadTray() {
  const { items, activeCount, cancel, retry, clearFinished } = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (items.length === 0) return null;

  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const title = activeCount > 0 ? `Uploading ${activeCount} ${activeCount === 1 ? 'file' : 'files'}` : failed ? `${done} uploaded, ${failed} failed` : `${done} ${done === 1 ? 'upload' : 'uploads'} complete`;

  return (
    <section className="tray" aria-label="Uploads">
      <header className="tray-head">
        <strong>{title}</strong>
        <div>
          <button className="icon-btn" aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'} onClick={() => setCollapsed((c) => !c)}>{collapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
          {activeCount === 0 && <button className="icon-btn" aria-label="Clear finished uploads" onClick={clearFinished}><X size={18} /></button>}
        </div>
      </header>
      {!collapsed && (
        <ul className="tray-list">
          {items.map((i) => (
            <li key={i.id} className={`tray-item ${i.status}`}>
              <div className="tray-name"><span title={i.name}>{i.name}</span><span className="muted small">{formatBytes(i.size)}</span></div>
              {(i.status === 'uploading' || i.status === 'queued') && <ProgressBar value={i.status === 'queued' ? 0 : i.progress} />}
              <div className="tray-state small">
                {i.status === 'queued' && <span className="muted">Waiting…</span>}
                {i.status === 'uploading' && <span className="muted">{Math.round(i.progress * 100)}%</span>}
                {i.status === 'finalizing' && <span className="muted">Finishing…</span>}
                {i.status === 'done' && <span className="ok-text"><Check size={14} aria-hidden /> Uploaded. Processing has started.</span>}
                {i.status === 'error' && <span className="bad-text"><AlertCircle size={14} aria-hidden /> {i.error}</span>}
                {i.status === 'canceled' && <span className="muted">Canceled</span>}
              </div>
              <div className="tray-actions">
                {(i.status === 'queued' || i.status === 'uploading') && <button className="icon-btn" aria-label={`Cancel ${i.name}`} onClick={() => cancel(i.id)}><X size={16} /></button>}
                {(i.status === 'error' || i.status === 'canceled') && i.file.type !== '' && !/Only images/.test(i.error ?? '') && <button className="icon-btn" aria-label={`Retry ${i.name}`} onClick={() => retry(i.id)}><RotateCw size={16} /></button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
