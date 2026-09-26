import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ProcessingJob } from '@prisma/client';
import {
  JOB_TYPE_TO_WORKER,
  JobMessage,
  JobType,
  MAX_JOB_ATTEMPTS,
  computeIdempotencyKey,
  streamKeyFor,
} from '@media-platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from './redis.service';

@Injectable()
export class JobProducerService {
  private readonly logger = new Logger(JobProducerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Creates the processing_jobs row (source of truth for state) and then
   * publishes to the worker's Redis Stream. If a job for this exact
   * (assetId, transformation) already exists — e.g. the API handler is
   * hit twice for the same upload — the unique constraint on
   * (assetId, idempotencyKey) makes this a no-op that returns the
   * existing row instead of enqueueing a duplicate.
   */
  async enqueue(assetId: string, type: JobType, params: Record<string, unknown> = {}): Promise<ProcessingJob> {
    const idempotencyKey = computeIdempotencyKey(assetId, type, params);

    let job: ProcessingJob;
    let created = true;
    try {
      job = await this.prisma.processingJob.create({
        data: {
          assetId,
          type,
          params,
          idempotencyKey,
          maxAttempts: MAX_JOB_ATTEMPTS,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        created = false;
        job = await this.prisma.processingJob.findUniqueOrThrow({
          where: { assetId_idempotencyKey: { assetId, idempotencyKey } },
        });
        this.logger.log(`Job for ${assetId}/${type} already exists (${job.id}); skipping duplicate enqueue`);
      } else {
        throw err;
      }
    }

    if (created) {
      await this.publish(job, 1);
    }
    return job;
  }

  /** Publishes (or republishes, on retry) one attempt of a job onto its
   * worker's stream. `attempt` is passed explicitly rather than read off
   * the row so a retry scheduler can bump it in the same transaction that
   * flips status back to PENDING. */
  async publish(job: ProcessingJob, attempt: number): Promise<void> {
    const worker = JOB_TYPE_TO_WORKER[job.type as JobType];
    const message: JobMessage = {
      jobId: job.id,
      assetId: job.assetId,
      type: job.type as JobType,
      attempt,
      idempotencyKey: job.idempotencyKey,
      params: (job.params as Record<string, unknown>) ?? {},
      createdAt: job.createdAt.toISOString(),
    };
    await this.redis.client.xadd(streamKeyFor(worker), '*', 'payload', JSON.stringify(message));
    this.logger.log(`Enqueued ${job.type} job ${job.id} for asset ${job.assetId} (attempt ${attempt})`);
  }
}
