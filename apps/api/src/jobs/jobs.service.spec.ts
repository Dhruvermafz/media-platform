import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JobStatus } from '@media-platform/shared';
import { JobsService } from './jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { JobProducerService } from '../queue/job-producer.service';

describe('JobsService', () => {
  let service: JobsService;
  let prisma: { processingJob: { findUnique: jest.Mock; update: jest.Mock } };
  let producer: { publish: jest.Mock };

  beforeEach(() => {
    prisma = { processingJob: { findUnique: jest.fn(), update: jest.fn() } };
    producer = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new JobsService(prisma as unknown as PrismaService, producer as unknown as JobProducerService);
  });

  function withJob(overrides: Partial<{ status: JobStatus; ownerId: string }> = {}) {
    prisma.processingJob.findUnique.mockResolvedValue({
      id: 'job-1',
      status: overrides.status ?? JobStatus.FAILED,
      attempt: 3,
      asset: { ownerId: overrides.ownerId ?? 'user-1' },
    });
  }

  it('throws NotFoundException when the job does not exist', async () => {
    prisma.processingJob.findUnique.mockResolvedValue(null);
    await expect(service.retry('user-1', 'missing-job')).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when the job belongs to a different user', async () => {
    withJob({ ownerId: 'someone-else' });
    await expect(service.retry('user-1', 'job-1')).rejects.toThrow(ForbiddenException);
  });

  it.each([JobStatus.PENDING, JobStatus.PROCESSING, JobStatus.COMPLETED, JobStatus.RETRY])(
    'rejects retry when status is %s (only FAILED/DEAD_LETTER are retryable)',
    async (status) => {
      withJob({ status });
      await expect(service.retry('user-1', 'job-1')).rejects.toThrow(BadRequestException);
      expect(producer.publish).not.toHaveBeenCalled();
    },
  );

  it.each([JobStatus.FAILED, JobStatus.DEAD_LETTER])(
    'allows retry from %s and resets attempt to 0 before publishing as attempt 1',
    async (status) => {
      withJob({ status });
      prisma.processingJob.update.mockResolvedValue({ id: 'job-1', status: JobStatus.PENDING, attempt: 0 });

      await service.retry('user-1', 'job-1');

      expect(prisma.processingJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: JobStatus.PENDING, attempt: 0, failureReason: null },
      });
      expect(producer.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), 1);
    },
  );
});
