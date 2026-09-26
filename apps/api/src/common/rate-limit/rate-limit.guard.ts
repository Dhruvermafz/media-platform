import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../queue/redis.service';

/**
 * Fixed-window counter per user (falls back to IP for unauthenticated
 * routes like /auth/login).
 *
 *   INCR rate:{key}:{windowStart}
 *   EXPIRE rate:{key}:{windowStart} windowSeconds   (only set on first hit)
 *
 * Chose fixed-window over sliding-window/token-bucket for one reason:
 * it's two Redis commands and is exact enough for "100 req/min/user" —
 * see docs/decisions.md "Rate limiting: fixed window" for the boundary-
 * burst trade-off this accepts. The key's own TTL is the eviction
 * mechanism, so no separate cleanup job is needed.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const { windowSeconds, maxRequests } = this.config.get('rateLimit')!;

    const identity: string = request.user?.userId ?? request.ip ?? 'anonymous';
    const windowStart = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `rate:${identity}:${windowStart}`;

    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, windowSeconds);
    }

    if (count > maxRequests) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message: 'Rate limit exceeded' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
