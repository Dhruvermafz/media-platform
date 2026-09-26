import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, ChevronLeft, ChevronRight, Download, FolderPlus, Info, Link2, MoreHorizontal, Pencil, RotateCcw, Star, Trash2, Wand2, X,
} from 'lucide-react';
import { api } from '../../api/client';
import type { AssetDetail, AssetSummary, Variant } from '../../api/types';
import { useToast } from '../../context/ToastContext';
import { useHotkey, useIsDesktop } from '../../lib/hooks';
import { useAsset, useAssetActions, useInvalidateLibrary } from '../../lib/queries';
import { aspectLabel, displayName, formatBytes, formatDateTime, formatDuration } from '../../lib/format';
import { jobLabel } from '../../lib/labels';
import { ConfirmDialog } from '../ui/Dialog';
import { Menu } from '../ui/Menu';
import { ErrorState, Spinner, StatusPill } from '../ui/primitives';
import { CollectionPicker } from './CollectionPicker';
import { RenditionDialog } from './RenditionDialog';
import { ShareDialog } from './ShareDialog';
import { TagEditor } from './TagEditor';

interface Props {
  assetId: string;
  ids: string[]; // ordered ids of the surrounding list, for prev/next
  initial?: AssetSummary; // already-loaded summary, painted instantly while detail loads
  onNavigate: (id: string) => void;
  onClose: () => void;
}

const SWIPE_PX = 60;

