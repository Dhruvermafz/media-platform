import { memo, useRef, useState } from 'react';
import { AlertTriangle, Check, Film, Image as ImageIcon, Play, Star } from 'lucide-react';
import type { AssetSummary } from '../../api/types';
import { displayName, formatDuration } from '../../lib/format';
import { PipelineStrip } from './PipelineStrip';

interface Props {
  asset: AssetSummary;
  selected: boolean;
  selecting: boolean;
  onOpen: (a: AssetSummary) => void;
  onSelect: (a: AssetSummary, e: { shiftKey: boolean }) => void;
  onFavorite: (a: AssetSummary) => void;
}

const LONG_PRESS_MS = 450;
// Touch browsers fire a synthetic mouseenter on tap; only real pointers should autoplay clips.
const canHover = typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches;

export const AssetTile = memo(function AssetTile({ asset, selected, selecting, onOpen, onSelect, onFavorite }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [hover, setHover] = useState(false);
  const press = useRef<{ t?: ReturnType<typeof setTimeout>; fired: boolean }>({ fired: false });
  const isVideo = asset.kind === 'VIDEO';
  const processing = asset.status !== 'READY';
  const name = displayName(asset);

  // Touch: long-press enters selection mode (the phone equivalent of a hover checkbox).
  const startPress = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    press.current.fired = false;
    press.current.t = setTimeout(() => { press.current.fired = true; navigator.vibrate?.(10); onSelect(asset, { shiftKey: false }); }, LONG_PRESS_MS);
  };
  const cancelPress = () => clearTimeout(press.current.t);

  const click = (e: React.MouseEvent) => {
    if (press.current.fired) { press.current.fired = false; return; }
    if (selecting || e.shiftKey || e.metaKey || e.ctrlKey) onSelect(asset, { shiftKey: e.shiftKey });
    else onOpen(asset);
  };

  return (
    <div
      className={`tile ${selected ? 'selected' : ''} ${selecting ? 'selecting' : ''}`}
      style={{ backgroundColor: asset.dominantColor ?? undefined }}
      onMouseEnter={() => isVideo && canHover && setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button className="tile-main" onClick={click} onPointerDown={startPress} onPointerUp={cancelPress} onPointerLeave={cancelPress} onPointerMove={cancelPress}
        onContextMenu={(e) => { if (press.current.fired) e.preventDefault(); }}
        aria-label={`${isVideo ? 'Video' : 'Photo'}: ${name}${processing ? ` (${asset.status.toLowerCase()})` : ''}`}>
        {asset.thumbnailUrl ? (
          <img src={asset.thumbnailUrl} alt="" loading="lazy" decoding="async" draggable={false} className={loaded ? 'in' : ''} onLoad={() => setLoaded(true)} />
        ) : (
          <span className="tile-ph" aria-hidden>{isVideo ? <Film size={26} /> : <ImageIcon size={26} />}</span>
        )}
        {hover && asset.clipUrl && <video className="tile-clip" src={asset.clipUrl} autoPlay muted loop playsInline />}
        {isVideo && (
          <span className="tile-badge"><Play size={11} fill="currentColor" aria-hidden />{asset.durationMs ? formatDuration(asset.durationMs) : 'Video'}</span>
        )}
        {asset.status === 'FAILED' && <span className="tile-failed"><AlertTriangle size={16} aria-hidden />Failed</span>}
      </button>

      <button className="tile-check" role="checkbox" aria-checked={selected} aria-label={`Select ${name}`} onClick={(e) => { e.stopPropagation(); onSelect(asset, { shiftKey: e.shiftKey }); }}>
        {selected && <Check size={14} strokeWidth={3} aria-hidden />}
      </button>
      {!asset.deletedAt && (
        <button className={`tile-fav ${asset.isFavorite ? 'on' : ''}`} aria-pressed={asset.isFavorite} aria-label={asset.isFavorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
          onClick={(e) => { e.stopPropagation(); onFavorite(asset); }}>
          <Star size={16} fill={asset.isFavorite ? 'currentColor' : 'none'} aria-hidden />
        </button>
      )}
      {processing && asset.status !== 'FAILED' && <PipelineStrip pipeline={asset.pipeline} status={asset.status} />}
    </div>
  );
});
