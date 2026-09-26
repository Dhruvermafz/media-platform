import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { AssetKind, JobType } from '@media-platform/shared';
import { AssetsService, buildAssetWhere, defaultJobsFor, normalizeTags } from './assets.service';
import { sanitizeVariantParams } from './dto/create-variant.dto';

describe('normalizeTags', () => {
  it('trims, lower-cases, strips #, collapses spaces and de-duplicates', () => {
    expect(normalizeTags(['  Beach ', '#beach', 'SUMMER  trip', ''])).toEqual(['beach', 'summer trip']);
  });
  it('rejects commas and over-long tags', () => {
    expect(() => normalizeTags(['a,b'])).toThrow(BadRequestException);
    expect(() => normalizeTags(['x'.repeat(33)])).toThrow(BadRequestException);
  });
  it('caps the list at 20 tags', () => {
    expect(normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(20);
  });
});

describe('buildAssetWhere', () => {
  it('always scopes to the owner and excludes trash by default', () => {
    expect(buildAssetWhere('u1', {})).toEqual({ ownerId: 'u1', deletedAt: null });
  });
  it('lists only trash when trashed=true', () => {
    expect(buildAssetWhere('u1', { trashed: 'true' }).deletedAt).toEqual({ not: null });
  });
  it('treats the string "false" as false (not truthy)', () => {
    const w = buildAssetWhere('u1', { favorite: 'false', trashed: 'false' });
    expect(w).toEqual({ ownerId: 'u1', deletedAt: null });
  });
  it('combines filters and searches name, title, description and tags', () => {
    const w = buildAssetWhere('u1', { kind: 'VIDEO', favorite: 'true', tag: ' Beach ', q: ' Sun ' });
    expect(w).toMatchObject({ kind: 'VIDEO', isFavorite: true, tags: { some: { tag: { name: 'beach' } } } });
    expect((w.OR as unknown[]).length).toBe(4);
  });
});

describe('defaultJobsFor', () => {
  it('images get thumbnail, viewer resize, compress and metadata; every job carries the source key', () => {
    const jobs = defaultJobsFor(AssetKind.IMAGE, 'uploads/u/k.png');
    expect(jobs.map((j) => j.type)).toEqual([JobType.IMAGE_THUMBNAIL, JobType.IMAGE_RESIZE, JobType.IMAGE_COMPRESS, JobType.METADATA_EXTRACT]);
    expect(jobs.every((j) => j.params.originalStorageKey === 'uploads/u/k.png')).toBe(true);
  });
  it('videos get thumbnail, 2 transcodes, hover preview and metadata', () => {
    const types = defaultJobsFor(AssetKind.VIDEO, 'k').map((j) => j.type);
    expect(types.filter((t) => t === JobType.VIDEO_TRANSCODE)).toHaveLength(2);
    expect(types).toContain(JobType.VIDEO_PREVIEW);
    expect(types).toContain(JobType.METADATA_EXTRACT);
  });
});

describe('sanitizeVariantParams', () => {
  it('applies defaults and strips unknown keys', () => {
    expect(sanitizeVariantParams('IMAGE_RESIZE', { evil: 1 })).toEqual({ width: 1024 });
    expect(sanitizeVariantParams('IMAGE_FORMAT_CONVERT', {})).toEqual({ format: 'webp' });
  });
  it.each([
    ['IMAGE_RESIZE', { width: 5 }],
    ['IMAGE_RESIZE', { width: 99999 }],
    ['IMAGE_COMPRESS', { quality: 'x' }],
    ['IMAGE_FORMAT_CONVERT', { format: 'bmp' }],
    ['VIDEO_TRANSCODE', { resolution: '4k' }],
    ['VIDEO_PREVIEW', { durationSeconds: 600 }],
  ] as const)('rejects out-of-range %s %p (protects workers from absurd jobs)', (type, params) => {
    expect(() => sanitizeVariantParams(type, params)).toThrow(RangeError);
  });
});

describe('AssetsService.confirmUpload', () => {
  function build(overrides: Record<string, any> = {}) {
    const prisma: any = {
      asset: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'a1', storageKey: 'uploads/u1/x.png', fileName: 'x.png', fileSize: 10n }), findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'a1', tags: [], variants: [], processingJobs: [], fileSize: 10n }) },
      collection: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
      ...overrides.prisma,
    };
    const storage: any = { objectExists: jest.fn().mockResolvedValue({ exists: true, size: 10 }), deleteObject: jest.fn().mockResolvedValue(undefined) };
    const producer: any = { enqueue: jest.fn().mockResolvedValue({}) };
    const presenter: any = { listItem: jest.fn().mockResolvedValue({ id: 'a1' }) };
    const usage: any = { assertCanStore: jest.fn().mockResolvedValue(undefined), ...overrides.usage };
    const activity: any = { log: jest.fn() };
    const events: any = { publish: jest.fn() };
    const config: any = { get: () => ({ assetTtlSeconds: 30 }) };
    const svc = new AssetsService(prisma, storage, {} as any, producer, presenter, usage, activity, events, config);
    return { svc, prisma, storage, producer, usage, presenter };
  }
  const dto = { storageKey: 'uploads/u1/x.png', fileName: 'x.png', mimeType: 'image/png' };

  it('refuses a storageKey that belongs to another user before touching storage', async () => {
    const { svc, storage } = build();
    await expect(svc.confirmUpload('u2', dto)).rejects.toThrow(ForbiddenException);
    expect(storage.objectExists).not.toHaveBeenCalled();
  });

  it('is idempotent: confirming the same key twice does not enqueue jobs again', async () => {
    const { svc, prisma, producer } = build();
    prisma.asset.findFirst.mockResolvedValue({ id: 'existing', tags: [], variants: [] });
    await svc.confirmUpload('u1', dto);
    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(producer.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues the default image jobs for a fresh upload', async () => {
    const { svc, producer } = build();
    await svc.confirmUpload('u1', dto);
    expect(producer.enqueue).toHaveBeenCalledTimes(4);
  });

  it('deletes the object and rejects when the REAL size exceeds quota (client-declared size can lie)', async () => {
    const { svc, storage, prisma } = build({ usage: { assertCanStore: jest.fn().mockRejectedValue(new HttpException('quota', 413)) } });
    await expect(svc.confirmUpload('u1', dto)).rejects.toThrow(HttpException);
    expect(storage.deleteObject).toHaveBeenCalledWith('uploads/u1/x.png');
    expect(prisma.asset.create).not.toHaveBeenCalled();
  });
});

