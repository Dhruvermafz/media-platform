import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useToast } from './ToastContext';

export type UploadStatus = 'queued' | 'uploading' | 'finalizing' | 'done' | 'error' | 'canceled';
export interface UploadItem {
  id: string; file: File; name: string; size: number; status: UploadStatus; progress: number;
  error?: string; assetId?: string; collectionId?: string;
}

const CONCURRENCY = 3;
const EXT_MIME: Record<string, string> = {
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', mp4: 'video/mp4', m4v: 'video/x-m4v',
};
/** Some browsers give an empty `file.type` for HEIC/MOV etc.; the API needs one. */
const mimeOf = (f: File) => f.type || EXT_MIME[f.name.split('.').pop()?.toLowerCase() ?? ''] || '';

interface UploadApi {
  items: UploadItem[];
  activeCount: number;
  enqueue: (files: File[], opts?: { collectionId?: string }) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  clearFinished: () => void;
  defaultCollectionId?: string;
  setDefaultCollectionId: (id?: string) => void;
}
const Ctx = createContext<UploadApi | null>(null);

function putFile(url: string, file: File, mime: string, onProgress: (p: number) => void, register: (abort: () => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(() => xhr.abort());
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', mime); // must match what the URL was signed with
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, `Storage rejected the upload (${xhr.status})`, 'STORAGE')));
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload', 'NETWORK'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.send(file);
  });
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [defaultCollectionId, setDefaultCollectionId] = useState<string | undefined>();
  const started = useRef(new Set<string>());
  const aborts = useRef(new Map<string, () => void>());

  const patch = useCallback((id: string, p: Partial<UploadItem>) => setItems((all) => all.map((i) => (i.id === id ? { ...i, ...p } : i))), []);

  const run = useCallback(async (item: UploadItem) => {
    const mime = mimeOf(item.file);
    try {
      patch(item.id, { status: 'uploading', progress: 0, error: undefined });
      const { uploadUrl, storageKey } = await api.uploadUrl(item.name, mime, item.size);
      // One automatic retry for transient network drops (mobile connections).
      for (let attempt = 0; ; attempt++) {
        try {
          await putFile(uploadUrl, item.file, mime, (p) => patch(item.id, { progress: p }), (abort) => aborts.current.set(item.id, abort));
          break;
        } catch (e) {
          if (attempt >= 1 || !(e instanceof ApiError) || e.code !== 'NETWORK') throw e;
          patch(item.id, { progress: 0 });
        }
      }
      patch(item.id, { status: 'finalizing', progress: 1 });
      const asset = await api.confirmUpload({ storageKey, fileName: item.name, mimeType: mime, collectionId: item.collectionId });
      patch(item.id, { status: 'done', assetId: asset.id });
      void qc.invalidateQueries({ queryKey: ['assets'] });
      void qc.invalidateQueries({ queryKey: ['usage'] });
      void qc.invalidateQueries({ queryKey: ['collections'] });
    } catch (e) {
      if ((e as Error).name === 'AbortError') { patch(item.id, { status: 'canceled' }); return; }
      const err = e as ApiError;
      patch(item.id, { status: 'error', error: err.message || 'Upload failed' });
      if (err.code === 'QUOTA_EXCEEDED') toast.error(err);
    } finally {
      aborts.current.delete(item.id);
    }
  }, [patch, qc, toast]);

  // Scheduler: keep up to CONCURRENCY uploads in flight.
  useEffect(() => {
    const active = items.filter((i) => i.status === 'uploading' || i.status === 'finalizing').length;
    let slots = CONCURRENCY - active;
    for (const item of items) {
      if (slots <= 0) break;
      if (item.status === 'queued' && !started.current.has(item.id)) {
        started.current.add(item.id);
        slots--;
        void run(item);
      }
    }
  }, [items, run]);

  const activeCount = items.filter((i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'finalizing').length;
  useEffect(() => {
    if (activeCount === 0) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [activeCount]);

  const value = useMemo<UploadApi>(() => ({
    items, activeCount, defaultCollectionId, setDefaultCollectionId,
    enqueue: (files, opts) => {
      const fresh: UploadItem[] = files.map((file) => {
        const okType = /^(image|video)\//.test(mimeOf(file));
        return {
          id: crypto.randomUUID(), file, name: file.name, size: file.size,
          status: okType ? 'queued' : 'error', progress: 0,
          error: okType ? undefined : 'Only images and videos are supported',
          collectionId: opts?.collectionId ?? defaultCollectionId,
        };
      });
      setItems((all) => [...all, ...fresh]);
    },
    cancel: (id) => {
      const abort = aborts.current.get(id);
      if (abort) abort();
      else patch(id, { status: 'canceled' });
    },
    retry: (id) => { started.current.delete(id); patch(id, { status: 'queued', progress: 0, error: undefined }); },
    clearFinished: () => setItems((all) => all.filter((i) => ['queued', 'uploading', 'finalizing'].includes(i.status))),
  }), [items, activeCount, defaultCollectionId, patch]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useUploads = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUploads must be used inside UploadProvider');
  return v;
};
