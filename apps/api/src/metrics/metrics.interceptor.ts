import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    // A Server-Sent Events stream emits one value per event; tap() would
    // count every push as a separate request and record the stream's
    // multi-hour lifetime as a latency sample.
    if (req.path === '/events') return next.handle();
    const start = process.hrtime.bigint();
    // route.path (not req.url) keeps the label cardinality bounded —
    // /assets/:id instead of one label value per asset UUID ever requested.
    const route = req.route?.path ?? req.url;

    return next.handle().pipe(
      tap({
        next: () => this.record(req.method, route, res.statusCode, start),
        error: () => this.record(req.method, route, res.statusCode || 500, start),
      }),
    );
  }

  private record(method: string, route: string, statusCode: number, start: bigint) {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method, route, status_code: String(statusCode) };
    this.metrics.httpRequestsTotal.inc(labels);
    this.metrics.httpRequestDuration.observe(labels, durationSeconds);
  }
}
