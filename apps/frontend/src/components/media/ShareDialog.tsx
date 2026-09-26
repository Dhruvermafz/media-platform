import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Lock, Share2, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import type { ShareLink } from '../../api/types';
import { useToast } from '../../context/ToastContext';
import { formatDateTime, pluralize } from '../../lib/format';
import { Dialog } from '../ui/Dialog';
import { Field, Spinner, Switch } from '../ui/primitives';

export const shareUrl = (l: Pick<ShareLink, 'path'>) => `${window.location.origin}${l.path}`;

const EXPIRY = [
  { label: '1 day', hours: 24 }, { label: '7 days', hours: 168 }, { label: '30 days', hours: 720 }, { label: 'Never', hours: 0 },
];

export function CopyButton({ text, label = 'Copy link' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button className="btn" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1800); }
      catch { toast.info('Press Ctrl/Cmd+C to copy the link'); }
    }}>{done ? <Check size={16} /> : <Copy size={16} />}{done ? 'Copied' : label}</button>
  );
}

export function ShareDialog({ open, onClose, target, name }: {
  open: boolean; onClose: () => void; name: string; target: { assetId?: string; collectionId?: string };
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['shares', target];
  const links = useQuery({ queryKey: key, queryFn: () => api.shares(target), enabled: open });
  const [hours, setHours] = useState(168);
  const [password, setPassword] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [fresh, setFresh] = useState<ShareLink | null>(null);

  const create = useMutation({
    mutationFn: () => api.createShare({ ...target, expiresInHours: hours || undefined, password: password || undefined, allowDownload }),
    onSuccess: (l) => { setFresh(l); setPassword(''); void qc.invalidateQueries({ queryKey: ['shares'] }); },
    onError: (e) => toast.error(e),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeShare(id),
    onSuccess: () => { toast.success('Link revoked. It no longer works.'); void qc.invalidateQueries({ queryKey: ['shares'] }); },
    onError: (e) => toast.error(e),
  });

  const active = (links.data ?? []).filter((l) => !l.revokedAt && (!l.expiresAt || new Date(l.expiresAt) > new Date()));
  const canNativeShare = typeof navigator !== 'undefined' && 'share' in navigator;

  return (
    <Dialog open={open} onClose={() => { setFresh(null); onClose(); }} title="Share" description={`Anyone with the link can view “${name}”. No account needed.`} size="lg">
      {fresh ? (
        <div className="share-fresh">
          <p><strong>Your link is ready.</strong> {fresh.hasPassword ? 'Share the password separately.' : ''}</p>
          <input className="input" readOnly value={shareUrl(fresh)} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" data-autofocus />
          <div className="row-actions">
            <CopyButton text={shareUrl(fresh)} />
            {canNativeShare && <button className="btn" onClick={() => void navigator.share({ title: name, url: shareUrl(fresh) }).catch(() => undefined)}><Share2 size={16} />Share…</button>}
            <button className="btn btn-ghost" onClick={() => setFresh(null)}>Create another</button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="grid-2">
            <Field label="Expires">
              <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{EXPIRY.map((x) => <option key={x.label} value={x.hours}>{x.label}</option>)}</select>
            </Field>
            <Field label="Password (optional)" hint="At least 4 characters">
              <input className="input" type="password" autoComplete="new-password" minLength={4} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
          <div className="switch-row"><span>Allow downloads</span><Switch checked={allowDownload} onChange={setAllowDownload} label="Allow downloads" /></div>
          <div><button className="btn btn-primary" disabled={create.isPending || (password.length > 0 && password.length < 4)}><Link2 size={16} />Create link</button></div>
        </form>
      )}

      <h3 className="section-title">Active links</h3>
      {links.isLoading ? <Spinner /> : active.length === 0 ? <p className="muted">No active links.</p> : (
        <ul className="link-list">
          {active.map((l) => (
            <li key={l.id}>
              <div>
                <div className="link-url">{shareUrl(l).replace(/^https?:\/\//, '')}</div>
                <div className="muted small">
                  {l.hasPassword && <><Lock size={12} aria-hidden /> Password · </>}
                  {l.expiresAt ? `Expires ${formatDateTime(l.expiresAt)}` : 'Never expires'} · {pluralize(l.viewCount, 'view')}{l.allowDownload ? '' : ' · No downloads'}
                </div>
              </div>
              <CopyButton text={shareUrl(l)} label="Copy" />
              <button className="icon-btn danger" aria-label="Revoke link" title="Revoke" onClick={() => revoke.mutate(l.id)}><Trash2 size={16} /></button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
