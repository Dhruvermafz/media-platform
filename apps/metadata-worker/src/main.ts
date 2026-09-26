import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  EventPublisher,
  FinalJobError,
  JobMessage,
  JobStore,
  JobType,
  StreamConsumer,
  WorkerKind,
  WorkerMetrics,
  WorkerStorage,
  s3ConfigFromEnv,
  startMetricsServer,
} from '@media-platform/shared';
import { MetadataResult, extractImageMetadata, extractVideoMetadata } from './processors/metadata-extract';

const REPLICA_ID = process.env.HOSTNAME ?? randomUUID().slice(0, 8);
const METRICS_PORT = parseInt(process.env.METRICS_PORT ?? '9100', 10);
const MAX_ATTEMPTS = 3;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ service: 'metadata-worker', ...fields }));
}

async function main() {
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL') });
  const redis = new Redis(requireEnv('REDIS_URL'));
  const jobStore = new JobStore(pool, new EventPublisher(redis));
  const storage = new WorkerStorage(s3ConfigFromEnv());
  const metrics = new WorkerMetrics();

  let ready = false;
  startMetricsServer(metrics, METRICS_PORT, () => ready);

  /** Images are small enough to process from memory; videos can be up to
   * 5 GiB so they are streamed to a temp file and probed in place. */
  async function extract(message: JobMessage): Promise<MetadataResult> {
    const key = message.params.originalStorageKey;
    if (typeof key !== 'string') throw new Error('job message missing params.originalStorageKey');
    if (message.params.kind === 'VIDEO') {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-worker-'));
      try {
        const file = path.join(dir, `in-${randomUUID()}`);
        await storage.downloadToFile(key, file);
        return await extractVideoMetadata(file);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
    return extractImageMetadata(await storage.downloadToBuffer(key));
  }

  const handler = async (message: JobMessage, streamEntryId: string) => {
    metrics.activeJobs.inc();
    const timer = metrics.processingDuration.startTimer({ job_type: message.type });
    log({ level: 'info', jobId: message.jobId, assetId: message.assetId, msg: 'processing started', attempt: message.attempt });

    try {
      if (message.type !== JobType.METADATA_EXTRACT) throw new Error(`metadata-worker cannot handle job type ${message.type}`);
      await jobStore.markProcessing(message.jobId, streamEntryId);
      const result = await extract(message);
      await jobStore.completeMetadataJob({ jobId: message.jobId, assetId: message.assetId, ...result });
      metrics.jobsCompleted.inc({ job_type: message.type });
      log({ level: 'info', jobId: message.jobId, assetId: message.assetId, msg: 'processing completed' });
    } catch (err) {
      const error = err as Error;
      log({ level: 'error', jobId: message.jobId, assetId: message.assetId, error: error.message });
      const outcome = await jobStore.failJob(message.jobId, message.attempt, MAX_ATTEMPTS, error.message);
      metrics.jobsFailed.inc({ job_type: message.type, outcome: outcome === 'DEAD_LETTER' ? 'dead_letter' : 'retry' });
      if (outcome === 'DEAD_LETTER') throw new FinalJobError(error.message);
    } finally {
      timer();
      metrics.activeJobs.dec();
    }
  };

  const consumer = new StreamConsumer(redis, WorkerKind.METADATA, REPLICA_ID, handler, async (message, err) => {
    log({ level: 'warn', jobId: message.jobId, msg: 'unrecoverable handler error, leaving for reclaim', error: err.message });
  });

  ready = true;
  log({ level: 'info', msg: `starting consumer replica ${REPLICA_ID}` });

  const shutdown = async () => {
    log({ level: 'info', msg: 'shutting down' });
    consumer.stop();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await consumer.start();
}

main().catch((err) => {
  console.error('metadata-worker failed to start', err);
  process.exit(1);
});