export function Viewer({ assetId, ids, initial, onNavigate, onClose }: Props) {
  const { data: asset, error, refetch } = useAsset(assetId);
  const isDesktop = useIsDesktop();
  const [panel, setPanel] = useState(true);
  const [modal, setModal] = useState<null | 'share' | 'collection' | 'rendition' | 'trash' | 'delete'>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const actions = useAssetActions();
  const toast = useToast();
  const invalidate = useInvalidateLibrary();

  const index = ids.indexOf(assetId);
  const prevId = index > 0 ? ids[index - 1] : null;
  const nextId = index >= 0 && index < ids.length - 1 ? ids[index + 1] : null;

  // On phones the panel is a sheet opened on demand; on desktop it starts open.
  useEffect(() => { setPanel(isDesktop); }, [isDesktop]);

  // Focus + scroll lock (this overlay behaves like a modal dialog).
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; previous?.focus?.(); };
  }, []);

  // Keyboard. Arrow keys are ignored while a dialog/input has focus.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,[role="dialog"]:not(.viewer)') ) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && prevId) onNavigate(prevId);
      else if (e.key === 'ArrowRight' && nextId) onNavigate(nextId);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [prevId, nextId, onNavigate, onClose]);
  useHotkey('i', () => setPanel((p) => !p), modal === null);
  useHotkey('f', () => asset && toggleFavorite(), modal === null);

  // Warm the next/previous detail + image so navigation feels instant.
  const qc = useQueryClient();
  useEffect(() => {
    for (const id of [prevId, nextId]) if (id) void qc.prefetchQuery({ queryKey: ['asset', id], queryFn: () => api.getAsset(id), staleTime: 20_000 });
  }, [prevId, nextId, qc]);

  const save = useMutation({
    mutationFn: (patch: { title?: string; description?: string; isFavorite?: boolean }) => api.updateAsset(assetId, patch),
    onSuccess: (a) => { qc.setQueryData(['asset', assetId], a); void qc.invalidateQueries({ queryKey: ['assets'] }); },
    onError: (e) => toast.error(e),
  });
  const saveTags = useMutation({
    mutationFn: (tags: string[]) => api.setTags(assetId, tags),
    onSuccess: (a) => { qc.setQueryData(['asset', assetId], a); void invalidate(); },
    onError: (e) => toast.error(e),
  });
  const toggleFavorite = () => asset && save.mutate({ isFavorite: !asset.isFavorite });

  const download = async (variantId?: string) => {
    try {
      const { url } = await api.download(assetId, variantId);
      const a = document.createElement('a');
      a.href = url; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { toast.error(e); }
  };

  const trashed = Boolean(asset?.deletedAt ?? initial?.deletedAt);
  const name = asset ? displayName(asset) : initial ? displayName(initial) : 'Loading…';

  // Swipe between items on touch (images only: on video it would fight the seek bar).
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipe.current; swipe.current = null;
    if (!s || asset?.kind === 'VIDEO') return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && nextId) onNavigate(nextId); else if (dx > 0 && prevId) onNavigate(prevId);
    }
  };

  return (
    <div className="viewer" ref={rootRef} role="dialog" aria-modal="true" aria-label={`Viewing ${name}`} tabIndex={-1}>
      <header className="viewer-bar">
        <button className="icon-btn on-dark" onClick={onClose} aria-label="Close viewer"><ArrowLeft size={22} className="only-mobile" /><X size={22} className="only-desktop" /></button>
        <div className="viewer-title"><strong>{name}</strong>{index >= 0 && <span className="small">{index + 1} of {ids.length}</span>}</div>
        <div className="viewer-actions">
          {!trashed && asset && (
            <button className={`icon-btn on-dark ${asset.isFavorite ? 'fav-on' : ''}`} aria-pressed={asset.isFavorite} aria-label={asset.isFavorite ? 'Remove from favorites' : 'Add to favorites'} title="Favorite (F)" onClick={toggleFavorite}>
              <Star size={20} fill={asset.isFavorite ? 'currentColor' : 'none'} />
            </button>
          )}
          {!trashed && <button className="icon-btn on-dark" aria-label="Share" title="Share" onClick={() => setModal('share')}><Link2 size={20} /></button>}
          <button className="icon-btn on-dark" aria-label="Download original" title="Download" onClick={() => void download()}><Download size={20} /></button>
          <button className={`icon-btn on-dark ${panel ? 'active' : ''}`} aria-pressed={panel} aria-label="Details" title="Details (I)" onClick={() => setPanel((p) => !p)}><Info size={20} /></button>
          <Menu label="More actions" align="end"
            trigger={(p) => <button className="icon-btn on-dark" aria-label="More actions" {...p}><MoreHorizontal size={20} /></button>}
            items={trashed ? [
              { label: 'Restore', icon: <RotateCcw size={16} />, onClick: () => void actions.restore([assetId]).then(onClose) },
              { label: 'Delete forever', icon: <Trash2 size={16} />, danger: true, onClick: () => setModal('delete') },
            ] : [
              { label: 'Rename', icon: <Pencil size={16} />, onClick: () => { setPanel(true); setTimeout(() => titleRef.current?.focus(), 50); } },
              { label: 'Add to collection', icon: <FolderPlus size={16} />, onClick: () => setModal('collection') },
              { label: 'Create rendition…', icon: <Wand2 size={16} />, onClick: () => setModal('rendition'), disabled: asset?.status === 'UPLOADING' },
              { divider: true, label: '', onClick: () => undefined },
              { label: 'Move to trash', icon: <Trash2 size={16} />, danger: true, onClick: () => setModal('trash') },
            ]} />
        </div>
      </header>

      <div className="viewer-body">
        <div className="viewer-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
          {prevId && <button className="nav-btn left" aria-label="Previous" onClick={() => onNavigate(prevId)}><ChevronLeft size={28} /></button>}
          {nextId && <button className="nav-btn right" aria-label="Next" onClick={() => onNavigate(nextId)}><ChevronRight size={28} /></button>}
          {error ? <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
            : asset ? <Stage key={asset.id} asset={asset} />
            : <Placeholder initial={initial} />}
        </div>

        {panel && (
          <aside className="viewer-panel" aria-label="Details">
            <button className="icon-btn panel-close only-mobile" aria-label="Close details" onClick={() => setPanel(false)}><X size={20} /></button>
            {asset ? (
              <Panel asset={asset} titleRef={titleRef} trashed={trashed}
                onSave={(p) => save.mutate(p)} onTags={(t) => saveTags.mutate(t)} tagsBusy={saveTags.isPending}
                onAddCollection={() => setModal('collection')} onRendition={() => setModal('rendition')} onDownload={(v) => void download(v.id)} />
            ) : <div className="pad"><Spinner /></div>}
          </aside>
        )}
      </div>

      {asset && <>
        <ShareDialog open={modal === 'share'} onClose={() => setModal(null)} name={name} target={{ assetId }} />
        <CollectionPicker open={modal === 'collection'} onClose={() => setModal(null)} assetIds={[assetId]} />
        <RenditionDialog key={assetId} open={modal === 'rendition'} onClose={() => setModal(null)} assetId={assetId} kind={asset.kind} />
      </>}
      <ConfirmDialog open={modal === 'trash'} title="Move to trash?" message={`“${name}” will be kept in the trash for 30 days, then deleted permanently.`} confirmLabel="Move to trash" danger
        onClose={() => setModal(null)} onConfirm={() => { setModal(null); void actions.trash([assetId]).then(() => (nextId ? onNavigate(nextId) : prevId ? onNavigate(prevId) : onClose())); }} />
      <ConfirmDialog open={modal === 'delete'} title="Delete forever?" message="This permanently removes the file and all its renditions. It can’t be undone." confirmLabel="Delete forever" danger
        onClose={() => setModal(null)} onConfirm={() => { setModal(null); void actions.deleteForever([assetId]).then(onClose); }} />
    </div>
  );
}

