import { useEffect, useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { useUploads } from '../../context/UploadContext';

/** Drag files anywhere over the window to upload. */
export function DropOverlay() {
  const { enqueue } = useUploads();
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth.current++; setActive(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth.current <= 0) { depth.current = 0; setActive(false); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth.current = 0; setActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) enqueue(files);
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, [enqueue]);

  if (!active) return null;
  return (
    <div className="drop-overlay" aria-hidden>
      <div><UploadCloud size={44} /><h2>Drop to upload</h2><p>Photos and videos are processed automatically.</p></div>
    </div>
  );
}
