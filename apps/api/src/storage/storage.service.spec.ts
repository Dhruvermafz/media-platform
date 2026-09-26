import { StorageService, contentDisposition } from './storage.service';

function build(publicEndpoint = 'http://localhost:9000') {
  const config: any = { get: (k: string) => (k === 's3' ? { endpoint: 'http://minio:9000', publicEndpoint, region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b', bucket: 'bkt', forcePathStyle: true } : 'test') };
  return new StorageService(config);
}

describe('StorageService presigned URLs', () => {
  it('signs against the browser-reachable endpoint, not the internal one', async () => {
    const { url } = await build().getPresignedUploadUrl('uploads/u/x.png', 'image/png');
    expect(url.startsWith('http://localhost:9000/bkt/uploads/u/x.png')).toBe(true);
    expect(url).not.toContain('minio');
  });

  it('returns an identical download URL for repeated calls inside a signing bucket (so browsers can cache)', async () => {
    const s = build();
    const a = await s.getPresignedDownloadUrl('variants/a/thumb.jpg');
    await new Promise((r) => setTimeout(r, 1100)); // different wall-clock second, same 30-min bucket (barring a boundary)
    const b = await s.getPresignedDownloadUrl('variants/a/thumb.jpg');
    const strip = (u: string) => u.replace(/X-Amz-Signature=[^&]+/, '');
    // Boundary-safe: if a 30-minute boundary fell inside the sleep, X-Amz-Date legitimately differs.
    if (new URL(a).searchParams.get('X-Amz-Date') === new URL(b).searchParams.get('X-Amz-Date')) expect(a).toBe(b);
    expect(strip(a)).toContain('X-Amz-Expires=10800');
  });

  it('adds an attachment disposition only when asked', async () => {
    const s = build();
    expect(await s.getPresignedDownloadUrl('k')).not.toContain('response-content-disposition');
    expect(decodeURIComponent(await s.getPresignedDownloadUrl('k', { attachmentFileName: 'a b.png' }))).toContain('attachment; filename="a b.png"');
  });
});

describe('contentDisposition', () => {
  it('escapes quotes and keeps a UTF-8 filename* for non-ASCII names', () => {
    const h = contentDisposition('Réunion "été".mp4');
    expect(h).toContain('filename="R_union __t__.mp4"');
    expect(h).toContain("filename*=UTF-8''R%C3%A9union%20%22%C3%A9t%C3%A9%22.mp4");
  });
});
