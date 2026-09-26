import { JobType, WorkerKind } from './enums';

/**
 * One Redis Stream per worker kind. This is the "separate consumer
 * groups/workers for different workloads" requirement: routing happens
 * at enqueue time (API picks the stream from JOB_TYPE_TO_WORKER), not
 * inside a shared queue with type filtering. A slow video transcode
 * can never head-of-line-block a thumbnail job.
 */
export function streamKeyFor(worker: WorkerKind): string {
  return `stream:jobs:${worker}`;
}

/** Every worker of a kind shares one consumer group so jobs are
 * load-balanced across replicas (XREADGROUP), and each replica gets a
 * distinct consumer name (see CONSUMER_NAME below) so XPENDING/XCLAIM
 * can attribute and recover in-flight jobs after a crash. */
export function consumerGroupFor(worker: WorkerKind): string {
  return `cg:${worker}`;
}

/** Dead-letter stream, one per worker kind, written to after
 * MAX_JOB_ATTEMPTS is exceeded. Kept as a stream (not just a DB row)
 * so operators can replay entries with XADD after a fix ships. */
export function dlqStreamKeyFor(worker: WorkerKind): string {
  return `stream:dlq:${worker}`;
}

export const MAX_JOB_ATTEMPTS = 3;

/** Base delay for exponential backoff between retries, in ms.
 * attempt 1 fail -> wait 1s, attempt 2 fail -> wait 2s, attempt 3 fail -> DLQ. */
export const RETRY_BASE_DELAY_MS = 1000;

export function backoffMs(attempt: number): number {
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

/**
 * Wire format of a single job message on a Redis Stream. Field values in
 * Redis Streams are strings, so JobMessage is JSON.stringify'd into a
 * single `payload` field (see redis-stream.util.ts) rather than spread
 * across multiple XADD fields — keeps producers/consumers symmetric and
 * schema changes to a single place.
 */
export interface JobMessage {
  jobId: string; // processing_jobs.id (UUID) - primary correlation id
  assetId: string;
  type: JobType;
  attempt: number; // 1-indexed
  idempotencyKey: string; // see idempotency.ts
  params: Record<string, unknown>; // e.g. { width: 480 } for resize
  createdAt: string; // ISO timestamp of original enqueue (not retry)
}

export function consumerNameFor(worker: WorkerKind, replicaId: string): string {
  return `${worker}-${replicaId}`;
}
