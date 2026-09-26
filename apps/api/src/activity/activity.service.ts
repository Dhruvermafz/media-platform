import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ActivityInput {
  action: string; // e.g. "asset.uploaded"
  entityType: 'asset' | 'collection' | 'share';
  entityId?: string;
  entityName?: string;
  meta?: Prisma.InputJsonObject;
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Best-effort: an audit-trail write must never fail the user's action. */
  async log(userId: string, input: ActivityInput): Promise<void> {
    try {
      await this.prisma.activityLog.create({ data: { userId, ...input } });
    } catch (err) {
      this.logger.warn(`Failed to record ${input.action}: ${(err as Error).message}`);
    }
  }

  /** Cursor pagination on (createdAt, id) so entries written in the same
   * millisecond are neither skipped nor repeated across pages. */
  async list(userId: string, limit = 50, before?: string) {
    const take = Math.min(100, Math.max(1, limit));
    const items = await this.prisma.activityLog.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }
}