describe('AssetsService.requestVariant', () => {
  function build(kind: 'IMAGE' | 'VIDEO') {
    const prisma: any = {
      asset: { findUnique: jest.fn().mockResolvedValue({ id: 'a1', ownerId: 'u1', kind, storageKey: 'k', fileName: 'f' }), updateMany: jest.fn() },
      processingJob: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const producer: any = { enqueue: jest.fn().mockResolvedValue({ id: 'j1' }) };
    const svc = new AssetsService(prisma, {} as any, { client: { del: jest.fn().mockResolvedValue(1) } } as any, producer, {} as any, {} as any, { log: jest.fn() } as any, { publish: jest.fn() } as any, { get: () => ({ assetTtlSeconds: 1 }) } as any);
    return { svc, producer, prisma };
  }
  it('rejects a video job on an image', async () => {
    const { svc, producer } = build('IMAGE');
    await expect(svc.requestVariant('u1', 'a1', { type: 'VIDEO_TRANSCODE' })).rejects.toThrow(BadRequestException);
    expect(producer.enqueue).not.toHaveBeenCalled();
  });
  it('rejects invalid params with 400 rather than enqueueing a bad job', async () => {
    const { svc } = build('IMAGE');
    await expect(svc.requestVariant('u1', 'a1', { type: 'IMAGE_RESIZE', params: { width: 1 } })).rejects.toThrow(BadRequestException);
  });
  it('returns the existing job (created:false) for a duplicate request', async () => {
    const { svc, prisma, producer } = build('IMAGE');
    prisma.processingJob.findUnique.mockResolvedValue({ id: 'old' });
    const res = await svc.requestVariant('u1', 'a1', { type: 'IMAGE_RESIZE', params: { width: 800 } });
    expect(res).toEqual({ job: { id: 'old' }, created: false });
    expect(producer.enqueue).not.toHaveBeenCalled();
  });
  it('enqueues a new job and pins the source key into params', async () => {
    const { svc, producer } = build('IMAGE');
    const res = await svc.requestVariant('u1', 'a1', { type: 'IMAGE_RESIZE', params: { width: 800 } });
    expect(res.created).toBe(true);
    expect(producer.enqueue).toHaveBeenCalledWith('a1', 'IMAGE_RESIZE', { width: 800, originalStorageKey: 'k' });
  });
});
