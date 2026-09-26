# Load Testing

Tooling: [k6](https://k6.io). Scripts live in `scripts/load-test/`.

## Running

```bash
# Install k6: https://grafana.com/docs/k6/latest/set-up/install-k6/

# 1. API request load - ramps 0 -> 50 concurrent users hitting GET /assets and /health
k6 run --env BASE_URL=http://localhost:8080/api scripts/load-test/api-load.js

# 2. Queue burst - VUS concurrent uploads fire near-simultaneously,
#    each creating a job burst across all three worker streams
k6 run --env BASE_URL=http://localhost:8080/api --env VUS=200 scripts/load-test/queue-burst.js
```

While either is running, watch:
- Grafana's "Media Platform Overview" dashboard (http://localhost:3001)
  for queue depth, worker throughput, and API latency in real time.
- `docker stats` or the cAdvisor targets in Prometheus for container
  CPU/memory during the burst.

## What each test exercises

**`api-load.js`** — concurrent read-heavy API traffic (asset listing,
health checks). This is the scenario the rate limiter and connection
pooling need to survive without degrading; the k6 threshold config fails
the run automatically if P95 latency exceeds 1s or the error rate
exceeds 1%.

**`queue-burst.js`** — a large batch of asset confirmations fired in a
short window, each enqueueing 2-3 processing jobs. This directly
exercises "queue suddenly receives thousands of jobs" from
docs/failure-handling.md: watch `queue_depth` spike on the dashboard and
then drain as workers catch up, and watch `dead_letter_queue_depth`
stay flat (it should — these are trivially small, valid test images).

## What to record

This document intentionally does not hard-code specific throughput/
latency numbers — they depend entirely on the machine/cluster running
the test, worker replica counts, and instance sizing, and fabricating
numbers here would be actively misleading. After running a load test,
record actual results in a table like this (copy into a dated section
below or into your own run log):

| Metric | api-load.js | queue-burst.js (VUS=200) |
|---|---|---|
| Throughput (req/s or jobs/s) | | |
| P50 / P95 / P99 latency | | |
| Error rate | | |
| Peak queue depth | | |
| Time to drain queue back to 0 | | |
| Dead-letter count | | |

## Recovery after load

To specifically test recovery (not just steady-state throughput):
1. Run `queue-burst.js` with a large `VUS` value.
2. While the queue is still draining, kill one worker container:
   `docker compose -f infra/docker/docker-compose.yml stop image-worker`
3. Confirm `queue_depth{worker="image-worker"}` stops draining but does
   not error or lose entries (Redis just holds them).
4. Restart the worker: `docker compose -f infra/docker/docker-compose.yml start image-worker`
5. Confirm the backlog (including anything that was mid-flight when the
   container stopped — recovered via `XAUTOCLAIM`, docs/failure-handling.md)
   drains to zero and `dead_letter_queue_depth` does not increase.
