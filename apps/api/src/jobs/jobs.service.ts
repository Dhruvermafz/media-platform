import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AssetStatus, JobStatus } from '@media-platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import { JobProducerService } from '../queue/job-producer.service';
import { EventsService } from '../events/events.service';

const RETRYABLE_STATUSES: JobStatus[] = [JobStatus.FAILED, JobStatus.DEAD_LETTER];

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: JobProducerService,
    private readonly events: EventsService,
  ) {}

  async findForAsset(userId: string, assetId: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.ownerId !== userId) throw new NotFoundException('Asset not found');
    return this.prisma.processingJob.findMany({ where: { assetId }, orderBy: { createdAt: 'asc' } });
  }

  /** The caller's recent jobs across all assets (powers the Processing page). */
  async list(userId: string, opts: { status?: JobStatus; limit?: number }) {
    const take = Math.min(200, Math.max(1, opts.limit ?? 50));
    const where = { asset: { ownerId: userId }, ...(opts.status ? { status: opts.status } : {}) };
    const [items, grouped] = await Promise.all([
      this.prisma.processingJob.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take,
        include: { asset: { select: { id: true, fileName: true, title: true, kind: true, deletedAt: true } } },
      }),
      this.prisma.processingJob.groupBy({ by: ['status'], where: { asset: { ownerId: userId } }, _count: true }),
    ]);
    return { items, counts: Object.fromEntries(grouped.map((g) => [g.status, g._count])) };
  }

  async findOne(userId: string, jobId: string, opts: { admin?: boolean } = {}) {
    const job = await this.prisma.processingJob.findUnique({ where: { id: jobId }, include: { asset: true } });
    if (!job) throw new NotFoundException('Job not found');
    if (!opts.admin && job.asset.ownerId !== userId) throw new ForbiddenException();
    return job;
  }

  /**
   * Manual retry, distinct from the automatic RETRY -> PENDING sweep in
   * RetrySchedulerService. This is an operator/user action from the
   * admin dashboard's "retry" button, so it's allowed even from
   * DEAD_LETTER (where the automatic path has given up). It always
   * resets the attempt counter to 1: a human clicking retry is asserting
   * "try again from scratch", not "resume the same backoff sequence".
   * Admins may retry any user's job (`opts.admin`, set only by the
   * role-guarded admin route).
   */
  async retry(userId: string, jobId: string, opts: { admin?: boolean } = {}) {
    const job = await this.findOne(userId, jobId, opts);
    if (!RETRYABLE_STATUSES.includes(job.status as JobStatus)) {
      throw new BadRequestException(
        `Job is ${job.status}; only FAILED or DEAD_LETTER jobs can be manually retried`,
      );
    }
    const updated = await this.prisma.processingJob.update({
      where: { id: jobId },
      data: { status: JobStatus.PENDING, attempt: 0, failureReason: null },
    });
    await this.producer.publish(updated, 1);
    // The asset is FAILED because this job dead-lettered; show it as
    // PROCESSING again while the retry runs (it is recomputed on completion).
    await this.prisma.asset.updateMany({
      where: { id: job.assetId, status: AssetStatus.FAILED },
      data: { status: AssetStatus.PROCESSING },
    });
    await this.events.publish(job.asset.ownerId, {
      type: 'job.updated', assetId: job.assetId, jobId, jobType: job.type, status: JobStatus.PENDING,
    });
    return updated;
  }
}
