import { Pool } from 'pg';
import { AssetStatus, JobStatus } from '../enums';
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
  constructor(private readonly pool: Pool) {}

  /** Marks a job PROCESSING right before the worker starts doing real
   * work, recording which Stream entry is driving this attempt so a
   * crash mid-processing can be correlated back via XPENDING/XCLAIM. */
  async markProcessing(jobId: string, streamMessageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE processing_jobs
         SET status = $2, "startedAt" = now(), "streamMessageId" = $3, "updatedAt" = now()
       WHERE id = $1`,
      [jobId, JobStatus.PROCESSING, streamMessageId],
    );
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
    await this.recomputeAssetStatus(params.assetId);
  }

  /** Records a failed attempt. If attempts remain, schedules a retry with
   * exponential backoff (picked up later by the API's RetrySchedulerService
   * sweep); otherwise moves the job to DEAD_LETTER permanently. */
  async failJob(jobId: string, attempt: number, maxAttempts: number, reason: string): Promise<JobStatus> {
    const exhausted = attempt >= maxAttempts;
    const nextStatus = exhausted ? JobStatus.DEAD_LETTER : JobStatus.RETRY;
    const scheduledAt = exhausted ? new Date() : new Date(Date.now() + backoffMs(attempt));

    await this.pool.query(
      `UPDATE processing_jobs
         SET status = $2, attempt = $3, "failureReason" = $4, "scheduledAt" = $5, "updatedAt" = now()
       WHERE id = $1`,
      [jobId, nextStatus, attempt, reason.slice(0, 2000), scheduledAt],
    );

    if (exhausted) {
      const row = await this.pool.query(`SELECT "assetId" FROM processing_jobs WHERE id = $1`, [jobId]);
      if (row.rows[0]) await this.recomputeAssetStatus(row.rows[0].assetId);
    }
    return nextStatus;
  }

  /** Asset status is derived, never written directly by anything except
   * this function, so "why is this asset READY/FAILED" always has one
   * answer: every required job completed, or at least one hit DEAD_LETTER. */
  private async recomputeAssetStatus(assetId: string): Promise<void> {
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
  }
}

export function defaultMaxAttempts(): number {
  return MAX_JOB_ATTEMPTS;
}
