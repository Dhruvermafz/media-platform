import { CleanupService } from './cleanup.service';

const cfg = { enabled: true, trashRetentionDays: 30, orphanUploadTtlHours: 24 };
function build() {
  const prisma: any = { asset: { findMany: jest.fn() } };
  const storage: any = { listObjects: jest.fn(), deleteObject: jest.fn().mockResolvedValue(undefined) };
  const redis: any = { client: { set: jest.fn() } };
  const assets: any = { purge: jest.fn().mockResolvedValue(undefined) };
  const svc = new CleanupService(prisma, storage, redis, assets, { get: () => cfg } as any);
  return { svc, prisma, storage, redis, assets };
}

describe('CleanupService.purgeExpiredTrash', () => {
  it('purges assets trashed before the retention cutoff, in batches, until none remain', async () => {
    const { svc, prisma, assets } = build();
    const now = new Date('2026-09-20T00:00:00Z');
    prisma.asset.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]).mockResolvedValueOnce([]);
    expect(await svc.purgeExpiredTrash(now)).toBe(2);
    expect(assets.purge).toHaveBeenCalledTimes(2);
    const where = prisma.asset.findMany.mock.calls[0][0].where;
    expect(where.deletedAt.lt).toEqual(new Date('2026-08-21T00:00:00Z'));
  });
});

describe('CleanupService.sweepOrphanUploads', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it('deletes only old objects that no asset row references', async () => {
    const { svc, prisma, storage } = build();
    storage.listObjects.mockResolvedValue({
      objects: [
        { key: 'uploads/u/known', size: 1, lastModified: hoursAgo(48) },
        { key: 'uploads/u/orphan', size: 1, lastModified: hoursAgo(48) },
        { key: 'uploads/u/in-flight', size: 1, lastModified: hoursAgo(1) },
      ],
    });
    prisma.asset.findMany.mockResolvedValue([{ storageKey: 'uploads/u/known' }]);
    expect(await svc.sweepOrphanUploads(now)).toBe(1);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith('uploads/u/orphan');
  });

  it('follows pagination tokens', async () => {
    const { svc, prisma, storage } = build();
    storage.listObjects
      .mockResolvedValueOnce({ objects: [{ key: 'uploads/1', size: 1, lastModified: hoursAgo(99) }], nextToken: 'n' })
      .mockResolvedValueOnce({ objects: [{ key: 'uploads/2', size: 1, lastModified: hoursAgo(99) }] });
    prisma.asset.findMany.mockResolvedValue([]);
    expect(await svc.sweepOrphanUploads(now)).toBe(2);
    expect(storage.listObjects).toHaveBeenCalledTimes(2);
  });
});

describe('CleanupService scheduling lock', () => {
  it('skips the run when another replica holds the lock', async () => {
    const { svc, redis, prisma } = build();
    redis.client.set.mockResolvedValue(null);
    await svc.scheduledTrashPurge();
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });
  it('runs when the lock is acquired', async () => {
    const { svc, redis, prisma } = build();
    redis.client.set.mockResolvedValue('OK');
    prisma.asset.findMany.mockResolvedValue([]);
    await svc.scheduledTrashPurge();
    expect(prisma.asset.findMany).toHaveBeenCalled();
  });
});
