import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JobStatus, WorkerKind, streamKeyFor, dlqStreamKeyFor, consumerGroupFor } from '@media-platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../queue/redis.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getStats() {
    const [assetCounts, jobCounts, queueDepths, dlqDepths, activeWorkers, processingTimes] = await Promise.all([
      this.assetCountsByStatus(),
      this.jobCountsByStatus(),
      this.queueDepths(),
      this.dlqDepths(),
      this.activeWorkerCounts(),
      this.processingTimeStats(),
    ]);

    return {
      totalAssets: Object.values(assetCounts).reduce((a, b) => a + b, 0),
      assetsByStatus: assetCounts,
      jobsByStatus: jobCounts,
      queueDepths,
      deadLetterDepths: dlqDepths,
      activeWorkers,
      averageProcessingTimeMs: processingTimes.avgMs,
      p95ProcessingTimeMs: processingTimes.p95Ms,
      retryCount: jobCounts[JobStatus.RETRY] ?? 0,
      deadLetterJobCount: jobCounts[JobStatus.DEAD_LETTER] ?? 0,
    };
  }

  async getFailedJobs(limit = 50) {
    return this.prisma.processingJob.findMany({
      where: { status: { in: [JobStatus.FAILED, JobStatus.DEAD_LETTER] } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: { asset: { select: { fileName: true, ownerId: true } } },
    });
  }

  /** One row per user with asset count + bytes stored, aggregated in the
   * database (a per-user query loop would be O(users) round trips). */
  async listUsers() {
    const [users, usage] = await Promise.all([
      this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.asset.groupBy({ by: ['ownerId'], _sum: { fileSize: true }, _count: true }),
    ]);
    const byOwner = new Map(usage.map((u) => [u.ownerId, u]));
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      createdAt: u.createdAt,
      storageQuotaBytes: Number(u.storageQuotaBytes),
      usedBytes: Number(byOwner.get(u.id)?._sum.fileSize ?? 0),
      assetCount: byOwner.get(u.id)?._count ?? 0,
    }));
  }

  async updateUser(actorId: string, targetId: string, dto: { role?: Role; storageQuotaBytes?: number }) {
    if (dto.role && dto.role !== Role.ADMIN && targetId === actorId) {
      // Prevents the last admin locking everyone out of this page.
      throw new BadRequestException('You cannot remove your own admin role');
    }
    const exists = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!exists) throw new NotFoundException('User not found');
    const u = await this.prisma.user.update({
      where: { id: targetId },
      data: {
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.storageQuotaBytes !== undefined ? { storageQuotaBytes: BigInt(dto.storageQuotaBytes) } : {}),
      },
    });
    return { id: u.id, email: u.email, role: u.role, storageQuotaBytes: Number(u.storageQuotaBytes) };
  }

  private async assetCountsByStatus() {
    const rows = await this.prisma.asset.groupBy({ by: ['status'], _count: true });
    return Object.fromEntries(rows.map((r) => [r.status, r._count]));
  }

  private async jobCountsByStatus(): Promise<Record<string, number>> {
    const rows = await this.prisma.processingJob.groupBy({ by: ['status'], _count: true });
    return Object.fromEntries(rows.map((r) => [r.status, r._count]));
  }

  private async queueDepths(): Promise<Record<string, number>> {
    const entries = await Promise.all(
      Object.values(WorkerKind).map(async (w) => [w, await this.redis.client.xlen(streamKeyFor(w)).catch(() => 0)]),
    );
    return Object.fromEntries(entries);
  }

  private async dlqDepths(): Promise<Record<string, number>> {
    const entries = await Promise.all(
      Object.values(WorkerKind).map(async (w) => [w, await this.redis.client.xlen(dlqStreamKeyFor(w)).catch(() => 0)]),
    );
    return Object.fromEntries(entries);
  }

  /** "Active workers" = distinct consumer names Redis has seen register
   * for each group via XINFO CONSUMERS, which is how many worker
   * replicas actually pulled at least one message — not how many
   * containers happen to be running, which Redis has no visibility into. */
  private async activeWorkerCounts(): Promise<Record<string, number>> {
    const entries = await Promise.all(
      Object.values(WorkerKind).map(async (w) => {
        try {
          const consumers = (await this.redis.client.call('XINFO', 'CONSUMERS', streamKeyFor(w), consumerGroupFor(w))) as unknown[];
          return [w, consumers.length];
        } catch {
          return [w, 0];
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  private async processingTimeStats(): Promise<{ avgMs: number | null; p95Ms: number | null }> {
    const result = await this.prisma.$queryRaw<Array<{ avg_ms: number | null; p95_ms: number | null }>>`
      SELECT
        AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000) AS avg_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000) AS p95_ms
      FROM processing_jobs
      WHERE status = 'COMPLETED' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL
        AND "completedAt" > now() - interval '24 hours'
    `;
    return { avgMs: result[0]?.avg_ms ?? null, p95Ms: result[0]?.p95_ms ?? null };
  }
}
