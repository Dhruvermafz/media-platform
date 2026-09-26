import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { JobStatus } from '@media-platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import { JobProducerService } from '../queue/job-producer.service';

const RETRYABLE_STATUSES: JobStatus[] = [JobStatus.FAILED, JobStatus.DEAD_LETTER];

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: JobProducerService,
  ) {}

  async findForAsset(userId: string, assetId: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.ownerId !== userId) throw new NotFoundException('Asset not found');
    return this.prisma.processingJob.findMany({ where: { assetId }, orderBy: { createdAt: 'asc' } });
  }

  async findOne(userId: string, jobId: string) {
    const job = await this.prisma.processingJob.findUnique({ where: { id: jobId }, include: { asset: true } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.asset.ownerId !== userId) throw new ForbiddenException();
    return job;
  }

  /**
   * Manual retry, distinct from the automatic RETRY -> PENDING sweep in
   * RetrySchedulerService. This is an operator/user action from the
   * admin dashboard's "retry" button, so it's allowed even from
   * DEAD_LETTER (where the automatic path has given up). It always
   * resets the attempt counter to 1: a human clicking retry is asserting
   * "try again from scratch", not "resume the same backoff sequence".
   */
  async retry(userId: string, jobId: string) {
    const job = await this.findOne(userId, jobId);
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
    return updated;
  }
}
