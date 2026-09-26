import {
  BadRequestException, GoneException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../queue/redis.service';
import { ActivityService } from '../activity/activity.service';
import { EventsService } from '../events/events.service';
import { AssetPresenter, assetDetailInclude } from '../assets/asset.presenter';
import { StorageService } from '../storage/storage.service';
import { CreateShareDto } from './shares.dto';

const MAX_COLLECTION_ITEMS = 300;
const PASSWORD_FAIL_LIMIT = 10;
const PASSWORD_FAIL_WINDOW_SECONDS = 15 * 60;

@Injectable()
export class SharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly presenter: AssetPresenter,
    private readonly storage: StorageService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
  ) {}

  // -------------------------------------------------------- owner-facing

  async create(userId: string, dto: CreateShareDto) {
    if (Boolean(dto.assetId) === Boolean(dto.collectionId)) {
      throw new BadRequestException('Provide exactly one of assetId or collectionId');
    }
    let targetName: string;
    if (dto.assetId) {
      const a = await this.prisma.asset.findFirst({ where: { id: dto.assetId, ownerId: userId, deletedAt: null } });
      if (!a) throw new NotFoundException('Asset not found');
      targetName = a.title ?? a.fileName;
    } else {
      const c = await this.prisma.collection.findFirst({ where: { id: dto.collectionId, ownerId: userId } });
      if (!c) throw new NotFoundException('Collection not found');
      targetName = c.name;
    }
    const link = await this.prisma.shareLink.create({
      data: {
        // 24 random bytes = 192 bits: unguessable, URL-safe.
        token: randomBytes(24).toString('base64url'),
        ownerId: userId,
        assetId: dto.assetId ?? null,
        collectionId: dto.collectionId ?? null,
        passwordHash: dto.password ? await bcrypt.hash(dto.password, 10) : null,
        allowDownload: dto.allowDownload ?? true,
        expiresAt: dto.expiresInHours ? new Date(Date.now() + dto.expiresInHours * 3_600_000) : null,
      },
    });
    await this.activity.log(userId, { action: 'share.created', entityType: 'share', entityId: link.id, entityName: targetName });
    await this.events.publish(userId, { type: 'library.changed', scope: 'shares' });
    return { ...this.toDto(link), targetName, targetType: dto.assetId ? 'asset' : 'collection' };
  }

  async list(userId: string, target?: { assetId?: string; collectionId?: string }) {
    const links = await this.prisma.shareLink.findMany({
      where: { ownerId: userId, ...(target?.assetId ? { assetId: target.assetId } : {}), ...(target?.collectionId ? { collectionId: target.collectionId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { asset: { select: { fileName: true, title: true, kind: true } }, collection: { select: { name: true } } },
    });
    return links.map((l) => ({
      ...this.toDto(l),
      targetType: l.assetId ? 'asset' : 'collection',
      targetName: l.asset ? (l.asset.title ?? l.asset.fileName) : (l.collection?.name ?? ''),
    }));
  }

  async revoke(userId: string, id: string) {
    const link = await this.prisma.shareLink.findFirst({ where: { id, ownerId: userId } });
    if (!link) throw new NotFoundException('Share link not found');
    await this.prisma.shareLink.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.activity.log(userId, { action: 'share.revoked', entityType: 'share', entityId: id });
    await this.events.publish(userId, { type: 'library.changed', scope: 'shares' });
  }

  // ------------------------------------------------------------- public

  /** Resolves a public link. 404 for unknown/revoked (indistinguishable on
   * purpose), 410 once expired, 401 + code when a password is needed. */
  async view(token: string, password: string | undefined, clientIp: string) {
    const link = await this.prisma.shareLink.findUnique({ where: { token } });
    if (!link || link.revokedAt) throw new NotFoundException('This link is not available');
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) throw new GoneException('This link has expired');

    if (link.passwordHash) {
      await this.checkPassword(link.token, link.passwordHash, password, clientIp);
    }

    const assets = link.assetId
      ? await this.prisma.asset.findMany({ where: { id: link.assetId, deletedAt: null }, include: assetDetailInclude })
      : (
          await this.prisma.collectionAsset.findMany({
            where: { collectionId: link.collectionId!, asset: { deletedAt: null } },
            orderBy: { addedAt: 'asc' },
            take: MAX_COLLECTION_ITEMS,
            include: { asset: { include: assetDetailInclude } },
          })
        ).map((ca) => ca.asset);
    if (link.assetId && assets.length === 0) throw new NotFoundException('This link is not available');

    const title = link.assetId
      ? (assets[0].title ?? assets[0].fileName)
      : (await this.prisma.collection.findUniqueOrThrow({ where: { id: link.collectionId! }, select: { name: true } })).name;

    const items = await Promise.all(assets.map((a) => this.publicItem(a, link.allowDownload)));

    // Counted after the visitor is authorised, and never blocks the response.
    void this.prisma.shareLink
      .update({ where: { id: link.id }, data: { viewCount: { increment: 1 }, lastViewedAt: new Date() } })
      .catch(() => undefined);

    return {
      type: link.assetId ? 'asset' : 'collection',
      title,
      allowDownload: link.allowDownload,
      expiresAt: link.expiresAt,
      items,
    };
  }

  private async publicItem(a: Parameters<AssetPresenter["detail"]>[0], allowDownload: boolean) {
    const d = await this.presenter.detail(a);
    const video720 = d.variants.find((v) => v.type === 'VIDEO_TRANSCODE' && v.name === '720p.mp4');
    return {
      id: d.id,
      name: d.title ?? d.fileName,
      kind: d.kind,
      mimeType: d.mimeType,
      width: d.width,
      height: d.height,
      durationMs: d.durationMs,
      dominantColor: d.dominantColor,
      thumbnailUrl: d.thumbnailUrl,
      viewUrl: d.kind === 'IMAGE' ? (d.previewUrl ?? d.originalUrl) : (video720?.downloadUrl ?? d.originalUrl),
      downloadUrl: allowDownload
        ? await this.storage.getPresignedDownloadUrl(a.storageKey, { attachmentFileName: a.fileName })
        : null,
    };
  }

  /** Brute-force guard: 10 wrong passwords per (link, IP) per 15 minutes. */
  private async checkPassword(token: string, hash: string, provided: string | undefined, ip: string) {
    if (!provided) {
      throw new UnauthorizedException({ statusCode: 401, code: 'PASSWORD_REQUIRED', message: 'This link is password protected' });
    }
    const key = `share:pwfail:${token}:${ip}`;
    const fails = Number((await this.redis.client.get(key).catch(() => '0')) ?? 0);
    if (fails >= PASSWORD_FAIL_LIMIT) {
      throw new HttpException({ statusCode: 429, code: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong passwords. Try again later.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!(await bcrypt.compare(provided, hash))) {
      const n = await this.redis.client.incr(key).catch(() => 0);
      if (n === 1) await this.redis.client.expire(key, PASSWORD_FAIL_WINDOW_SECONDS).catch(() => undefined);
      throw new UnauthorizedException({ statusCode: 401, code: 'PASSWORD_INVALID', message: 'Incorrect password' });
    }
  }

  private toDto(l: {
    id: string; token: string; passwordHash: string | null; allowDownload: boolean; expiresAt: Date | null;
    revokedAt: Date | null; viewCount: number; lastViewedAt: Date | null; createdAt: Date;
  }) {
    return {
      id: l.id,
      token: l.token,
      path: `/s/${l.token}`,
      hasPassword: Boolean(l.passwordHash),
      allowDownload: l.allowDownload,
      expiresAt: l.expiresAt,
      revokedAt: l.revokedAt,
      viewCount: l.viewCount,
      lastViewedAt: l.lastViewedAt,
      createdAt: l.createdAt,
    };
  }
}
