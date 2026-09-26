import { AssetPresenter } from './asset.presenter';

const storage: any = { getPresignedDownloadUrl: jest.fn(async (key: string) => `https://s3/${key}`) };
const presenter = new AssetPresenter(storage);

const row = (over: Record<string, unknown> = {}): any => ({
  id: 'a1', ownerId: 'u1', fileName: 'x.jpg', title: null, description: null, mimeType: 'image/jpeg', kind: 'IMAGE',
  fileSize: 123n, storageKey: 'uploads/u1/x.jpg', status: 'READY', isFavorite: false, width: 10, height: 20, durationMs: null,
  dominantColor: '#aabbcc', capturedAt: null, metadata: { camera: 'X' }, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
  tags: [{ tag: { name: 'b' } }, { tag: { name: 'a' } }], variants: [], processingJobs: [], collections: [], ...over,
});
const variant = (type: string, key: string, extra: Record<string, unknown> = {}) => ({
  id: key, type, storageKey: `variants/a1/${key}`, mimeType: 'image/jpeg', fileSize: 5n, width: null, height: null, durationMs: null, createdAt: new Date(), ...extra,
});

describe('AssetPresenter (the JSON contract the frontend depends on)', () => {
  it('list item: converts bigint size to a number, sorts tags, exposes thumbnail + clip URLs', async () => {
    const out = await presenter.listItem(row({ variants: [variant('IMAGE_THUMBNAIL', 'thumb.jpg'), variant('VIDEO_PREVIEW', 'preview_5s.mp4')] }));
    expect(out.fileSize).toBe(123);
    expect(out.tags).toEqual(['a', 'b']);
    expect(out.thumbnailUrl).toBe('https://s3/variants/a1/thumb.jpg');
    expect(out.clipUrl).toBe('https://s3/variants/a1/preview_5s.mp4');
    expect(JSON.stringify(out)).not.toMatch(/\d+n"/); // JSON.stringify would throw on a raw bigint anyway
  });

  it('pipeline progress is null once READY, and counts job states while working', async () => {
    expect((await presenter.listItem(row())).pipeline).toBeNull();
    const jobs = ['COMPLETED', 'COMPLETED', 'PROCESSING', 'DEAD_LETTER', 'PENDING'].map((status) => ({ status }));
    const out = await presenter.listItem(row({ status: 'PROCESSING', processingJobs: jobs }));
    expect(out.pipeline).toEqual({ total: 5, done: 2, running: 1, failed: 1 });
  });

  it('detail: variants keep the historical `downloadUrl` field and carry a display name', async () => {
    const out = await presenter.detail(row({ variants: [variant('IMAGE_COMPRESS', 'compressed_q80.jpg')] }));
    expect(out.variants[0]).toMatchObject({ name: 'compressed_q80.jpg', downloadUrl: 'https://s3/variants/a1/compressed_q80.jpg', fileSize: 5 });
    expect(out.originalUrl).toBe('https://s3/uploads/u1/x.jpg');
    expect(out.metadata).toEqual({ camera: 'X' });
  });

  it('detail: previewUrl is the WIDEST resized rendition, falling back to the compressed one', async () => {
    const small = variant('IMAGE_RESIZE', 'resize_800w.jpg', { width: 800 });
    const big = variant('IMAGE_RESIZE', 'resize_1600w.jpg', { width: 1600 });
    expect((await presenter.detail(row({ variants: [small, big] }))).previewUrl).toBe('https://s3/variants/a1/resize_1600w.jpg');
    expect((await presenter.detail(row({ variants: [variant('IMAGE_COMPRESS', 'c.jpg')] }))).previewUrl).toBe('https://s3/variants/a1/c.jpg');
    expect((await presenter.detail(row({ variants: [] }))).previewUrl).toBeNull();
  });

  it('videos never get an image previewUrl', async () => {
    const out = await presenter.detail(row({ kind: 'VIDEO', variants: [variant('IMAGE_RESIZE', 'r.jpg', { width: 9 })] }));
    expect(out.previewUrl).toBeNull();
  });
});
