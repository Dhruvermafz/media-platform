import { Pool } from 'pg';
import { AssetStatus, JobStatus } from '../enums';
import { EventPublisher } from '../events';
import { MAX_JOB_ATTEMPTS, backoffMs } from '../queue';

/**
 * Workers talk to Postgres with plain parameterized SQL via `pg`,
 * not Prisma. Rationale (full writeup in docs/decisions.md
 * "Workers use pg, not Prisma"): Prisma's generated client is tied to
 * the package it's generated into, and sharing one generated client
 * across four independently-deployed services (api + 3 workers) means
 * either a shared build artifact or regenerating per-service - both
 * add real complexity for what is, on the worker side, five narrow,
 * fixed SQL statements. The API keeps Prisma for its much larger surface
 * of ad-hoc queries where the ergonomics pay for themselves.
 *
 * Column names are quoted exactly as Prisma names them: schema.prisma
 * declares fields in camelCase with no @map, so Postgres columns are
 * created camelCase (e.g. "startedAt", not "started_at") and must be
 * double-quoted here or Postgres folds them to lowercase and the query
 * fails against a column that doesn't exist. Keep this file in sync with
 * apps/api/prisma/schema.prisma by hand - see docs/decisions.md for
 * why there's no compile-time check linking them.
 */
export class JobStore {
  /** `events` is optional so tests and one-off scripts can use the store
   * without Redis; every production worker passes one so the UI updates
   * the instant a job changes state instead of on its next poll. */
  constructor(
    private readonly pool: Pool,
    private readonly events?: EventPublisher,
  ) {}

  /** Looks up the asset's owner and publishes to that user's channel.
   * Best-effort: events are refetch hints, never the source of truth. */
  private async emit(assetId: string, event: Parameters<EventPublisher['publish']>[1]): Promise<void> {
    if (!this.events) return;
    try {
      const { rows } = await this.pool.query(`SELECT "ownerId" FROM assets WHERE id = $1`, [assetId]);
      if (rows[0]) await this.events.publish(rows[0].ownerId, event);
    } catch {
      // never let a notification failure affect job processing
    }
  }

  /** Marks a job PROCESSING right before the worker starts doing real
   * work, recording which Stream entry is driving this attempt so a
   * crash mid-processing can be correlated back via XPENDING/XCLAIM. */
  async markProcessing(jobId: string, streamMessageId: string): Promise<void> {
    const { rows } = await this.pool.query(
      `UPDATE processing_jobs
         SET status = $2, "startedAt" = now(), "streamMessageId" = $3, "updatedAt" = now()
       WHERE id = $1
       RETURNING "assetId", type`,
      [jobId, JobStatus.PROCESSING, streamMessageId],
    );
    if (rows[0]) {
      await this.emit(rows[0].assetId, {
        type: 'job.updated',
        assetId: rows[0].assetId,
        jobId,
        jobType: rows[0].type,
        status: JobStatus.PROCESSING,
      });
    }
  }

