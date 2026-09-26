import { useState } from 'react';
import { Wand2 } from 'lucide-react';
import { api } from '../../api/client';
import type { AssetKind, RequestableType } from '../../api/types';
import { useToast } from '../../context/ToastContext';
import { useInvalidateLibrary } from '../../lib/queries';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/primitives';

const IMAGE_OPTIONS: { type: RequestableType; label: string; help: string }[] = [
  { type: 'IMAGE_FORMAT_CONVERT', label: 'Convert format', help: 'Save a copy as WebP, AVIF, JPEG or PNG.' },
  { type: 'IMAGE_RESIZE', label: 'Resize', help: 'A smaller copy at an exact width.' },
  { type: 'IMAGE_COMPRESS', label: 'Compress', help: 'Trade quality for a smaller file.' },
];
const VIDEO_OPTIONS: { type: RequestableType; label: string; help: string }[] = [
  { type: 'VIDEO_TRANSCODE', label: 'Transcode', help: 'A copy at another resolution.' },
  { type: 'VIDEO_PREVIEW', label: 'Preview clip', help: 'A short looping clip from any point.' },
];

/** Requests an extra rendition; the worker fleet builds it in the background. */
export function RenditionDialog({ open, onClose, assetId, kind }: { open: boolean; onClose: () => void; assetId: string; kind: AssetKind }) {
  const options = kind === 'IMAGE' ? IMAGE_OPTIONS : VIDEO_OPTIONS;
  const [type, setType] = useState<RequestableType>(options[0].type);
  const [format, setFormat] = useState('webp');
  const [width, setWidth] = useState(1024);
  const [quality, setQuality] = useState(70);
  const [resolution, setResolution] = useState('480p');
  const [start, setStart] = useState(0);
  const [duration, setDuration] = useState(5);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const invalidate = useInvalidateLibrary();

  const params = (): Record<string, unknown> => {
    switch (type) {
      case 'IMAGE_FORMAT_CONVERT': return { format };
      case 'IMAGE_RESIZE': return { width };
      case 'IMAGE_COMPRESS': return { quality };
      case 'VIDEO_TRANSCODE': return { resolution };
      case 'VIDEO_PREVIEW': return { startSeconds: start, durationSeconds: duration };
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.requestVariant(assetId, type, params());
      toast[res.created ? 'success' : 'info'](res.created ? 'Rendition queued. It will appear here when ready.' : 'You already requested exactly this rendition.');
      void invalidate();
      onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Create a rendition" description="Processed in the background by the worker fleet."
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void submit()}><Wand2 size={16} />{busy ? 'Queuing…' : 'Create'}</button></>}>
      <div className="stack">
        <div className="radio-cards" role="radiogroup" aria-label="Rendition type">
          {options.map((o) => (
            <button key={o.type} role="radio" aria-checked={type === o.type} className={type === o.type ? 'on' : ''} onClick={() => setType(o.type)}>
              <strong>{o.label}</strong><span className="muted small">{o.help}</span>
            </button>
          ))}
        </div>
        {type === 'IMAGE_FORMAT_CONVERT' && (
          <Field label="Format"><select className="input" value={format} onChange={(e) => setFormat(e.target.value)}>{['webp', 'avif', 'jpeg', 'png'].map((f) => <option key={f}>{f}</option>)}</select></Field>
        )}
        {type === 'IMAGE_RESIZE' && (
          <Field label="Width (px)" hint="64 – 8000. Height keeps the aspect ratio."><input className="input" type="number" min={64} max={8000} value={width} onChange={(e) => setWidth(Number(e.target.value))} /></Field>
        )}
        {type === 'IMAGE_COMPRESS' && (
          <Field label={`Quality: ${quality}`} hint="Lower is smaller."><input type="range" min={10} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} /></Field>
        )}
        {type === 'VIDEO_TRANSCODE' && (
          <Field label="Resolution"><select className="input" value={resolution} onChange={(e) => setResolution(e.target.value)}>{['1080p', '720p', '480p', '360p'].map((r) => <option key={r}>{r}</option>)}</select></Field>
        )}
        {type === 'VIDEO_PREVIEW' && (
          <div className="grid-2">
            <Field label="Start (seconds)"><input className="input" type="number" min={0} value={start} onChange={(e) => setStart(Number(e.target.value))} /></Field>
            <Field label="Length (1–30 s)"><input className="input" type="number" min={1} max={30} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}
