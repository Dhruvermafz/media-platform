import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { WorkerKind } from '@media-platform/shared';
import { streamKeyFor, dlqStreamKeyFor } from '@media-platform/shared';
import { RedisService } from '../queue/redis.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [this.registry],
  });

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly queueDepth = new Gauge({
    name: 'queue_depth',
    help: 'Number of pending entries in a worker stream',
    labelNames: ['worker'] as const,
    registers: [this.registry],
  });

  readonly dlqDepth = new Gauge({
    name: 'dead_letter_queue_depth',
    help: 'Number of entries in a worker dead-letter stream',
    labelNames: ['worker'] as const,
    registers: [this.registry],
  });

  readonly jobsByStatus = new Gauge({
    name: 'jobs_by_status',
    help: 'Count of processing_jobs rows grouped by status',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {
    collectDefaultMetrics({ register: this.registry });
  }

  /** Pulled on-demand when /metrics is scraped (see MetricsController)
   * rather than on a timer, so this stays accurate even under Prometheus
   * scrape-interval drift and costs nothing between scrapes. */
  async refreshQueueGauges() {
    for (const worker of Object.values(WorkerKind)) {
      const [depth, dlq] = await Promise.all([
        this.redis.client.xlen(streamKeyFor(worker)).catch(() => 0),
        this.redis.client.xlen(dlqStreamKeyFor(worker)).catch(() => 0),
      ]);
      this.queueDepth.set({ worker }, depth);
      this.dlqDepth.set({ worker }, dlq);
    }

    const grouped = await this.prisma.processingJob.groupBy({ by: ['status'], _count: true });
    for (const row of grouped) {
      this.jobsByStatus.set({ status: row.status }, row._count);
    }
  }
}
