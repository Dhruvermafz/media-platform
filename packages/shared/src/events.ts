import { randomUUID } from 'crypto';
import { AssetStatus, JobStatus } from './enums';

/**
 * Real-time event contract shared by every service that can change what a
 * user sees: the API (uploads, edits, trash) and the workers (job progress).
 *
 * Transport: Redis pub/sub, one channel per user (`events:user:{userId}`).
 * Pub/sub is fire-and-forget by design - an event is a *hint to refetch*,
 * never the source of truth (Postgres is). A client that misses one simply
 * refetches on reconnect, so no delivery guarantees are needed and a Redis
 * blip can never lose data, only delay a UI refresh.
 */
export const USER_EVENTS_CHANNEL_PREFIX = 'events:user:';
export const USER_EVENTS_PATTERN = `${USER_EVENTS_CHANNEL_PREFIX}*`;

export function userEventsChannel(userId: string): string {
  return `${USER_EVENTS_CHANNEL_PREFIX}${userId}`;
}

export function userIdFromChannel(channel: string): string | null {
  return channel.startsWith(USER_EVENTS_CHANNEL_PREFIX) ? channel.slice(USER_EVENTS_CHANNEL_PREFIX.length) : null;
}

export type PlatformEvent =
  | { type: 'job.updated'; assetId: string; jobId: string; jobType: string; status: JobStatus }
  | { type: 'asset.updated'; assetId: string; status: AssetStatus }
  | { type: 'asset.created'; assetId: string }
  | { type: 'asset.changed'; assetId: string }
  | { type: 'asset.deleted'; assetId: string }
  | { type: 'library.changed'; scope: 'assets' | 'collections' | 'tags' | 'shares' };

export interface EventEnvelope {
  id: string;
  ts: string;
  event: PlatformEvent;
}

export function createEnvelope(event: PlatformEvent): EventEnvelope {
  return { id: randomUUID(), ts: new Date().toISOString(), event };
}

/** Structural type so this file needs no ioredis import: anything with a
 * compatible `publish` (an ioredis client, a test double) works. */
export interface PubSubPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/** Publishes user-scoped events. Never throws: a failed publish must not
 * fail the job or request that triggered it (see file header). */
export class EventPublisher {
  constructor(private readonly redis: PubSubPublisher) {}

  async publish(userId: string, event: PlatformEvent): Promise<void> {
    try {
      await this.redis.publish(userEventsChannel(userId), JSON.stringify(createEnvelope(event)));
    } catch {
      // best-effort by design
    }
  }
}
