import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobStatus } from '@media-platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import { JobProducerService } from './job-producer.service';

/**
 * Workers never call setTimeout for backoff themselves — a worker
 * process can crash during that sleep and the delay is lost. Instead a
 * failed attempt is written to Postgres as RETRY with `scheduledAt` set
 * to now + backoff(attempt), and this sweep (running in the API, which
 * is easy to keep replicated/HA) republishes anything whose delay has
 * elapsed. Durable retry state survives worker crashes and API restarts
 * alike.
 */
@Injectable()
export class RetrySchedulerService {
  private readonly logger = new Logger(RetrySchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: JobProducerService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async sweep() {
    const due = await this.prisma.processingJob.findMany({
      where: { status: JobStatus.RETRY, scheduledAt: { lte: new Date() } },
      take: 50,
    });
    for (const job of due) {
      // PENDING here means "eligible to be picked up again"; PROCESSING
      // is set by the worker itself when it actually starts the attempt.
      await this.prisma.processingJob.update({
        where: { id: job.id },
        data: { status: JobStatus.PENDING },
      });
      await this.producer.publish(job, job.attempt + 1);
      this.logger.log(`Requeued job ${job.id} for retry (attempt ${job.attempt + 1})`);
    }
  }
}
