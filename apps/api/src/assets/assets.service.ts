import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssetKind, AssetStatus, JobType } from '@media-platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { RedisService } from '../queue/redis.service';
import { JobProducerService } from '../queue/job-producer.service';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';

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
 * assetId is harmless — it's always the same value for a given assetId
 * and can never cause two logically-identical jobs to hash differently. */
function defaultJobsFor(kind: AssetKind, originalStorageKey: string): Array<{ type: JobType; params: Record<string, unknown> }> {
  const withKey = (params: Record<string, unknown>) => ({ ...params, originalStorageKey });
  if (kind === AssetKind.IMAGE) {
    return [
      { type: JobType.IMAGE_THUMBNAIL, params: withKey({ width: 320, height: 320 }) },
      { type: JobType.IMAGE_COMPRESS, params: withKey({ quality: 80 }) },
    ];
  }
  return [
    { type: JobType.VIDEO_THUMBNAIL, params: withKey({ atSeconds: 1 }) },
    { type: JobType.VIDEO_TRANSCODE, params: withKey({ resolution: '720p' }) },
    { type: JobType.VIDEO_TRANSCODE, params: withKey({ resolution: '480p' }) },
  ];
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
    config: ConfigService,
  ) {
    this.cacheTtl = config.get('cache')!.assetTtlSeconds;
  }

  async createUploadUrl(userId: string, dto: CreateUploadUrlDto) {
    const storageKey = this.storage.buildStorageKey(userId, dto.fileName);
    const { url, expiresIn } = await this.storage.getPresignedUploadUrl(storageKey, dto.mimeType);
    return { uploadUrl: url, storageKey, expiresIn, method: 'PUT' as const };
  }

  /** Client PUTs the file to storage directly, then calls this to
   * register the asset and kick off processing. We HEAD the object so a
   * client can't fabricate a storageKey it never actually uploaded to. */
  async confirmUpload(userId: string, dto: ConfirmUploadDto) {
    const { exists, size } = await this.storage.objectExists(dto.storageKey);
    if (!exists) {
      throw new BadRequestException(
        'Object not found in storage at the given storageKey. Upload the file before confirming.',
      );
    }
    if (!dto.storageKey.startsWith(`uploads/${userId}/`)) {
      throw new ForbiddenException('storageKey does not belong to this user');
    }

    const kind = assetKindFromMime(dto.mimeType);
    const asset = await this.prisma.asset.create({
      data: {
        ownerId: userId,
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        kind,
        fileSize: BigInt(size ?? 0),
        storageKey: dto.storageKey,
        status: AssetStatus.PROCESSING,
      },
    });

    for (const { type, params } of defaultJobsFor(kind, asset.storageKey)) {
      await this.producer.enqueue(asset.id, type, params);
    }

    return this.toResponse(asset);
  }

  async findAll(userId: string, opts: { status?: AssetStatus; page: number; pageSize: number }) {
    const where = { ownerId: userId, ...(opts.status ? { status: opts.status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.asset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.asset.count({ where }),
    ]);
    return {
      items: items.map((a) => this.toResponse(a)),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  async findOne(userId: string, id: string) {
    const cacheKey = `asset:${id}`;
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.ownerId !== userId) throw new NotFoundException('Asset not found');
      return parsed;
    }

    const asset = await this.prisma.asset.findUnique({
      where: { id },
      include: { variants: true },
    });
    if (!asset || asset.ownerId !== userId) throw new NotFoundException('Asset not found');

    const response = await this.toResponseWithVariants(asset);
    // Short TTL cache for hot metadata reads (dashboard polling asset
    // status). Job-status writes below explicitly invalidate this key,
    // so the TTL is a safety net for staleness, not the primary
    // consistency mechanism. See docs/decisions.md "Redis cache: TTL choice".
    await this.redis.client.set(cacheKey, JSON.stringify(response), 'EX', this.cacheTtl);
    return response;
  }

  async invalidateCache(assetId: string) {
    await this.redis.client.del(`asset:${assetId}`);
  }

  async remove(userId: string, id: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id }, include: { variants: true } });
    if (!asset || asset.ownerId !== userId) throw new NotFoundException('Asset not found');

    await this.storage.deleteObject(asset.storageKey).catch((err) =>
      this.logger.warn(`Failed to delete original object ${asset.storageKey}: ${err.message}`),
    );
    for (const variant of asset.variants) {
      await this.storage
        .deleteObject(variant.storageKey)
        .catch((err) => this.logger.warn(`Failed to delete variant ${variant.storageKey}: ${err.message}`));
    }
    await this.prisma.asset.delete({ where: { id } }); // cascades jobs + variants
    await this.invalidateCache(id);
  }

  private toResponse(asset: { id: string; fileName: string; mimeType: string; kind: string; fileSize: bigint; status: string; ownerId: string; createdAt: Date; updatedAt: Date }) {
    return {
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      kind: asset.kind,
      fileSize: Number(asset.fileSize),
      status: asset.status,
      ownerId: asset.ownerId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    };
  }

  private async toResponseWithVariants(asset: any) {
    const base = this.toResponse(asset);
    const variants = await Promise.all(
      (asset.variants ?? []).map(async (v: any) => ({
        id: v.id,
        type: v.type,
        mimeType: v.mimeType,
        fileSize: Number(v.fileSize),
        width: v.width,
        height: v.height,
        durationMs: v.durationMs,
        downloadUrl: await this.storage.getPresignedDownloadUrl(v.storageKey),
      })),
    );
    return { ...base, variants };
  }
}