function Placeholder({ initial }: { initial?: AssetSummary }) {
  return (
    <div className="stage-media">
      {initial?.thumbnailUrl ? <img className="stage-img blurred" src={initial.thumbnailUrl} alt="" /> : <Spinner size={28} />}
    </div>
  );
}

/** The image or video itself. */
function Stage({ asset }: { asset: AssetDetail }) {
  const invalidate = useInvalidateLibrary();
  const jobs = useQuery({ queryKey: ['jobs', 'asset', asset.id], queryFn: () => api.assetJobs(asset.id), enabled: asset.status !== 'READY' });
  const busy = asset.status !== 'READY';
  return (
    <div className="stage-media">
      {asset.kind === 'IMAGE' ? <ImageStage asset={asset} /> : <VideoStage asset={asset} />}
      {busy && (
        <div className="stage-status" role="status">
          <StatusPill status={asset.status} />
          {jobs.data && asset.status !== 'FAILED' && <span className="small">{jobs.data.filter((j) => j.status === 'COMPLETED').length} of {jobs.data.length} steps</span>}
          <button className="link-btn" onClick={() => void invalidate()}>Refresh</button>
        </div>
      )}
    </div>
  );
}

function ImageStage({ asset }: { asset: AssetDetail }) {
  const [src, setSrc] = useState(asset.previewUrl ?? asset.originalUrl);
  const [zoom, setZoom] = useState<null | { x: number; y: number }>(null);
  useEffect(() => { setSrc(asset.previewUrl ?? asset.originalUrl); setZoom(null); }, [asset.previewUrl, asset.originalUrl]);
  return (
    <img
      className={`stage-img ${zoom ? 'zoomed' : ''}`} src={src} alt={displayName(asset)} draggable={false}
      style={zoom ? { transformOrigin: `${zoom.x}% ${zoom.y}%` } : undefined}
      // Original may be a format the browser can't show (HEIC); fall back to the thumbnail.
      onError={() => asset.thumbnailUrl && src !== asset.thumbnailUrl && setSrc(asset.thumbnailUrl)}
      onClick={(e) => {
        if (zoom) return setZoom(null);
        const r = e.currentTarget.getBoundingClientRect();
        setZoom({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
      }}
    />
  );
}

interface Source { key: string; label: string; url: string }
function videoSources(asset: AssetDetail): Source[] {
  const transcodes = asset.variants.filter((v) => v.type === 'VIDEO_TRANSCODE').sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.fileSize - a.fileSize)
    .map((v) => ({ key: v.id, label: v.name.replace(/\.\w+$/, ''), url: v.downloadUrl }));
  return [...transcodes, { key: 'original', label: 'Original', url: asset.originalUrl }];
}

function VideoStage({ asset }: { asset: AssetDetail }) {
  const sources = useMemo(() => videoSources(asset), [asset]);
  const preferred = sources.find((s) => s.label === '720p') ?? sources[0];
  const [key, setKey] = useState(preferred.key);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLVideoElement>(null);
  const resume = useRef<{ t: number; playing: boolean } | null>(null);
  const current = sources.find((s) => s.key === key) ?? sources[sources.length - 1];
  const ratio = asset.width && asset.height ? asset.width / asset.height : 16 / 9;

  const change = (k: string) => {
    const v = ref.current;
    if (v) resume.current = { t: v.currentTime, playing: !v.paused };
    setKey(k);
  };

  // A rendition the browser can't decode (e.g. an HEVC original in Firefox):
  // try the remaining sources before giving up, so the user sees *something*.
  const onError = () => {
    const next = new Set(failed).add(current.key);
    setFailed(next);
    const fallback = sources.find((s) => !next.has(s.key));
    if (fallback) change(fallback.key);
  };
  const allFailed = sources.every((s) => failed.has(s.key));

  if (allFailed) {
    return (
      <div className="video-fallback" style={{ aspectRatio: ratio }}>
        {asset.thumbnailUrl && <img src={asset.thumbnailUrl} alt="" />}
        <div>
          <strong>This browser can’t play this video</strong>
          <span className="small">Download it to watch in another player.</span>
          <a className="btn btn-primary" href={asset.originalUrl} download><Download size={16} />Download original</a>
        </div>
      </div>
    );
  }
  return (
    <div className="video-wrap">
      <video ref={ref} key={current.key} className="stage-video" style={{ aspectRatio: ratio }} src={current.url} poster={asset.thumbnailUrl ?? undefined} controls playsInline preload="metadata" onError={onError}
        onLoadedMetadata={(e) => {
          const r = resume.current; resume.current = null;
          if (r) { e.currentTarget.currentTime = r.t; if (r.playing) void e.currentTarget.play(); }
        }} />
      {sources.length > 1 && (
        <label className="quality"><span className="sr-only">Quality</span>
          <select value={current.key} onChange={(e) => change(e.target.value)} aria-label="Video quality">{sources.map((s) => <option key={s.key} value={s.key}>{s.label}{failed.has(s.key) ? ' (unsupported)' : ''}</option>)}</select>
        </label>
      )}
    </div>
  );
}

const META_LABELS: [string, string, (v: unknown) => string][] = [
  ['camera', 'Camera', String], ['lens', 'Lens', String], ['exposure', 'Shutter', (v) => `${v} s`], ['aperture', 'Aperture', String],
  ['iso', 'ISO', String], ['focalLengthMm', 'Focal length', (v) => `${v} mm`], ['container', 'Container', String],
  ['videoCodec', 'Video codec', (v) => String(v).toUpperCase()], ['audioCodec', 'Audio codec', (v) => String(v).toUpperCase()],
  ['fps', 'Frame rate', (v) => `${v} fps`], ['bitrateKbps', 'Bitrate', (v) => `${Number(v).toLocaleString()} kbps`],
];

function Panel({ asset, titleRef, trashed, onSave, onTags, tagsBusy, onAddCollection, onRendition, onDownload }: {
  asset: AssetDetail; titleRef: React.RefObject<HTMLInputElement>; trashed: boolean;
  onSave: (p: { title?: string; description?: string }) => void; onTags: (t: string[]) => void; tagsBusy: boolean;
  onAddCollection: () => void; onRendition: () => void; onDownload: (v: Variant) => void;
}) {
  const [title, setTitle] = useState(asset.title ?? '');
  const [desc, setDesc] = useState(asset.description ?? '');
  useEffect(() => { setTitle(asset.title ?? ''); setDesc(asset.description ?? ''); }, [asset.id, asset.title, asset.description]);
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ['jobs', 'asset', asset.id], queryFn: () => api.assetJobs(asset.id) });
  const retry = useMutation({ mutationFn: (id: string) => api.retryJob(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ['jobs'] }) });
  const toast = useToast();
  const meta = asset.metadata ?? {};

  const facts: [string, string][] = [
    ['File', asset.fileName], ['Type', asset.mimeType], ['Size', formatBytes(asset.fileSize)],
    ...(aspectLabel(asset.width, asset.height) ? [['Dimensions', aspectLabel(asset.width, asset.height)!] as [string, string]] : []),
    ...(asset.durationMs ? [['Duration', formatDuration(asset.durationMs)] as [string, string]] : []),
    ...(asset.capturedAt ? [['Captured', formatDateTime(asset.capturedAt)] as [string, string]] : []),
    ['Uploaded', formatDateTime(asset.createdAt)],
    ...META_LABELS.filter(([k]) => meta[k] !== null && meta[k] !== undefined && meta[k] !== '').map(([k, l, f]) => [l, f(meta[k])] as [string, string]),
  ];

  return (
    <div className="panel-scroll">
      <section>
        <input ref={titleRef} className="panel-title" value={title} placeholder={asset.fileName} maxLength={200} disabled={trashed} aria-label="Title"
          onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== (asset.title ?? '') && onSave({ title })}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur())} />
        <textarea className="panel-desc" value={desc} placeholder="Add a description" rows={2} maxLength={2000} disabled={trashed} aria-label="Description"
          onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== (asset.description ?? '') && onSave({ description: desc })} />
      </section>

      {!trashed && <>
        <section><h3>Tags</h3><TagEditor tags={asset.tags} onChange={onTags} disabled={tagsBusy} /></section>
        <section>
          <h3>Collections</h3>
          <div className="chips">
            {asset.collections.map((c) => <Link key={c.id} to={`/collections/${c.id}`} className="chip chip-link">{c.name}</Link>)}
            <button className="chip chip-add" onClick={onAddCollection}><FolderPlus size={12} aria-hidden /> Add</button>
          </div>
        </section>
      </>}

      <section>
        <h3>Details</h3>
        <dl className="facts">
          {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          {asset.dominantColor && <div><dt>Colour</dt><dd><span className="swatch" style={{ background: asset.dominantColor }} />{asset.dominantColor}</dd></div>}
        </dl>
      </section>

      <section>
        <div className="section-head"><h3>Renditions</h3>{!trashed && <button className="link-btn" onClick={onRendition}><Wand2 size={13} /> Create</button>}</div>
        {asset.variants.length === 0 ? <p className="muted small">None yet. They appear as workers finish.</p> : (
          <ul className="variant-list">
            {asset.variants.map((v) => (
              <li key={v.id}>
                <div><strong>{v.name}</strong><span className="muted small">{[aspectLabel(v.width, v.height), formatBytes(v.fileSize)].filter(Boolean).join(' · ')}</span></div>
                <button className="icon-btn" aria-label={`Download ${v.name}`} onClick={() => onDownload(v)}><Download size={16} /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Processing</h3>
        {jobs.isLoading ? <Spinner /> : (
          <ul className="job-list">
            {jobs.data?.map((j) => (
              <li key={j.id}>
                <span>{jobLabel(j)}</span>
                <StatusPill status={j.status} />
                {(j.status === 'FAILED' || j.status === 'DEAD_LETTER') && <button className="link-btn" onClick={() => retry.mutate(j.id, { onError: (e) => toast.error(e) })}>Retry</button>}
                {j.failureReason && <span className="job-reason small">{j.failureReason}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
