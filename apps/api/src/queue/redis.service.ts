import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.client = new Redis(this.config.get<string>('redisUrl')!, {
      // Reconnect forever with capped backoff rather than giving up —
      // "Redis temporarily unavailable" is an explicit failure scenario
      // this project documents (docs/failure-handling.md), and the API
      // should degrade (cache misses, queue writes fail loud) rather
      // than crash.
      retryStrategy: (times) => Math.min(times * 200, 5000),
      maxRetriesPerRequest: 3,
    });
    this.client.on('error', (err) => this.logger.error(`Redis connection error: ${err.message}`));
    this.client.on('connect', () => this.logger.log('Connected to Redis'));
  }

  async onModuleDestroy() {
    await this.client?.quit();
  }
}
