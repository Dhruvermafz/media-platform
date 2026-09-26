import { memo } from 'react';
import { Check, Film, Image as ImageIcon, Star } from 'lucide-react';
import type { AssetSummary } from '../../api/types';
import { aspectLabel, displayName, formatBytes, formatDuration, timeAgo } from '../../lib/format';
import { StatusPill } from '../ui/primitives';

interface Props {
  asset: AssetSummary; selected: boolean; selecting: boolean;
  onOpen: (a: AssetSummary) => void;
  onSelect: (a: AssetSummary, e: { shiftKey: boolean }) => void;
  onFavorite: (a: AssetSummary) => void;
}

export const AssetRow = memo(function AssetRow({ asset, selected, selecting, onOpen, onSelect, onFavorite }: Props) {
  const name = displayName(asset);
  return (
    <div className={`row ${selected ? 'selected' : ''}`}>
      <button className="row-check" role="checkbox" aria-checked={selected} aria-label={`Select ${name}`} onClick={(e) => onSelect(asset, { shiftKey: e.shiftKey })}>
        {selected && <Check size={14} strokeWidth={3} aria-hidden />}
      </button>
      <button className="row-main" onClick={(e) => (selecting || e.shiftKey ? onSelect(asset, { shiftKey: e.shiftKey }) : onOpen(asset))}>
        <span className="row-thumb" style={{ backgroundColor: asset.dominantColor ?? undefined }}>
          {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : asset.kind === 'VIDEO' ? <Film size={18} aria-hidden /> : <ImageIcon size={18} aria-hidden />}
        </span>
        <span className="row-name">
          <strong>{name}</strong>
          <span className="muted small">
            {asset.kind === 'VIDEO' ? `Video${asset.durationMs ? ` · ${formatDuration(asset.durationMs)}` : ''}` : 'Photo'}
            {aspectLabel(asset.width, asset.height) ? ` · ${aspectLabel(asset.width, asset.height)}` : ''}
          </span>
        </span>
        <span className="row-tags">{asset.tags.slice(0, 3).map((t) => <span key={t} className="chip">{t}</span>)}</span>
        <span className="row-status">{asset.status !== 'READY' && <StatusPill status={asset.status} />}</span>
        <span className="row-size muted">{formatBytes(asset.fileSize)}</span>
        <span className="row-date muted">{timeAgo(asset.createdAt)}</span>
      </button>
      {!asset.deletedAt && (
        <button className={`row-fav ${asset.isFavorite ? 'on' : ''}`} aria-pressed={asset.isFavorite} aria-label={asset.isFavorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => onFavorite(asset)}>
          <Star size={16} fill={asset.isFavorite ? 'currentColor' : 'none'} aria-hidden />
        </button>
      )}
    </div>
  );
});
