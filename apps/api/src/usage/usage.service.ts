import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

/**
 * Storage accounting. Only *original* uploads count toward a user's quota
 * (derived renditions are cheap to regenerate and would make the number
 * users see impossible to reason about). Trashed items still count until
 * they are permanently deleted, since the bytes are still stored.
 */
@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  async getUsage(userId: string) {
    const [user, live, trashed, byKind] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { storageQuotaBytes: true } }),
      this.prisma.asset.aggregate({ where: { ownerId: userId, deletedAt: null }, _sum: { fileSize: true }, _count: true }),
      this.prisma.asset.aggregate({ where: { ownerId: userId, deletedAt: { not: null } }, _sum: { fileSize: true }, _count: true }),
      this.prisma.asset.groupBy({
        by: ['kind'],
        where: { ownerId: userId, deletedAt: null },
        _sum: { fileSize: true },
        _count: true,
      }),
    ]);
    const kind = (k: string) => byKind.find((r) => r.kind === k);
    const liveBytes = num(live._sum.fileSize);
    const trashBytes = num(trashed._sum.fileSize);
    return {
      usedBytes: liveBytes + trashBytes,
      quotaBytes: num(user.storageQuotaBytes),
      trashBytes,
      counts: { total: live._count, trashed: trashed._count, images: kind('IMAGE')?._count ?? 0, videos: kind('VIDEO')?._count ?? 0 },
      breakdown: { imageBytes: num(kind('IMAGE')?._sum.fileSize), videoBytes: num(kind('VIDEO')?._sum.fileSize) },
    };
  }

  /** Throws 413 with a stable `code` the UI can act on. */
  async assertCanStore(userId: string, incomingBytes: number): Promise<void> {
    const { usedBytes, quotaBytes } = await this.getUsage(userId);
    if (usedBytes + incomingBytes > quotaBytes) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
          code: 'QUOTA_EXCEEDED',
          message: 'Storage quota exceeded. Empty the trash or delete files to free up space.',
        },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
  }
}
