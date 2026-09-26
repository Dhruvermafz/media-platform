import { createHash } from 'crypto';
import { JobType } from './enums';

/**
 * Idempotency strategy (full rationale in docs/decisions.md):
 *
 * key = sha256(assetId + ":" + transformationType + ":" + sortedParamsJSON)
 *
 * - Deterministic: the same logical transformation always hashes to the
 *   same key, regardless of how many times it's enqueued or retried.
 * - Params are key-sorted before serializing so {width:480,height:270}
 *   and {height:270,width:480} collide to the same key.
 * - This key is stored as a UNIQUE constraint on asset_variants
 *   (asset_id, idempotency_key). A worker that finishes a job and then
 *   crashes before acking, causing redelivery, will hit a unique
 *   violation on the second attempt's insert and simply treats that as
 *   "already done" rather than writing a duplicate variant or
 *   re-uploading to object storage.
 * - It is NOT the same as jobId: jobId identifies one attempt/row in
 *   processing_jobs; idempotencyKey identifies the *outcome* and is
 *   stable across retries of that same job and across any accidental
 *   duplicate enqueue of the same transformation.
 */
export function computeIdempotencyKey(
  assetId: string,
  type: JobType,
  params: Record<string, unknown>,
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = params[k];
      return acc;
    }, {});
  const raw = `${assetId}:${type}:${JSON.stringify(sortedParams)}`;
  return createHash('sha256').update(raw).digest('hex');
}
