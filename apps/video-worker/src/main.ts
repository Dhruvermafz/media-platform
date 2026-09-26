import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  FinalJobError,
  JobMessage,
  JobStore,
  StreamConsumer,
  WorkerKind,
  WorkerMetrics,
  WorkerStorage,
  s3ConfigFromEnv,
  startMetricsServer,
} from '@media-platform/shared';
import { transform } from './processors/video-transform';

const REPLICA_ID = process.env.HOSTNAME ?? randomUUID().slice(0, 8);
const METRICS_PORT = parseInt(process.env.METRICS_PORT ?? '9100', 10);
const MAX_ATTEMPTS = 3;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function originalKeyFor(message: JobMessage): string {
  const key = message.params.originalStorageKey;
  if (typeof key !== 'string') throw new Error('job message missing params.originalStorageKey');
  return key;
}

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ service: 'video-worker', ...fields }));
}

async function main() {
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL') });
  const redis = new Redis(requireEnv('REDIS_URL'));
  const jobStore = new JobStore(pool);
  const storage = new WorkerStorage(s3ConfigFromEnv());
  const metrics = new WorkerMetrics();

  let ready = false;
  startMetricsServer(metrics, METRICS_PORT, () => ready);

  const handler = async (message: JobMessage, streamEntryId: string) => {
    metrics.activeJobs.inc();
    const timer = metrics.processingDuration.startTimer({ job_type: message.type });
    log({ level: 'info', jobId: message.jobId, assetId: message.assetId, msg: 'processing started', attempt: message.attempt });

    try {
      await jobStore.markProcessing(message.jobId, streamEntryId);
      const original = await storage.downloadToBuffer(originalKeyFor(message));
      const result = await transform(message.type, original, message.params);
      const storageKey = storage.variantKey(message.assetId, result.variantName);
      await storage.upload(storageKey, result.buffer, result.mimeType);
      await jobStore.completeJob({
        jobId: message.jobId,
        assetId: message.assetId,
        type: message.type,
        storageKey,
        mimeType: result.mimeType,
        fileSize: result.buffer.byteLength,
        durationMs: result.durationMs,
      });
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

  const consumer = new StreamConsumer(redis, WorkerKind.VIDEO, REPLICA_ID, handler, async (message, err) => {
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
  console.error('video-worker failed to start', err);
  process.exit(1);
});