  /** Writes the variant row and marks the job COMPLETED in one
   * transaction. ON CONFLICT DO NOTHING on the variant insert is a
   * second, DB-level idempotency guard beneath the application-level
   * idempotency key: even if two worker replicas somehow both believe
   * they own the same delivery, only one variant row survives. */
  async completeJob(params: {
    jobId: string;
    assetId: string;
    type: string;
    storageKey: string;
    mimeType: string;
    fileSize: number;
    width?: number;
    height?: number;
    durationMs?: number;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO asset_variants (id, "assetId", "jobId", type, "storageKey", "mimeType", "fileSize", width, height, "durationMs", "createdAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT ("assetId", type, "storageKey") DO NOTHING`,
        [
          params.assetId,
          params.jobId,
          params.type,
          params.storageKey,
          params.mimeType,
          params.fileSize,
          params.width ?? null,
          params.height ?? null,
          params.durationMs ?? null,
        ],
      );
      await client.query(
        `UPDATE processing_jobs SET status = $2, "completedAt" = now(), "updatedAt" = now() WHERE id = $1`,
        [params.jobId, JobStatus.COMPLETED],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await this.afterJobCompleted(params.assetId, params.jobId, params.type);
  }

  /** Completes a METADATA_EXTRACT job. Metadata describes the *original*
   * file, so it is written onto the asset row rather than into
   * asset_variants (there is no derived file to store). Both writes share
   * one transaction so an asset never shows metadata from a job that is
   * still marked PROCESSING, or a COMPLETED job with no metadata.
   * COALESCE keeps any value already on the row if this run couldn't
   * determine one (e.g. a video with no readable colour). */
  async completeMetadataJob(params: {
    jobId: string;
    assetId: string;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    dominantColor?: string | null;
    capturedAt?: Date | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE assets
            SET width = COALESCE($2, width),
                height = COALESCE($3, height),
                "durationMs" = COALESCE($4, "durationMs"),
                "dominantColor" = COALESCE($5, "dominantColor"),
                "capturedAt" = COALESCE($6, "capturedAt"),
                metadata = $7::jsonb,
                "updatedAt" = now()
          WHERE id = $1`,
        [
          params.assetId,
          params.width ?? null,
          params.height ?? null,
          params.durationMs ?? null,
          params.dominantColor ?? null,
          params.capturedAt ?? null,
          JSON.stringify(params.metadata),
        ],
      );
      await client.query(
        `UPDATE processing_jobs SET status = $2, "completedAt" = now(), "updatedAt" = now() WHERE id = $1`,
        [params.jobId, JobStatus.COMPLETED],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await this.afterJobCompleted(params.assetId, params.jobId, 'METADATA_EXTRACT');
  }

  private async afterJobCompleted(assetId: string, jobId: string, jobType: string): Promise<void> {
    const status = await this.recomputeAssetStatus(assetId);
    await this.emit(assetId, { type: 'job.updated', assetId, jobId, jobType, status: JobStatus.COMPLETED });
    if (status) await this.emit(assetId, { type: 'asset.updated', assetId, status });
  }

  /** Records a failed attempt. If attempts remain, schedules a retry with
   * exponential backoff (picked up later by the API's RetrySchedulerService
   * sweep); otherwise moves the job to DEAD_LETTER permanently. */
  async failJob(jobId: string, attempt: number, maxAttempts: number, reason: string): Promise<JobStatus> {
    const exhausted = attempt >= maxAttempts;
    const nextStatus = exhausted ? JobStatus.DEAD_LETTER : JobStatus.RETRY;
    const scheduledAt = exhausted ? new Date() : new Date(Date.now() + backoffMs(attempt));

    const { rows } = await this.pool.query(
      `UPDATE processing_jobs
         SET status = $2, attempt = $3, "failureReason" = $4, "scheduledAt" = $5, "updatedAt" = now()
       WHERE id = $1
       RETURNING "assetId", type`,
      [jobId, nextStatus, attempt, reason.slice(0, 2000), scheduledAt],
    );

    if (rows[0]) {
      const assetId: string = rows[0].assetId;
      const assetStatus = exhausted ? await this.recomputeAssetStatus(assetId) : null;
      await this.emit(assetId, { type: 'job.updated', assetId, jobId, jobType: rows[0].type, status: nextStatus });
      if (assetStatus) await this.emit(assetId, { type: 'asset.updated', assetId, status: assetStatus });
    }
    return nextStatus;
  }

  /** Asset status is derived, never written directly by anything except
   * this function, so "why is this asset READY/FAILED" always has one
   * answer: every required job completed, or at least one hit DEAD_LETTER. */
  private async recomputeAssetStatus(assetId: string): Promise<AssetStatus | null> {
    const { rows } = await this.pool.query(
      `SELECT status, count(*)::int AS count FROM processing_jobs WHERE "assetId" = $1 GROUP BY status`,
      [assetId],
    );
    const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    const completed = counts[JobStatus.COMPLETED] ?? 0;
    const deadLettered = counts[JobStatus.DEAD_LETTER] ?? 0;

    let status: AssetStatus | null = null;
    if (deadLettered > 0) status = AssetStatus.FAILED;
    else if (completed === total && total > 0) status = AssetStatus.READY;

    if (status) {
      await this.pool.query(`UPDATE assets SET status = $2, "updatedAt" = now() WHERE id = $1`, [assetId, status]);
    }
    return status;
  }
}

export function defaultMaxAttempts(): number {
  return MAX_JOB_ATTEMPTS;
}
