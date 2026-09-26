import * as http from 'http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export class WorkerMetrics {
  readonly registry = new Registry();

  readonly jobsCompleted = new Counter({
    name: 'worker_jobs_completed_total',
    help: 'Jobs successfully completed by this worker',
    labelNames: ['job_type'] as const,
    registers: [this.registry],
  });

  readonly jobsFailed = new Counter({
    name: 'worker_jobs_failed_total',
    help: 'Job attempts that failed (includes ones that will retry)',
    labelNames: ['job_type', 'outcome'] as const, // outcome: retry | dead_letter
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'worker_job_processing_duration_seconds',
    help: 'Time spent actually processing a job (download + transform + upload)',
    labelNames: ['job_type'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });

  readonly activeJobs = new Gauge({
    name: 'worker_active_jobs',
    help: 'Jobs currently being processed by this worker replica',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}

/** Deliberately plain node:http rather than Express — a worker exposes
 * exactly two GET routes and pulling in a web framework for that is
 * unnecessary weight in a process whose real job is consuming a queue. */
export function startMetricsServer(metrics: WorkerMetrics, port: number, isReady: () => boolean): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', metrics.registry.contentType);
      res.end(await metrics.registry.metrics());
    } else if (req.url === '/health') {
      res.statusCode = isReady() ? 200 : 503;
      res.end(JSON.stringify({ status: isReady() ? 'ok' : 'not_ready' }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(port);
  return server;
}
