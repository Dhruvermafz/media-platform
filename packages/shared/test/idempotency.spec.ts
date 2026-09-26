import { computeIdempotencyKey } from '../src/idempotency';
import { JobType } from '../src/enums';

describe('computeIdempotencyKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeIdempotencyKey('asset-1', JobType.IMAGE_THUMBNAIL, { width: 320, height: 320 });
    const b = computeIdempotencyKey('asset-1', JobType.IMAGE_THUMBNAIL, { width: 320, height: 320 });
    expect(a).toBe(b);
  });

  it('is insensitive to parameter key ordering', () => {
    const a = computeIdempotencyKey('asset-1', JobType.IMAGE_RESIZE, { width: 480, height: 270 });
    const b = computeIdempotencyKey('asset-1', JobType.IMAGE_RESIZE, { height: 270, width: 480 });
    expect(a).toBe(b);
  });

  it('differs when the asset differs', () => {
    const a = computeIdempotencyKey('asset-1', JobType.IMAGE_THUMBNAIL, { width: 320 });
    const b = computeIdempotencyKey('asset-2', JobType.IMAGE_THUMBNAIL, { width: 320 });
    expect(a).not.toBe(b);
  });

  it('differs when the transformation type differs', () => {
    const a = computeIdempotencyKey('asset-1', JobType.IMAGE_THUMBNAIL, { width: 320 });
    const b = computeIdempotencyKey('asset-1', JobType.IMAGE_RESIZE, { width: 320 });
    expect(a).not.toBe(b);
  });

  it('differs when parameters differ', () => {
    const a = computeIdempotencyKey('asset-1', JobType.IMAGE_COMPRESS, { quality: 80 });
    const b = computeIdempotencyKey('asset-1', JobType.IMAGE_COMPRESS, { quality: 90 });
    expect(a).not.toBe(b);
  });

  it('produces a fixed-length hex hash regardless of input size', () => {
    const key = computeIdempotencyKey('asset-1', JobType.VIDEO_TRANSCODE, {
      resolution: '720p',
      originalStorageKey: 'uploads/user-1/some-very-long-filename-with-many-characters.mp4',
    });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
