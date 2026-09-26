import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AssetKind, AssetStatus, JobType, computeIdempotencyKey } from '@media-platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { RedisService } from '../queue/redis.service';
import { JobProducerService } from '../queue/job-producer.service';
import { UsageService } from '../usage/usage.service';
import { ActivityService } from '../activity/activity.service';
import { EventsService } from '../events/events.service';
import { AssetPresenter, assetDetailInclude, assetListInclude, variantName } from './asset.presenter';
import { assetCacheKey } from './asset-cache';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';
import { ListAssetsQueryDto } from './dto/list-assets.query.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { BulkAssetsDto } from './dto/bulk-assets.dto';
import { CreateVariantDto, sanitizeVariantParams } from './dto/create-variant.dto';

function assetKindFromMime(mimeType: string): AssetKind {
  if (mimeType.startsWith('image/')) return AssetKind.IMAGE;
  if (mimeType.startsWith('video/')) return AssetKind.VIDEO;
  throw new BadRequestException(`Unsupported mimeType: ${mimeType}`);
}

/** The set of processing jobs kicked off the moment an asset is confirmed
 * uploaded. Kept in one place so "what does uploading a video actually
 * trigger" has a single, greppable answer.
 *
 * Every job's params carries originalStorageKey: workers are plain,
 * stateless consumers with no DB access to the assets table beyond what
 * JobStore exposes, so the source object's key is threaded through the
 * job message rather than the worker looking the asset up itself.
 * originalStorageKey is a pure function of assetId (an asset's original
 * object never moves), so folding it into the idempotency hash alongside
 * assetId is harmless.
 *
 * Library additions: images also get a 1600px "viewer" rendition (so the
 * lightbox never has to download a 30 MB original), videos get a 5-second
 * hover-preview clip, and both get a METADATA_EXTRACT job. */
export function defaultJobsFor(kind: AssetKind, originalStorageKey: string): Array<{ type: JobType; params: Record<string, unknown> }> {
  const withKey = (params: Record<string, unknown>) => ({ ...params, originalStorageKey });
  if (kind === AssetKind.IMAGE) {
    return [
      { type: JobType.IMAGE_THUMBNAIL, params: withKey({ width: 320, height: 320 }) },
      { type: JobType.IMAGE_RESIZE, params: withKey({ width: 1600 }) },
      { type: JobType.IMAGE_COMPRESS, params: withKey({ quality: 80 }) },
      { type: JobType.METADATA_EXTRACT, params: withKey({ kind: 'IMAGE' }) },
    ];
  }
  return [
    { type: JobType.VIDEO_THUMBNAIL, params: withKey({ atSeconds: 1 }) },
    { type: JobType.VIDEO_TRANSCODE, params: withKey({ resolution: '720p' }) },
    { type: JobType.VIDEO_TRANSCODE, params: withKey({ resolution: '480p' }) },
    { type: JobType.VIDEO_PREVIEW, params: withKey({ startSeconds: 0, durationSeconds: 5 }) },
    { type: JobType.METADATA_EXTRACT, params: withKey({ kind: 'VIDEO' }) },
  ];
}

/** Lower-cases, trims, de-duplicates and bounds user-supplied tags. */
export function normalizeTags(input: string[]): string[] {
  const out = new Set<string>();
  for (const raw of input) {
    const t = raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase();
    if (!t) continue;
    if (t.length > 32) throw new BadRequestException(`Tag "${t.slice(0, 12)}…" is longer than 32 characters`);
    if (t.includes(',')) throw new BadRequestException('Tags cannot contain commas');
    out.add(t);
  }
  return [...out].slice(0, 20);
}

