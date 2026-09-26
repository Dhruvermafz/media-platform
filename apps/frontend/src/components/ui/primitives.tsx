import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, RotateCw } from 'lucide-react';
import type { AssetStatus, JobStatus } from '../../api/types';

export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return <span className="spinner-wrap" role="status" aria-label={label ?? 'Loading'}><Loader2 size={size} className="spin" aria-hidden /></span>;
}

export function PageSpinner() { return <div className="page-center"><Spinner size={28} /></div>; }

export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden />;
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>{icon}</div>
      <h2>{title}</h2>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty">
      <div className="empty-icon danger" aria-hidden><AlertTriangle size={28} /></div>
      <h2>Couldn’t load this</h2>
      <p className="muted">{message}</p>
      {onRetry && <button className="btn" onClick={onRetry}><RotateCw size={16} /> Try again</button>}
    </div>
  );
}

export function ProgressBar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'ok' | 'bad' }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><div className={`progress-fill ${tone}`} style={{ width: `${pct}%` }} /></div>;
}

export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; label: string; options: { value: T; label: ReactNode; title?: string }[];
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} title={o.title} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

const ASSET_LABEL: Record<AssetStatus, string> = { UPLOADING: 'Uploading', UPLOADED: 'Queued', PROCESSING: 'Processing', READY: 'Ready', FAILED: 'Failed' };
export function StatusPill({ status }: { status: AssetStatus | JobStatus }) {
  const label = (ASSET_LABEL as Record<string, string>)[status] ?? status.replace('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const tone = status === 'READY' || status === 'COMPLETED' ? 'ok' : status === 'FAILED' || status === 'DEAD_LETTER' ? 'bad' : status === 'RETRY' ? 'warn' : 'info';
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'bad' || tone === 'warn' ? AlertTriangle : status === 'PENDING' || status === 'UPLOADED' ? Clock : Loader2;
  return <span className={`pill pill-${tone}`}><Icon size={13} className={Icon === Loader2 ? 'spin' : ''} aria-hidden />{label}</span>;
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?';
  return <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>{initials}</span>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error" role="alert">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span /></button>
  );
}
