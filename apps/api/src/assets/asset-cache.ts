/** Redis key for the cached asset-detail response. Shared by AssetsService
 * (read/write) and EventsService (invalidates it when a worker reports
 * progress - closing the "worker-triggered cache invalidation" gap). */
export const assetCacheKey = (assetId: string) => `asset:${assetId}`;
