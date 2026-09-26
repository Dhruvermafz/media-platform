import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  EventEnvelope,
  EventPublisher,
  PlatformEvent,
  USER_EVENTS_PATTERN,
  userIdFromChannel,
} from '@media-platform/shared';
import { RedisService } from '../queue/redis.service';
import { assetCacheKey } from '../assets/asset-cache';

type Listener = (envelope: EventEnvelope) => void;

/**
 * Bridges Redis pub/sub to the SSE connections held by *this* API replica.
 *
 * Every replica psubscribes to `events:user:*` and keeps an in-memory map
 * userId -> listeners, so a worker publishing once reaches a browser
 * connected to any replica without sticky sessions. It also deletes the
 * cached asset-detail entry when a job/asset event passes by, so the
 * detail endpoint never serves pre-completion data to a client that was
 * just told the work finished.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private subscriber?: Redis;
  private publisher?: EventPublisher;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit() {
    // Own connection: a client in subscriber mode can't issue normal commands.
    this.subscriber = new Redis(this.config.get<string>('redisUrl')!, {
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });
    this.subscriber.on('error', (err) => this.logger.error(`Events subscriber error: ${err.message}`));
    this.subscriber.on('pmessage', (_pattern, channel, message) => void this.dispatch(channel, message));
    await this.subscriber.psubscribe(USER_EVENTS_PATTERN); // ioredis re-subscribes after reconnects
  }

  async onModuleDestroy() {
    await this.subscriber?.quit().catch(() => undefined);
  }

  /** Publish an event caused by an API action (upload, edit, trash...). */
  async publish(userId: string, event: PlatformEvent): Promise<void> {
    this.publisher ??= new EventPublisher(this.redis.client);
    await this.publisher.publish(userId, event);
  }

  /** Returns an unsubscribe function. */
  subscribe(userId: string, listener: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(userId);
    };
  }

  connectionCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  private async dispatch(channel: string, message: string) {
    const userId = userIdFromChannel(channel);
    if (!userId) return;
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(message);
    } catch {
      return;
    }
    const ev = envelope.event;
    if ('assetId' in ev && (ev.type === 'job.updated' || ev.type === 'asset.updated' || ev.type === 'asset.changed')) {
      await this.redis.client.del(assetCacheKey(ev.assetId)).catch(() => undefined);
    }
    for (const listener of this.listeners.get(userId) ?? []) {
      try {
        listener(envelope);
      } catch (err) {
        this.logger.warn(`SSE listener threw: ${(err as Error).message}`);
      }
    }
  }
}
