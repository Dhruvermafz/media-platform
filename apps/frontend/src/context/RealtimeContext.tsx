import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { startRealtime, type PlatformEvent, type RealtimeStatus } from '../lib/realtime';
import { useAuth } from './AuthContext';

const Ctx = createContext<{ status: RealtimeStatus }>({ status: 'offline' });

/** Maps a server event to the cached queries it makes stale. */
export function keysFor(e: PlatformEvent): QueryKey[] {
  switch (e.type) {
    case 'job.updated':
      return [['assets'], ['asset', e.assetId], ['jobs'], ['admin']];
    case 'asset.updated':
    case 'asset.changed':
      return [['assets'], ['asset', e.assetId], ['jobs'], ['usage'], ['collections'], ['tags']];
    case 'asset.created':
    case 'asset.deleted':
      return [['assets'], ['usage'], ['collections'], ['tags'], ['jobs'], ['activity']];
    case 'library.changed':
      return e.scope === 'assets' ? [['assets'], ['asset'], ['usage'], ['collections'], ['tags']] : [[e.scope ?? 'assets'], ['assets'], ['asset'], ['activity']];
  }
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('offline');
  const pending = useRef(new Map<string, QueryKey>());
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!user) return;
    // A burst of worker events (one upload fires ~15) is coalesced into one
    // refetch per affected query instead of one per event.
    const flush = () => {
      timer.current = undefined;
      for (const key of pending.current.values()) void qc.invalidateQueries({ queryKey: key });
      pending.current.clear();
    };
    const stop = startRealtime({
      onStatus: setStatus,
      onConnected: () => void qc.invalidateQueries(), // catch up on anything missed while offline
      onEvent: (e) => {
        for (const k of keysFor(e)) pending.current.set(JSON.stringify(k), k);
        timer.current ??= setTimeout(flush, 250);
      },
    });
    return () => { stop(); clearTimeout(timer.current); timer.current = undefined; pending.current.clear(); };
  }, [user, qc]);

  return <Ctx.Provider value={{ status }}>{children}</Ctx.Provider>;
}

export const useRealtime = () => useContext(Ctx);