export function buildAssetWhere(userId: string, q: ListAssetsQueryDto): Prisma.AssetWhereInput {
  const search = q.q?.trim();
  return {
    ownerId: userId,
    deletedAt: q.trashed === 'true' ? { not: null } : null,
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.favorite === 'true' ? { isFavorite: true } : {}),
    ...(q.collectionId ? { collections: { some: { collectionId: q.collectionId } } } : {}),
    ...(q.tag ? { tags: { some: { tag: { name: q.tag.trim().toLowerCase() } } } } : {}),
    ...(search
      ? {
          OR: [
            { fileName: { contains: search, mode: 'insensitive' } },
            { title: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
            { tags: { some: { tag: { name: { contains: search.toLowerCase() } } } } },
          ],
        }
      : {}),
  };
}

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private readonly cacheTtl: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly producer: JobProducerService,
    private readonly presenter: AssetPresenter,
    private readonly usage: UsageService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    config: ConfigService,
  ) {
    this.cacheTtl = config.get('cache')!.assetTtlSeconds;
  }

  // ---------------------------------------------------------------- upload

  async createUploadUrl(userId: string, dto: CreateUploadUrlDto) {
    await this.usage.assertCanStore(userId, dto.fileSize);
    const storageKey = this.storage.buildStorageKey(userId, dto.fileName);
    const { url, expiresIn } = await this.storage.getPresignedUploadUrl(storageKey, dto.mimeType);
    return { uploadUrl: url, storageKey, expiresIn, method: 'PUT' as const };
  }

  /** Client PUTs the file to storage directly, then calls this to
   * register the asset and kick off processing. We HEAD the object so a
   * client can't fabricate a storageKey it never actually uploaded to.
   * Idempotent: confirming the same storageKey twice (a retried request)
   * returns the existing asset instead of creating a duplicate. */
  async confirmUpload(userId: string, dto: ConfirmUploadDto) {
    // Ownership first: never reveal whether someone else's key exists.
    if (!dto.storageKey.startsWith(`uploads/${userId}/`)) {
      throw new ForbiddenException('storageKey does not belong to this user');
    }
    const existing = await this.prisma.asset.findFirst({
      where: { ownerId: userId, storageKey: dto.storageKey },
      include: assetListInclude,
    });
    if (existing) return this.presenter.listItem(existing);

    const { exists, size } = await this.storage.objectExists(dto.storageKey);
    if (!exists) {
      throw new BadRequestException('Object not found in storage at the given storageKey. Upload the file before confirming.');
    }
    const kind = assetKindFromMime(dto.mimeType);

    // The size declared at upload-url time is client-supplied; re-check
    // against the real object so the quota can't be bypassed by lying.
    try {
      await this.usage.assertCanStore(userId, size ?? 0);
    } catch (err) {
      await this.storage.deleteObject(dto.storageKey).catch(() => undefined);
      throw err;
    }
    if (dto.collectionId) await this.requireCollection(userId, dto.collectionId);

    const asset = await this.prisma.asset.create({
      data: {
        ownerId: userId,
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        kind,
        fileSize: BigInt(size ?? 0),
        storageKey: dto.storageKey,
        status: AssetStatus.PROCESSING,
        ...(dto.collectionId ? { collections: { create: { collectionId: dto.collectionId } } } : {}),
      },
    });
    if (dto.tags?.length) await this.replaceTags(userId, asset.id, normalizeTags(dto.tags));

    for (const { type, params } of defaultJobsFor(kind, asset.storageKey)) {
      await this.producer.enqueue(asset.id, type, params);
    }

    await this.activity.log(userId, { action: 'asset.uploaded', entityType: 'asset', entityId: asset.id, entityName: asset.fileName, meta: { kind, size: Number(asset.fileSize) } });
    await this.events.publish(userId, { type: 'asset.created', assetId: asset.id });
    return this.presenter.listItem(await this.prisma.asset.findUniqueOrThrow({ where: { id: asset.id }, include: assetListInclude }));
  }

  // ------------------------------------------------------------------ read

  async findAll(userId: string, q: ListAssetsQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const where = buildAssetWhere(userId, q);
    const orderBy = [{ [q.sort ?? 'createdAt']: q.order ?? 'desc' }, { id: 'desc' }] as Prisma.AssetOrderByWithRelationInput[];
    const [rows, total] = await Promise.all([
      this.prisma.asset.findMany({ where, include: assetListInclude, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.asset.count({ where }),
    ]);
    return {
      items: await Promise.all(rows.map((r) => this.presenter.listItem(r))),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  async findOne(userId: string, id: string) {
    const cacheKey = assetCacheKey(id);
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.ownerId !== userId) throw new NotFoundException('Asset not found');
      return parsed;
    }

    const asset = await this.prisma.asset.findUnique({ where: { id }, include: assetDetailInclude });
    if (!asset || asset.ownerId !== userId) throw new NotFoundException('Asset not found');

    const response = await this.presenter.detail(asset);
    // Short TTL cache for hot metadata reads (viewer + polling fallback).
    // Every mutation and every worker event deletes this key (see
    // touch() and EventsService), so the TTL is a safety net for staleness,
    // not the primary consistency mechanism. See docs/decisions.md.
    await this.redis.client.set(cacheKey, JSON.stringify(response), 'EX', this.cacheTtl).catch(() => undefined);
    return response;
  }

  async invalidateCache(assetId: string) {
    await this.redis.client.del(assetCacheKey(assetId)).catch(() => undefined);
  }

  // ---------------------------------------------------------------- mutate

  async update(userId: string, id: string, dto: UpdateAssetDto) {
    await this.requireOwned(userId, id);
    await this.prisma.asset.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() || null } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
        ...(dto.isFavorite !== undefined ? { isFavorite: dto.isFavorite } : {}),
      },
    });
    await this.touch(userId, id);
    return this.findOne(userId, id);
  }

  async setTags(userId: string, id: string, tags: string[]) {
    await this.requireOwned(userId, id);
    await this.replaceTags(userId, id, normalizeTags(tags));
    await this.touch(userId, id);
    await this.events.publish(userId, { type: 'library.changed', scope: 'tags' });
    return this.findOne(userId, id);
  }

  async trash(userId: string, id: string) {
    const asset = await this.requireOwned(userId, id);
    await this.prisma.asset.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.touch(userId, id);
    await this.activity.log(userId, { action: 'asset.trashed', entityType: 'asset', entityId: id, entityName: asset.fileName });
  }

  async restore(userId: string, id: string) {
    const asset = await this.requireOwned(userId, id);
    await this.prisma.asset.update({ where: { id }, data: { deletedAt: null } });
    await this.touch(userId, id);
    await this.activity.log(userId, { action: 'asset.restored', entityType: 'asset', entityId: id, entityName: asset.fileName });
  }

  /** Irreversible: removes the original + every variant from object
   * storage, then the row (cascading jobs, variants, tags, shares). */
  async permanentlyDelete(userId: string, id: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id }, include: { variants: true } });
    if (!asset || asset.ownerId !== userId) throw new NotFoundException('Asset not found');
    await this.purge(asset);
    await this.activity.log(userId, { action: 'asset.deleted', entityType: 'asset', entityName: asset.fileName });
    await this.events.publish(userId, { type: 'asset.deleted', assetId: id });
  }

  /** Storage + row removal without ownership checks - callers (the API
   * above, and CleanupService for expired trash) have already authorised it. */
  async purge(asset: { id: string; storageKey: string; variants: Array<{ storageKey: string }> }) {
    const keys = [asset.storageKey, ...asset.variants.map((v) => v.storageKey)];
    const results = await Promise.allSettled(keys.map((k) => this.storage.deleteObject(k)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') this.logger.warn(`Failed to delete object ${keys[i]}: ${r.reason?.message ?? r.reason}`);
    });
    await this.prisma.asset.delete({ where: { id: asset.id } }); // cascades jobs + variants + tags + shares
    await this.invalidateCache(asset.id);
  }

  // ------------------------------------------------------------- downloads

  async getDownload(userId: string, id: string, variantId?: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id }, include: { variants: true } });
    if (!asset || asset.ownerId !== userId) throw new NotFoundException('Asset not found');
    if (!variantId) {
      const url = await this.storage.getPresignedDownloadUrl(asset.storageKey, { attachmentFileName: asset.fileName });
      return { url, fileName: asset.fileName };
    }
    const variant = asset.variants.find((v) => v.id === variantId);
    if (!variant) throw new NotFoundException('Variant not found');
    const stem = asset.fileName.replace(/\.[^.]+$/, '');
    const fileName = `${stem}-${variantName(variant.storageKey)}`;
    return { url: await this.storage.getPresignedDownloadUrl(variant.storageKey, { attachmentFileName: fileName }), fileName };
  }

  /** On-demand rendition ("export as WebP", "480p copy", "10s clip"). Reuses
   * the exact pipeline uploads use, so retries, idempotency and DLQ all apply. */
  async requestVariant(userId: string, id: string, dto: CreateVariantDto) {
    const asset = await this.requireOwned(userId, id);
    const isImageType = dto.type.startsWith('IMAGE_');
    if ((asset.kind === AssetKind.IMAGE) !== isImageType) {
      throw new BadRequestException(`${dto.type} cannot be applied to a ${asset.kind.toLowerCase()}`);
    }
    let params: Record<string, unknown>;
    try {
      params = sanitizeVariantParams(dto.type, dto.params);
    } catch (err) {
      throw new BadRequestException(`Invalid params for ${dto.type}: ${(err as Error).message}`);
    }
    params = { ...params, originalStorageKey: asset.storageKey };

    const idempotencyKey = computeIdempotencyKey(id, dto.type as JobType, params);
    const existing = await this.prisma.processingJob.findUnique({ where: { assetId_idempotencyKey: { assetId: id, idempotencyKey } } });
    if (existing) return { job: existing, created: false };

    const job = await this.producer.enqueue(id, dto.type as JobType, params);
    await this.prisma.asset.updateMany({ where: { id, status: AssetStatus.READY }, data: { status: AssetStatus.PROCESSING } });
    await this.touch(userId, id);
    await this.activity.log(userId, { action: 'variant.requested', entityType: 'asset', entityId: id, entityName: asset.fileName, meta: { type: dto.type, params: params as Prisma.InputJsonObject } });
    return { job, created: true };
  }

  // ------------------------------------------------------------------ bulk

  async bulk(userId: string, dto: BulkAssetsDto) {
    const owned = await this.prisma.asset.findMany({
      where: { id: { in: dto.ids }, ownerId: userId },
      include: { variants: true },
    });
    const ids = owned.map((a) => a.id);
    if (ids.length === 0) return { affected: 0 };

    switch (dto.action) {
      case 'trash':
        await this.prisma.asset.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: new Date() } });
        break;
      case 'restore':
        await this.prisma.asset.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null } });
        break;
      case 'favorite':
      case 'unfavorite':
        await this.prisma.asset.updateMany({ where: { id: { in: ids } }, data: { isFavorite: dto.action === 'favorite' } });
        break;
      case 'delete':
        for (const asset of owned) await this.purge(asset);
        break;
      case 'addToCollection': {
        const collectionId = await this.requireCollectionId(userId, dto.collectionId);
        await this.prisma.collectionAsset.createMany({ data: ids.map((assetId) => ({ collectionId, assetId })), skipDuplicates: true });
        await this.prisma.collection.update({ where: { id: collectionId }, data: { updatedAt: new Date() } });
        await this.events.publish(userId, { type: 'library.changed', scope: 'collections' });
        break;
      }
      case 'removeFromCollection': {
        const collectionId = await this.requireCollectionId(userId, dto.collectionId);
        await this.prisma.collectionAsset.deleteMany({ where: { collectionId, assetId: { in: ids } } });
        await this.events.publish(userId, { type: 'library.changed', scope: 'collections' });
        break;
      }
      case 'addTags': {
        const tags = normalizeTags(dto.tags ?? []);
        if (tags.length === 0) throw new BadRequestException('addTags requires at least one tag');
        for (const assetId of ids) {
          const current = await this.prisma.assetTag.findMany({ where: { assetId }, include: { tag: true } });
          await this.replaceTags(userId, assetId, normalizeTags([...current.map((c) => c.tag.name), ...tags]));
        }
        await this.events.publish(userId, { type: 'library.changed', scope: 'tags' });
        break;
      }
    }

    await Promise.all(ids.map((id) => this.invalidateCache(id)));
    // One coalesced event for the whole batch, not one per asset.
    await this.events.publish(userId, { type: 'library.changed', scope: 'assets' });
    if (dto.action === 'trash' || dto.action === 'delete') {
      await this.activity.log(userId, { action: dto.action === 'trash' ? 'asset.trashed' : 'asset.deleted', entityType: 'asset', entityName: ids.length === 1 ? owned[0].fileName : `${ids.length} items`, meta: { count: ids.length } });
    }
    return { affected: ids.length };
  }

  // --------------------------------------------------------------- helpers

  private async touch(userId: string, assetId: string) {
    await this.invalidateCache(assetId);
    await this.events.publish(userId, { type: 'asset.changed', assetId });
  }

  private async requireOwned(userId: string, id: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset || asset.ownerId !== userId) throw new NotFoundException('Asset not found');
    return asset;
  }

  private async requireCollection(userId: string, collectionId: string) {
    const c = await this.prisma.collection.findFirst({ where: { id: collectionId, ownerId: userId } });
    if (!c) throw new NotFoundException('Collection not found');
    return c;
  }

  private async requireCollectionId(userId: string, collectionId?: string) {
    if (!collectionId) throw new BadRequestException('collectionId is required for this action');
    return (await this.requireCollection(userId, collectionId)).id;
  }

  /** Makes the asset's tag set exactly `names`, creating tags as needed. */
  private async replaceTags(userId: string, assetId: string, names: string[]) {
    await this.prisma.$transaction(async (tx) => {
      const tagIds: string[] = [];
      for (const name of names) {
        const tag = await tx.tag.upsert({
          where: { ownerId_name: { ownerId: userId, name } },
          create: { ownerId: userId, name },
          update: {},
        });
        tagIds.push(tag.id);
      }
      await tx.assetTag.deleteMany({ where: { assetId, tagId: { notIn: tagIds } } });
      if (tagIds.length) await tx.assetTag.createMany({ data: tagIds.map((tagId) => ({ assetId, tagId })), skipDuplicates: true });
    });
  }
}
