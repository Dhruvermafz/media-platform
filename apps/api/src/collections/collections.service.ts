import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ActivityService } from '../activity/activity.service';
import { EventsService } from '../events/events.service';
import { LIST_VARIANT_TYPES } from '../assets/asset.presenter';
import { CreateCollectionDto, UpdateCollectionDto } from './collections.dto';

const visibleAssets = { asset: { deletedAt: null } } satisfies Prisma.CollectionAssetWhereInput;

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
  ) {}

  /** Collections with a live item count and up to 4 cover thumbnails
   * (newest additions first) for the mosaic on the collections page. */
  async list(userId: string) {
    const rows = await this.prisma.collection.findMany({
      where: { ownerId: userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { assets: { where: visibleAssets } } },
        assets: {
          where: visibleAssets,
          orderBy: { addedAt: 'desc' },
          take: 4,
          include: { asset: { include: { variants: { where: { type: { in: LIST_VARIANT_TYPES as unknown as Prisma.EnumJobTypeFilter['in'] } } } } } },
        },
      },
    });
    return Promise.all(
      rows.map(async (c) => ({
        ...this.summary(c, c._count.assets),
        covers: await Promise.all(
          c.assets.map(async (ca) => {
            const thumb = ca.asset.variants.find((v) => v.type === 'IMAGE_THUMBNAIL' || v.type === 'VIDEO_THUMBNAIL');
            return { assetId: ca.asset.id, dominantColor: ca.asset.dominantColor, url: thumb ? await this.storage.getPresignedDownloadUrl(thumb.storageKey) : null };
          }),
        ),
      })),
    );
  }

  async get(userId: string, id: string) {
    const c = await this.prisma.collection.findFirst({
      where: { id, ownerId: userId },
      include: { _count: { select: { assets: { where: visibleAssets } } } },
    });
    if (!c) throw new NotFoundException('Collection not found');
    return this.summary(c, c._count.assets);
  }

  async create(userId: string, dto: CreateCollectionDto) {
    try {
      const c = await this.prisma.collection.create({
        data: { ownerId: userId, name: dto.name.trim(), description: dto.description?.trim() || null },
      });
      await this.activity.log(userId, { action: 'collection.created', entityType: 'collection', entityId: c.id, entityName: c.name });
      await this.events.publish(userId, { type: 'library.changed', scope: 'collections' });
      return this.summary(c, 0);
    } catch (err) {
      throw this.translate(err);
    }
  }

  async update(userId: string, id: string, dto: UpdateCollectionDto) {
    await this.get(userId, id);
    try {
      await this.prisma.collection.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
        },
      });
    } catch (err) {
      throw this.translate(err);
    }
    await this.events.publish(userId, { type: 'library.changed', scope: 'collections' });
    return this.get(userId, id);
  }

  /** Deletes the collection only - its assets stay in the library. */
  async remove(userId: string, id: string) {
    const c = await this.get(userId, id);
    await this.prisma.collection.delete({ where: { id } });
    await this.activity.log(userId, { action: 'collection.deleted', entityType: 'collection', entityName: c.name });
    await this.events.publish(userId, { type: 'library.changed', scope: 'collections' });
  }

  private summary(c: { id: string; name: string; description: string | null; createdAt: Date; updatedAt: Date }, count: number) {
    return { id: c.id, name: c.name, description: c.description, itemCount: count, createdAt: c.createdAt, updatedAt: c.updatedAt };
  }

  private translate(err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException('You already have a collection with this name');
    }
    return err;
  }
}
