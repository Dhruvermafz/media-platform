import { BadRequestException, GoneException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { SharesService } from './shares.service';

function build(link: any, redisOver: Record<string, any> = {}) {
  const prisma: any = {
    shareLink: { findUnique: jest.fn().mockResolvedValue(link), update: jest.fn().mockResolvedValue({}), create: jest.fn() },
    asset: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    collection: { findFirst: jest.fn(), findUniqueOrThrow: jest.fn() },
    collectionAsset: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const redis: any = { client: { get: jest.fn().mockResolvedValue('0'), incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1), ...redisOver } };
  const svc = new SharesService(prisma, redis, {} as any, {} as any, { log: jest.fn() } as any, { publish: jest.fn() } as any);
  return { svc, prisma, redis };
}
const live = { id: 'l1', token: 't', assetId: 'a1', collectionId: null, passwordHash: null, allowDownload: true, expiresAt: null, revokedAt: null };

describe('SharesService.view', () => {
  it('404s for an unknown token and for a revoked one (indistinguishable)', async () => {
    await expect(build(null).svc.view('x', undefined, '1.1.1.1')).rejects.toThrow(NotFoundException);
    await expect(build({ ...live, revokedAt: new Date() }).svc.view('t', undefined, '1.1.1.1')).rejects.toThrow(NotFoundException);
  });
  it('410s once expired', async () => {
    const { svc } = build({ ...live, expiresAt: new Date(Date.now() - 1000) });
    await expect(svc.view('t', undefined, '1.1.1.1')).rejects.toThrow(GoneException);
  });
  it('asks for a password with a machine-readable code, without touching the database for content', async () => {
    const passwordHash = await bcrypt.hash('secret', 4);
    const { svc, prisma } = build({ ...live, passwordHash });
    await expect(svc.view('t', undefined, '1.1.1.1')).rejects.toMatchObject({ response: { code: 'PASSWORD_REQUIRED' } });
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });
  it('rejects a wrong password and counts the failure', async () => {
    const passwordHash = await bcrypt.hash('secret', 4);
    const { svc, redis } = build({ ...live, passwordHash });
    await expect(svc.view('t', 'nope', '9.9.9.9')).rejects.toThrow(UnauthorizedException);
    expect(redis.client.incr).toHaveBeenCalledWith('share:pwfail:t:9.9.9.9');
    expect(redis.client.expire).toHaveBeenCalled();
  });
  it('locks out an IP after 10 wrong passwords (429), even for the right password', async () => {
    const passwordHash = await bcrypt.hash('secret', 4);
    const { svc } = build({ ...live, passwordHash }, { get: jest.fn().mockResolvedValue('10') });
    const err = await svc.view('t', 'secret', '9.9.9.9').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
  });
});

describe('SharesService.create', () => {
  it('requires exactly one target', async () => {
    const { svc } = build(null);
    await expect(svc.create('u1', {})).rejects.toThrow(BadRequestException);
    await expect(svc.create('u1', { assetId: 'a', collectionId: 'c' })).rejects.toThrow(BadRequestException);
  });
  it('will not share an asset the caller does not own (or that is trashed)', async () => {
    const { svc, prisma } = build(null);
    prisma.asset.findFirst.mockResolvedValue(null);
    await expect(svc.create('u1', { assetId: 'a1' })).rejects.toThrow(NotFoundException);
    expect(prisma.asset.findFirst).toHaveBeenCalledWith({ where: { id: 'a1', ownerId: 'u1', deletedAt: null } });
  });
  it('stores only a hash of the password and a long random token', async () => {
    const { svc, prisma } = build(null);
    prisma.asset.findFirst.mockResolvedValue({ id: 'a1', fileName: 'f.png', title: null });
    prisma.shareLink.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'l', viewCount: 0, createdAt: new Date(), revokedAt: null, lastViewedAt: null, expiresAt: data.expiresAt, allowDownload: true, ...data }));
    const out = await svc.create('u1', { assetId: 'a1', password: 'hunter22', expiresInHours: 2 });
    const data = prisma.shareLink.create.mock.calls[0][0].data;
    expect(data.passwordHash).not.toContain('hunter22');
    expect(await bcrypt.compare('hunter22', data.passwordHash)).toBe(true);
    expect(data.token.length).toBeGreaterThanOrEqual(32);
    expect(out.hasPassword).toBe(true);
    expect(JSON.stringify(out)).not.toContain('hunter22');
    expect(out).not.toHaveProperty('passwordHash');
  });
});
