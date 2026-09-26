import { Prisma } from '@prisma/client';
import { JobType } from '@media-platform/shared';
import { JobProducerService } from './job-producer.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from './redis.service';

function makePrismaUniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.19.1',
  });
}

describe('JobProducerService', () => {
  let service: JobProducerService;
  let prisma: {
    processingJob: { create: jest.Mock; findUniqueOrThrow: jest.Mock };
  };
  let redis: { client: { xadd: jest.Mock } };

  beforeEach(() => {
    prisma = { processingJob: { create: jest.fn(), findUniqueOrThrow: jest.fn() } };
    redis = { client: { xadd: jest.fn().mockResolvedValue('1-0') } };
    service = new JobProducerService(prisma as unknown as PrismaService, redis as unknown as RedisService);
  });

  it('creates a new job and publishes it once when no conflict exists', async () => {
    const job = {
      id: 'job-1',
      assetId: 'asset-1',
      type: JobType.IMAGE_THUMBNAIL,
      params: { width: 320 },
      idempotencyKey: 'abc123',
      createdAt: new Date(),
    };
    prisma.processingJob.create.mockResolvedValue(job);

    const result = await service.enqueue('asset-1', JobType.IMAGE_THUMBNAIL, { width: 320 });

    expect(result).toEqual(job);
    expect(redis.client.xadd).toHaveBeenCalledTimes(1);
    // Routed onto the image-worker's stream, not just any stream.
    expect(redis.client.xadd.mock.calls[0][0]).toContain('image-worker');
  });

  it('returns the existing job and does NOT re-publish when the same transformation is enqueued twice', async () => {
    const existingJob = {
      id: 'job-1',
      assetId: 'asset-1',
      type: JobType.IMAGE_THUMBNAIL,
      params: { width: 320 },
      idempotencyKey: 'abc123',
      createdAt: new Date(),
    };
    prisma.processingJob.create.mockRejectedValue(makePrismaUniqueViolation());
    prisma.processingJob.findUniqueOrThrow.mockResolvedValue(existingJob);

    const result = await service.enqueue('asset-1', JobType.IMAGE_THUMBNAIL, { width: 320 });

    expect(result).toEqual(existingJob);
    // The whole point of the idempotency guarantee: a duplicate enqueue
    // must never result in a second stream message for the same job.
    expect(redis.client.xadd).not.toHaveBeenCalled();
  });

  it('propagates non-conflict database errors instead of swallowing them', async () => {
    prisma.processingJob.create.mockRejectedValue(new Error('connection refused'));
    await expect(service.enqueue('asset-1', JobType.IMAGE_THUMBNAIL, { width: 320 })).rejects.toThrow(
      'connection refused',
    );
    expect(redis.client.xadd).not.toHaveBeenCalled();
  });
});
