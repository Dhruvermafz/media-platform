import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { RedisService } from '../queue/redis.service';
import { AssetsService } from '../assets/assets.service';

const MAX_ORPHAN_DELETES_PER_RUN = 1000;

/**
 * Background housekeeping that closes two gaps listed in the original
 * "Known gaps" (orphaned uploads) and completes the trash feature
 * (retention). Every API replica schedules these crons, so each run takes
 * a short Redis lock (SET NX EX) and only the replica that wins does the
 * work - no separate scheduler service to deploy.
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);
  private readonly cfg: { enabled: boolean; trashRetentionDays: number; orphanUploadTtlHours: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly assets: AssetsService,
    config: ConfigService,
  ) {
    this.cfg = config.get('cleanup')!;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledTrashPurge() {
    if (!this.cfg.enabled) return;
    await this.withLock('trash-purge', 15 * 60, () => this.purgeExpiredTrash());
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async scheduledOrphanSweep() {
    if (!this.cfg.enabled) return;
    await this.withLock('orphan-sweep', 60 * 60, () => this.sweepOrphanUploads());
  }

  /** Permanently deletes assets that have sat in the trash past retention. */
  async purgeExpiredTrash(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.cfg.trashRetentionDays * 86_400_000);
    let purged = 0;
    for (;;) {
      const batch = await this.prisma.asset.findMany({
        where: { deletedAt: { not: null, lt: cutoff } },
        include: { variants: true },
        take: 50,
      });
      if (batch.length === 0) break;
      for (const asset of batch) {
        await this.assets.purge(asset);
        purged++;
      }
    }
    if (purged) this.logger.log(`Purged ${purged} asset(s) trashed more than ${this.cfg.trashRetentionDays} days ago`);
    return purged;
  }

  /**
   * An upload that never reached POST /assets (tab closed, network drop,
   * quota rejection) leaves an object in storage with no database row - it
   * is invisible to the user yet still billed. Deletes `uploads/` objects
   * older than ORPHAN_UPLOAD_TTL_HOURS that no asset row references.
   * The TTL must comfortably exceed the 15-minute presigned-upload window
   * so an in-flight upload is never deleted from under its owner.
   */
  async sweepOrphanUploads(now = new Date()): Promise<number> {
    const cutoff = now.getTime() - this.cfg.orphanUploadTtlHours * 3_600_000;
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.storage.listObjects('uploads/', token);
      token = page.nextToken;
      const old = page.objects.filter((o) => o.lastModified.getTime() < cutoff);
      if (old.length === 0) continue;
      const known = new Set(
        (await this.prisma.asset.findMany({ where: { storageKey: { in: old.map((o) => o.key) } }, select: { storageKey: true } })).map((a) => a.storageKey),
      );
      for (const obj of old) {
        if (known.has(obj.key)) continue;
        await this.storage.deleteObject(obj.key).then(() => deleted++).catch((e) => this.logger.warn(`Orphan delete failed for ${obj.key}: ${e.message}`));
        if (deleted >= MAX_ORPHAN_DELETES_PER_RUN) return deleted;
      }
    } while (token);
    if (deleted) this.logger.log(`Deleted ${deleted} orphaned upload(s)`);
    return deleted;
  }

  private async withLock(name: string, ttlSeconds: number, fn: () => Promise<unknown>) {
    const key = `lock:cleanup:${name}`;
    const acquired = await this.redis.client.set(key, randomUUID(), 'EX', ttlSeconds, 'NX').catch(() => null);
    if (acquired !== 'OK') return; // another replica is (or just was) running it
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Cleanup job "${name}" failed: ${(err as Error).message}`);
    }
  }
}
