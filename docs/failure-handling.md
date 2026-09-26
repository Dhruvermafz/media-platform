# Failure Handling

For each required scenario: what happens, and where in the code.

## API container dies

In-flight requests fail (client sees a connection error/timeout). No
data corruption: every write the API makes to Postgres is a single
transaction-scoped operation, and job enqueueing (`JobProducerService.enqueue`)
creates the DB row *before* publishing to the stream — if the process
dies between those two steps, the job simply never got enqueued and
sits as an orphaned PENDING row with no stream message. **Known gap**:
there's no sweep that detects "PENDING with no corresponding stream
entry" and republishes it; see docs/decisions.md future enhancements.
On restart (Kubernetes restarts the pod / Docker Compose's
`restart: unless-stopped` brings it back), `RetrySchedulerService`
resumes its sweep and the API resumes serving traffic — no manual
intervention needed for anything already past PENDING.

## Worker container dies

The job it was processing is left in `PROCESSING` status in Postgres
with its stream entry unacknowledged (XREADGROUP delivered it but XACK
never ran). `StreamConsumer.reclaimStale()` runs `XAUTOCLAIM` on every
loop iteration in every replica of that worker kind; once the entry has
been pending longer than `CLAIM_IDLE_MS` (30s), a live replica claims it
and reprocesses from scratch. This is why processing must be idempotent
(docs/decisions.md) — the reprocessing attempt uploads to the same
variant key and the `ON CONFLICT DO NOTHING` in `JobStore.completeJob`
absorbs a benign duplicate if the dead worker somehow finished writing
before dying.

## Redis temporarily unavailable

- **API**: `RedisService` is configured with an unbounded reconnect
  strategy (`retryStrategy`) rather than crashing. Requests that need
  Redis (rate limiting, cache reads, enqueueing) will error until it
  reconnects; requests that don't (most reads, since Postgres is the
  source of truth) continue to work.
- **Workers**: `ioredis`'s default reconnect behavior applies; a worker
  blocked on `XREADGROUP ... BLOCK` simply resumes once Redis is back.
  No jobs are lost — they were already durably queued in the stream
  before the outage (assuming AOF/RDB persistence is configured per
  migration.md §6; an unpersisted local Redis wiped mid-outage *would*
  lose unacked stream entries, which is exactly why production Redis
  must have persistence on).

## Database temporarily unavailable

API requests touching Postgres return 500s (surfaced via
`AllExceptionsFilter`) until it recovers; `PrismaService` doesn't crash
the process, Prisma's own connection pool retries transparently.
Workers calling `JobStore` methods will throw, which — per the
handler contract in `consumer-loop.ts` — leaves the stream entry unacked
(this is *not* a `FinalJobError`, so it's treated as worker-crash-style
recovery, not a job failure) and it's picked up again once Postgres is
back, by this replica or another.

## Worker receives duplicate job

Handled by design, not as an edge case: see idempotency in
docs/decisions.md. A duplicate delivery either (a) is the normal
XAUTOCLAIM-driven retry after a crash, where reprocessing is expected
and safe, or (b) would require the API to have enqueued genuinely the
same transformation twice, which the `UNIQUE(assetId, idempotencyKey)`
constraint on `processing_jobs` already prevents at creation time.

## FFmpeg processing fails

The worker's `catch` block (`video-worker/src/main.ts`,
`thumbnail-worker/src/main.ts`) calls `JobStore.failJob` with the error
message, which records `FAILED`/`RETRY` (or `DEAD_LETTER` once attempts
are exhausted) and the `failureReason` column — visible in the admin
dashboard's job inspector. FFmpeg errors (bad codec, corrupt input,
unsupported container) are almost always deterministic — retrying the
identical input won't fix them — so in practice these jobs typically
exhaust their 3 attempts and land in `DEAD_LETTER` for a human to
inspect the `failureReason` and asset directly.

## Object storage unavailable

Uploads: the presigned PUT the client makes goes straight to storage, so
this fails at the client, before the API is even involved in step 4
(confirm). Confirmation (`AssetsService.confirmUpload`) calls
`storage.objectExists`, which will itself fail/timeout if storage is
down — surfaced as a 500, safe to retry once storage recovers (no
partial Asset row is created if the HEAD check throws, since it's
awaited before any `prisma.asset.create` call). Workers: `downloadToBuffer`
or `upload` throwing is treated the same as any other processing
failure — caught, `failJob` called, retried with backoff.

## Job exceeds retry limit

`JobStore.failJob` compares `attempt >= maxAttempts` (default 3) and, if
exhausted, sets status to `DEAD_LETTER` instead of `RETRY`, sets
`recomputeAssetStatus` to mark the parent Asset `FAILED`, and the worker
throws `FinalJobError` so `consumer-loop.ts` pushes the original message
onto that worker's DLQ stream (`stream:dlq:{worker}`) before acking. The
DLQ stream is kept (not just a DB row) so an operator can inspect or
replay it with `XADD` after fixing whatever caused the failure — see
`docs/observability.md` for the Prometheus gauge tracking DLQ depth.

## Large upload

Not size-limited by the API's request body — the file never passes
through the API (direct-to-storage upload). `CreateUploadUrlDto`
validates `fileSize` against a 5GB ceiling before issuing a presigned
URL, which is a policy limit, not a technical one; raise
`MAX_FILE_SIZE_BYTES` in that DTO if a larger ceiling is needed.

## Queue suddenly receives thousands of jobs

Each worker kind's Redis Stream simply grows — Streams have no
practical size limit for this purpose, and `XLEN` (exposed as the
`queue_depth` Prometheus gauge) will show the spike immediately.
Consumer groups process at whatever rate their replica count and
per-job processing time allow; nothing is dropped, and `docs/scaling.md`
covers scaling worker replica counts (manually or via KEDA) in response
to sustained queue depth. See docs/load-testing.md for the burst test
that exercises this directly.
