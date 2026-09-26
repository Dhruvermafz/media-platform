import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from '../events/events.service';
import { normalizeTags } from '../assets/assets.service';

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventsService) {}

  /** Tags with how many *live* (non-trashed) assets use each, most used first. */
  async list(userId: string) {
    const tags = await this.prisma.tag.findMany({
      where: { ownerId: userId },
      include: { _count: { select: { assets: { where: { asset: { deletedAt: null } } } } } },
    });
    return tags
      .map((t) => ({ id: t.id, name: t.name, count: t._count.assets }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  async rename(userId: string, id: string, name: string) {
    const [clean] = normalizeTags([name]);
    if (!clean) throw new BadRequestException('Tag name cannot be empty');
    const tag = await this.prisma.tag.findFirst({ where: { id, ownerId: userId } });
    if (!tag) throw new NotFoundException('Tag not found');
    try {
      const updated = await this.prisma.tag.update({ where: { id }, data: { name: clean } });
      await this.events.publish(userId, { type: 'library.changed', scope: 'tags' });
      return { id: updated.id, name: updated.name };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`You already have a tag named "${clean}"`);
      }
      throw err;
    }
  }

  async remove(userId: string, id: string) {
    const tag = await this.prisma.tag.findFirst({ where: { id, ownerId: userId } });
    if (!tag) throw new NotFoundException('Tag not found');
    await this.prisma.tag.delete({ where: { id } }); // cascades asset_tags
    await this.events.publish(userId, { type: 'library.changed', scope: 'tags' });
    await this.events.publish(userId, { type: 'library.changed', scope: 'assets' });
  }
}
