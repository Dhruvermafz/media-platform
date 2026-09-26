import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JobType } from '@media-platform/shared';
import { StorageService } from '../storage/storage.service';

/** Variant types the library grid needs (kept small: list responses are large). */
export const LIST_VARIANT_TYPES = [JobType.IMAGE_THUMBNAIL, JobType.VIDEO_THUMBNAIL, JobType.VIDEO_PREVIEW];

export const assetListInclude = {
  tags: { include: { tag: true } },
  // Only the status column: drives the per-tile pipeline progress strip.
  processingJobs: { select: { status: true } },
  variants: { where: { type: { in: LIST_VARIANT_TYPES as unknown as Prisma.EnumJobTypeFilter['in'] } } },
} satisfies Prisma.AssetInclude;

export const assetDetailInclude = {
  tags: { include: { tag: true } },
  variants: { orderBy: { createdAt: 'asc' } },
  collections: { include: { collection: { select: { id: true, name: true } } } },
} satisfies Prisma.AssetInclude;

type ListAsset = Prisma.AssetGetPayload<{ include: typeof assetListInclude }>;
type DetailAsset = Prisma.AssetGetPayload<{ include: typeof assetDetailInclude }>;
type VariantRow = ListAsset['variants'][number];

/** "variants/<assetId>/720p.mp4" -> "720p.mp4" */
export const variantName = (storageKey: string) => storageKey.split('/').pop() ?? storageKey;

/**
 * Turns database rows into the JSON the API returns. Single home for
 * "which variant is the thumbnail / preview" so lists, detail, collection
 * covers and public share pages can never disagree about it.
 */
@Injectable()
export class AssetPresenter {
  constructor(private readonly storage: StorageService) {}

  private base(a: ListAsset | DetailAsset) {
    return {
      id: a.id,
      ownerId: a.ownerId,
      fileName: a.fileName,
      title: a.title,
      description: a.description,
      mimeType: a.mimeType,
      kind: a.kind,
      fileSize: Number(a.fileSize),
      status: a.status,
      isFavorite: a.isFavorite,
      width: a.width,
      height: a.height,
      durationMs: a.durationMs,
      dominantColor: a.dominantColor,
      capturedAt: a.capturedAt,
      tags: a.tags.map((t) => t.tag.name).sort(),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      deletedAt: a.deletedAt,
    };
  }

  private async urlOf(v: VariantRow | undefined) {
    return v ? this.storage.getPresignedDownloadUrl(v.storageKey) : null;
  }

  /** Pipeline progress for assets still being worked on. Null once READY so
   * settled tiles carry no extra payload and render no strip. */
  private pipeline(a: ListAsset) {
    if (a.status === 'READY') return null;
    const jobs = a.processingJobs;
    const count = (...s: string[]) => jobs.filter((j) => s.includes(j.status)).length;
    return {
      total: jobs.length,
      done: count('COMPLETED'),
      running: count('PROCESSING'),
      failed: count('FAILED', 'DEAD_LETTER'),
    };
  }

  /** Grid/list item: base fields + thumbnail (+ hover clip for video). */
  async listItem(a: ListAsset) {
    const thumb = a.variants.find((v) => v.type === JobType.IMAGE_THUMBNAIL || v.type === JobType.VIDEO_THUMBNAIL);
    const clip = a.variants.find((v) => v.type === JobType.VIDEO_PREVIEW);
    const [thumbnailUrl, clipUrl] = await Promise.all([this.urlOf(thumb), this.urlOf(clip)]);
    return { ...this.base(a), thumbnailUrl, clipUrl, pipeline: this.pipeline(a) };
  }

  /** Full detail: every variant, collections, metadata and a viewing URL. */
  async detail(a: DetailAsset) {
    const variants = await Promise.all(
      a.variants.map(async (v) => ({
        id: v.id,
        type: v.type,
        name: variantName(v.storageKey),
        mimeType: v.mimeType,
        fileSize: Number(v.fileSize),
        width: v.width,
        height: v.height,
        durationMs: v.durationMs,
        createdAt: v.createdAt,
        // `downloadUrl` is the field name the API has always used for variants.
        downloadUrl: await this.storage.getPresignedDownloadUrl(v.storageKey),
      })),
    );
    const thumb = variants.find((v) => v.type === JobType.IMAGE_THUMBNAIL || v.type === JobType.VIDEO_THUMBNAIL);
    const clip = variants.find((v) => v.type === JobType.VIDEO_PREVIEW);
    // Best on-screen image: the widest resized rendition, else the compressed one.
    const preview = a.kind === 'IMAGE'
      ? [...variants].filter((v) => v.type === JobType.IMAGE_RESIZE).sort((x, y) => (y.width ?? 0) - (x.width ?? 0))[0] ??
        variants.find((v) => v.type === JobType.IMAGE_COMPRESS)
      : undefined;
    return {
      ...this.base(a),
      thumbnailUrl: thumb?.downloadUrl ?? null,
      clipUrl: clip?.downloadUrl ?? null,
      previewUrl: preview?.downloadUrl ?? null,
      originalUrl: await this.storage.getPresignedDownloadUrl(a.storageKey),
      metadata: a.metadata ?? null,
      collections: a.collections.map((c) => c.collection),
      variants,
    };
  }
}
