import { randomUUID } from "crypto";
import { Pool } from "pg";
import Redis from "ioredis";
import {
  EventPublisher,
  FinalJobError,
  JobMessage,
  JobStore,
  StreamConsumer,
  WorkerKind,
  WorkerMetrics,
  WorkerStorage,
  s3ConfigFromEnv,
  startMetricsServer,
} from "@media-platform/shared";
import { transform } from "./processors/image-transform";

const REPLICA_ID = process.env.HOSTNAME ?? randomUUID().slice(0, 8);
const METRICS_PORT = parseInt(process.env.METRICS_PORT ?? "9100", 10);

async function main() {
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  const redis = new Redis(requireEnv("REDIS_URL"));
  const jobStore = new JobStore(pool, new EventPublisher(redis));
  const storage = new WorkerStorage(s3ConfigFromEnv());
  const metrics = new WorkerMetrics();

  let ready = false;
  startMetricsServer(metrics, METRICS_PORT, () => ready);

  const handler = async (message: JobMessage, streamEntryId: string) => {
    metrics.activeJobs.inc();
    const timer = metrics.processingDuration.startTimer({
      job_type: message.type,
    });
    console.log(
      JSON.stringify({
        level: "info",
        service: "image-worker",
        jobId: message.jobId,
        assetId: message.assetId,
        msg: "processing started",
        attempt: message.attempt,
      }),
    );

    try {
      await jobStore.markProcessing(message.jobId, streamEntryId);
      const original = await storage.downloadToBuffer(originalKeyFor(message));
      const result = await transform(message.type, original, message.params);
      const storageKey = storage.variantKey(
        message.assetId,
        result.variantName,
      );
      await storage.upload(storageKey, result.buffer, result.mimeType);
      await jobStore.completeJob({
        jobId: message.jobId,
        assetId: message.assetId,
        type: message.type,
        storageKey,
        mimeType: result.mimeType,
        fileSize: result.buffer.byteLength,
        width: result.width,
        height: result.height,
      });
      metrics.jobsCompleted.inc({ job_type: message.type });
      console.log(
        JSON.stringify({
          level: "info",
          service: "image-worker",
          jobId: message.jobId,
          assetId: message.assetId,
          msg: "processing completed",
        }),
      );
    } catch (err) {
      const error = err as Error;
      console.log(
        JSON.stringify({
          level: "error",
          service: "image-worker",
          jobId: message.jobId,
          assetId: message.assetId,
          error: error.message,
        }),
      );
      const maxAttempts = 3; // mirrors MAX_JOB_ATTEMPTS; job row also carries its own maxAttempts column as override
      const outcome = await jobStore.failJob(
        message.jobId,
        message.attempt,
        maxAttempts,
        error.message,
      );
      metrics.jobsFailed.inc({
        job_type: message.type,
        outcome: outcome === "DEAD_LETTER" ? "dead_letter" : "retry",
      });
      if (outcome === "DEAD_LETTER") {
        throw new FinalJobError(error.message);
      }
      // RETRY: fall through and return normally so the stream entry is
      // ACKed — redelivery happens via a brand-new message from the
      // API's retry sweep, not by replaying this one. See consumer-loop.ts.
    } finally {
      timer();
      metrics.activeJobs.dec();
    }
  };

  const consumer = new StreamConsumer(
    redis,
    WorkerKind.IMAGE,
    REPLICA_ID,
    handler,
    async (message, err) => {
      console.log(
        JSON.stringify({
          level: "warn",
          service: "image-worker",
          jobId: message.jobId,
          msg: "unrecoverable handler error, leaving for reclaim",
          error: err.message,
        }),
      );
    },
  );

  ready = true;
  console.log(
    JSON.stringify({
      level: "info",
      service: "image-worker",
      msg: `starting consumer replica ${REPLICA_ID}`,
    }),
  );

  const shutdown = async () => {
    console.log(
      JSON.stringify({
        level: "info",
        service: "image-worker",
        msg: "shutting down",
      }),
    );
    consumer.stop();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await consumer.start();
}

// Original asset uploads live at uploads/{ownerId}/{uuid}-{filename}; the
// worker doesn't know the ownerId from the job message alone (kept
// deliberately minimal — see docs/decisions.md), so params.originalStorageKey
// is threaded through by the API at enqueue time instead of reconstructed here.
function originalKeyFor(message: JobMessage): string {
  const key = message.params.originalStorageKey;
  if (typeof key !== "string") {
    throw new Error("job message missing params.originalStorageKey");
  }
  return key;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

main().catch((err) => {
  console.error("image-worker failed to start", err);
  process.exit(1);
});
