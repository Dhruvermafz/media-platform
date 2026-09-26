import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AssetSummary, BulkAction, ListFilters, Page } from '../api/types';
import { useRealtime } from '../context/RealtimeContext';
import { useToast } from '../context/ToastContext';

export const PAGE_SIZE = 60;

export function useAssets(filters: ListFilters) {
  const { status } = useRealtime();
  return useInfiniteQuery({
    queryKey: ['assets', filters],
    queryFn: ({ pageParam, signal }) => api.listAssets(filters, pageParam, PAGE_SIZE, signal),
    initialPageParam: 1,
    getNextPageParam: (last: Page<AssetSummary>) => (last.hasMore ? last.page + 1 : undefined),
    placeholderData: keepPreviousData,
    // Live events normally keep this fresh; if the stream is down, fall back to
    // polling - but only while something is actually still being processed.
    refetchInterval: (q) => {
      if (status === 'live') return false;
      const busy = q.state.data?.pages.some((p) => p.items.some((a) => a.status !== 'READY' && a.status !== 'FAILED'));
      return busy ? 4000 : false;
    },
  });
}

export const useAsset = (id: string | null) =>
  useQuery({ queryKey: ['asset', id], queryFn: () => api.getAsset(id!), enabled: Boolean(id) });
export const useCollections = () => useQuery({ queryKey: ['collections'], queryFn: api.collections });
export const useTags = () => useQuery({ queryKey: ['tags'], queryFn: api.tags });
export const useUsage = () => useQuery({ queryKey: ['usage'], queryFn: api.usage });

/** Everything that can change when assets are edited. */
export function useInvalidateLibrary() {
  const qc = useQueryClient();
  return () => Promise.all(['assets', 'asset', 'usage', 'collections', 'tags', 'activity'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

/** Library mutations with consistent toasts and undo for destructive moves. */
export function useAssetActions() {
  const toast = useToast();
  const invalidate = useInvalidateLibrary();

  const bulk = useMutation({
    mutationFn: (v: { ids: string[]; action: BulkAction; collectionId?: string; tags?: string[] }) =>
      api.bulk(v.ids, v.action, { collectionId: v.collectionId, tags: v.tags }),
    onSettled: () => void invalidate(),
    onError: (e) => toast.error(e),
  });
  const run = (ids: string[], action: BulkAction, extra?: { collectionId?: string; tags?: string[] }) =>
    bulk.mutateAsync({ ids, action, ...extra });

  const noun = (n: number) => (n === 1 ? '1 item' : `${n} items`);
  return {
    busy: bulk.isPending,
    run,
    trash: async (ids: string[]) => {
      await run(ids, 'trash');
      toast.success(`Moved ${noun(ids.length)} to trash`, { label: 'Undo', onClick: () => void run(ids, 'restore') });
    },
    restore: async (ids: string[]) => { await run(ids, 'restore'); toast.success(`Restored ${noun(ids.length)}`); },
    deleteForever: async (ids: string[]) => { await run(ids, 'delete'); toast.success(`Permanently deleted ${noun(ids.length)}`); },
    setFavorite: async (ids: string[], on: boolean) => { await run(ids, on ? 'favorite' : 'unfavorite'); },
    addToCollection: async (ids: string[], collectionId: string, name: string) => { await run(ids, 'addToCollection', { collectionId }); toast.success(`Added ${noun(ids.length)} to “${name}”`); },
    removeFromCollection: async (ids: string[], collectionId: string) => { await run(ids, 'removeFromCollection', { collectionId }); toast.success(`Removed ${noun(ids.length)} from collection`); },
    addTags: async (ids: string[], tags: string[]) => { await run(ids, 'addTags', { tags }); toast.success(`Tagged ${noun(ids.length)}`); },
  };
}
