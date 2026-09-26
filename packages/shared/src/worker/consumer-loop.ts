import Redis from 'ioredis';
import { WorkerKind } from '../enums';
import { JobMessage, consumerGroupFor, consumerNameFor, streamKeyFor, dlqStreamKeyFor } from '../queue';

const BLOCK_MS = 5000;
const BATCH_SIZE = 5;
const CLAIM_IDLE_MS = 30_000; // a message pending this long belongs to a dead consumer

export type JobHandler = (message: JobMessage, streamEntryId: string) => Promise<void>;

/**
 * Thrown by a job handler to signal "this attempt is permanently done
 * failing — push it to the dead-letter stream and stop redelivering it".
 * The handler throws this only *after* it has already called
 * JobStore.failJob and persisted DEAD_LETTER to Postgres; Postgres, not
 * the stream, remains the source of truth for job status.
 *
 * Any other thrown error is treated as "the handler itself crashed
 * unexpectedly" (a bug, an OOM, a lost DB connection mid-write) and is
 * left unacked for XAUTOCLAIM to redeliver — this is worker-crash
 * recovery, distinct from the application-level retry-with-backoff path.
 * A RETRY outcome is *not* an error from this loop's point of view: the
 * handler calls JobStore.failJob (which schedules the retry row in
 * Postgres) and then returns normally, so this entry is ACKed and the
 * actual redelivery happens later as a brand-new stream message from
 * the API's RetrySchedulerService — never by replaying this same entry.
 */
export class FinalJobError extends Error {
  readonly final = true;
}

/**
 * One instance of this runs the full lifecycle for one worker replica:
 *
 *  1. Ensure the consumer group exists (idempotent, MKSTREAM so the
 *     stream doesn't need to pre-exist).
 *  2. Recover stale deliveries: XAUTOCLAIM anything idle > CLAIM_IDLE_MS,
 *     which is how a job survives its original worker replica crashing
 *     mid-processing — another replica picks it up instead of the job
 *     sitting unacked forever.
 *  3. XREADGROUP new messages, blocking so the process isn't hot-looping.
 *  4. Run the handler; XACK only on success. A handler that throws
 *     leaves the message pending, to be recovered by step 2 either by
 *     this replica or another one on their next pass.
 *
 * Retry/backoff/DEAD_LETTER accounting is NOT done here — the handler
 * (see each worker's main.ts) owns calling JobStore.failJob, because
 * only it knows whether the failure is retryable. This loop's only job
 * is "deliver at-least-once and don't lose messages on crash".
 */
export class StreamConsumer {
  private readonly stream: string;
  private readonly group: string;
  private readonly consumerName: string;
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly worker: WorkerKind,
    replicaId: string,
    private readonly handler: JobHandler,
    private readonly onUnrecoverableError: (message: JobMessage, err: Error) => Promise<void>,
  ) {
    this.stream = streamKeyFor(worker);
    this.group = consumerGroupFor(worker);
    this.consumerName = consumerNameFor(worker, replicaId);
  }

  async start(): Promise<void> {
    await this.ensureGroup();
    this.running = true;
    while (this.running) {
      await this.reclaimStale();
      await this.readAndProcess();
    }
  }

  stop(): void {
    this.running = false;
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err as Error).message.includes('BUSYGROUP')) throw err;
    }
  }

  private async reclaimStale(): Promise<void> {
    try {
      const [, entries] = (await this.redis.call(
        'XAUTOCLAIM',
        this.stream,
        this.group,
        this.consumerName,
        CLAIM_IDLE_MS,
        '0',
        'COUNT',
        BATCH_SIZE,
      )) as [string, [string, string[]][]];
      for (const [id, fields] of entries) {
        await this.handleEntry(id, fields);
      }
    } catch {
      // No pending entries yet, or group/stream still initializing — fine, next loop iteration retries.
    }
  }

  private async readAndProcess(): Promise<void> {
    const result = (await this.redis.xreadgroup(
      'GROUP',
      this.group,
      this.consumerName,
      'COUNT',
      BATCH_SIZE,
      'BLOCK',
      BLOCK_MS,
      'STREAMS',
      this.stream,
      '>',
    )) as [string, [string, string[]][]][] | null;

    if (!result) return;
    for (const [, entries] of result) {
      for (const [id, fields] of entries) {
        await this.handleEntry(id, fields);
      }
    }
  }

  private async handleEntry(id: string, fields: string[]): Promise<void> {
    const payloadIndex = fields.indexOf('payload');
    const raw = payloadIndex >= 0 ? fields[payloadIndex + 1] : null;
    if (!raw) {
      await this.redis.xack(this.stream, this.group, id); // malformed entry, ack so it doesn't loop forever
      return;
    }
    const message: JobMessage = JSON.parse(raw);
    try {
      await this.handler(message, id);
      await this.redis.xack(this.stream, this.group, id);
    } catch (err) {
      // Leave unacked: reclaimStale() picks it up again after CLAIM_IDLE_MS.
      // The handler is responsible for deciding, based on attempt count,
      // whether this should ultimately become a RETRY or DEAD_LETTER —
      // if it's the latter, it also pushes to the DLQ stream and this
      // loop then acks it so it stops being redelivered.
      const isFinal = (err as Error & { final?: boolean }).final;
      if (isFinal) {
        await this.redis.xadd(dlqStreamKeyFor(this.worker), '*', 'payload', raw, 'error', (err as Error).message);
        await this.redis.xack(this.stream, this.group, id);
      } else {
        await this.onUnrecoverableError(message, err as Error);
      }
    }
  }
}
