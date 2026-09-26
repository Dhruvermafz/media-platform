# Observability

## Metrics (Prometheus)

**API** (`GET /metrics`, `apps/api/src/metrics/`):

| Metric | Type | What it answers |
|---|---|---|
| `http_requests_total{method,route,status_code}` | Counter | Request count, error rate (`status_code=~"5.."`) |
| `http_request_duration_seconds{method,route,status_code}` | Histogram | Latency, including P95/P99 via `histogram_quantile` |
| `queue_depth{worker}` | Gauge | Pending entries per worker stream (`XLEN`, refreshed on scrape) |
| `dead_letter_queue_depth{worker}` | Gauge | DLQ size per worker |
| `jobs_by_status{status}` | Gauge | Live count of `processing_jobs` rows grouped by status |
| Node.js default metrics | various | Event loop lag, heap usage, GC — via `prom-client`'s `collectDefaultMetrics` |

**Workers** (`GET :9100/metrics` on each replica,
`packages/shared/src/worker/metrics-server.ts`):

| Metric | Type | What it answers |
|---|---|---|
| `worker_jobs_completed_total{job_type}` | Counter | Throughput |
| `worker_jobs_failed_total{job_type,outcome}` | Counter | Failure rate, split by `retry` vs `dead_letter` outcome |
| `worker_job_processing_duration_seconds{job_type}` | Histogram | Processing time distribution — average and P95 per job type |
| `worker_active_jobs` | Gauge | In-flight work on this replica |

`route` labels use Express's `req.route.path` (e.g. `/assets/:id`), not
the raw URL, so cardinality stays bounded regardless of how many unique
asset IDs are ever requested — a raw-URL label set would grow unbounded
and eventually overwhelm Prometheus.

Database connection/query metrics are exposed indirectly: Prisma's own
connection pool stats aren't wired into `/metrics` in this project (documented
gap — `@prisma/instrumentation` or a raw `pg_stat_activity` scrape would
be the next step); query latency for the admin dashboard's aggregate
queries is visible via the `/admin/stats` endpoint's own response time
in `http_request_duration_seconds`.

System-level (container CPU/memory/disk) comes from **cAdvisor**
(`localhost:8081`, scraped by Prometheus per `infra/docker/prometheus/prometheus.yml`)
rather than instrumented in application code — cAdvisor already exposes
per-container resource metrics without the app needing to know about
its own cgroup.

## Logging (structured JSON -> Promtail -> Loki -> Grafana)

The API uses `nestjs-pino` for structured JSON request logs;
workers `console.log(JSON.stringify({...}))` directly (see e.g.
`apps/image-worker/src/main.ts`) — deliberately not pulling in a full
logging framework for three processes that log a handful of well-known
event shapes (`processing started`, `processing completed`, error with
`jobId`/`assetId`/`error`).

Every log line matches the shape:
```json
{"level": "info", "service": "video-worker", "jobId": "...", "assetId": "...", "msg": "..."}
```

`infra/docker/promtail/promtail.yml` discovers containers via the Docker
socket, parses this JSON, and promotes `level` and `service` to Loki
labels — so `{service="video-worker"} | json | level="error"` in
Grafana's Explore view finds every video-worker error without grepping
raw text.

## Grafana dashboards

`infra/docker/grafana/provisioning/dashboards/platform-overview.json` is
auto-provisioned on Grafana startup (no manual dashboard import needed)
with panels for: queue depth by worker, DLQ depth, jobs by status, API
request rate, API P95 latency, worker throughput, worker P95 processing
duration, and active jobs per worker. See migration.md §12 for the
PromQL/LogQL behind each panel.

## Alerting (design, not wired to a notification channel)

Prometheus Alertmanager isn't included in `docker-compose.yml` (would
need a real notification target — Slack/PagerDuty/email — to be
meaningful, which is out of scope for local dev). Suggested rules if
wiring this up in production:

```yaml
- alert: DeadLetterQueueGrowing
  expr: increase(dead_letter_queue_depth[15m]) > 0
  for: 5m
  annotations:
    summary: "Jobs are landing in the dead-letter queue for {{ $labels.worker }}"

- alert: HighApiErrorRate
  expr: sum(rate(http_requests_total{status_code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05
  for: 5m

- alert: QueueBacklogGrowing
  expr: increase(queue_depth[10m]) > 500
  for: 10m
  annotations:
    summary: "{{ $labels.worker }} queue depth grew by more than 500 in 10 minutes - consider scaling"

- alert: WorkerNotProcessing
  expr: queue_depth > 0 and rate(worker_jobs_completed_total[10m]) == 0
  for: 10m
  annotations:
    summary: "Jobs are queued for {{ $labels.worker }} but nothing is completing - check worker health"
```
