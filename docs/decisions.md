# Engineering Decisions

Each section is a decision this project made, the alternatives
considered, and why. Code comments point back here rather than
repeating the reasoning inline.

---

## Idempotency: content-derived hash, not a client-supplied key

**Decision**: `idempotencyKey = sha256(assetId + ":" + transformationType + ":" + sortedParamsJSON)`,
enforced by a `UNIQUE(assetId, idempotencyKey)` constraint on
`processing_jobs`, and a second `UNIQUE(assetId, type, storageKey)`
constraint on `asset_variants` as a belt-and-suspenders guard at the
point variants are actually written.

**Alternatives considered**:
- *Client-supplied idempotency key* (like Stripe's `Idempotency-Key`
  header): rejected because there's no "client" retry scenario here —
  the risk is internal (duplicate enqueue, redelivered stream message),
  not an external caller retrying a POST.
- *jobId as the idempotency key*: doesn't work — a new job row (new
  jobId) could still describe the same logical transformation as an
  existing one if something enqueues twice.

**Why this works**: the key is a pure function of "what transformation,
on what asset, with what parameters" — enqueue the same logical job
twice (API bug, user double-click before the button disables) and it
collides on the DB constraint and simply returns the existing job rather
than creating a duplicate. See `packages/shared/src/idempotency.ts`.

**Trade-off accepted**: if two different parameter sets should
*semantically* produce the same output (e.g. `{width:480}` vs
`{w:480}`), they won't collide unless params are normalized first. We
don't normalize key names — every job producer must use the same
parameter shape. Acceptable because there's exactly one producer
(`AssetsService.defaultJobsFor`).

---

## Redis Streams: per-worker-kind streams, not one shared queue

**Decision**: `stream:jobs:image-worker`, `stream:jobs:video-worker`,
`stream:jobs:thumbnail-worker` — separate streams, separate consumer
groups, routed by `JOB_TYPE_TO_WORKER` at enqueue time.

**Why not one stream with type filtering?** A single stream forces every
consumer group to either process every message type (defeating
independent scaling) or skip-and-requeue messages meant for other
workers, which is wasteful and racy. Separate streams give true
head-of-line isolation: a backlog of slow video transcodes can never
delay a thumbnail job, and `docker compose --scale` / Kubernetes HPA can
target each worker kind independently (see docs/scaling.md).

**Why Redis Streams over a dedicated queue product (SQS, RabbitMQ,
Kafka)?** The project already runs Redis for caching and rate limiting;
Streams give consumer groups, at-least-once delivery via XREADGROUP/XACK,
and crash recovery via XAUTOCLAIM — enough to build a real job queue
without adding another infrastructure dependency. A production system
processing enormous sustained volume might outgrow this and want Kafka
for partitioned ordering guarantees or SQS for fully managed operations;
that trade is deliberately not made here.

---

## Retry redelivery: DB-scheduled, not stream-redelivered

**Decision**: a failed job attempt is recorded as `RETRY` in Postgres
with a `scheduledAt` timestamp (now + exponential backoff), and picked
up later by `RetrySchedulerService`'s cron sweep, which publishes a
*brand-new* stream message. The original stream entry is ACKed
immediately, not left pending for XAUTOCLAIM to redeliver.

**Why not just leave the message unacked and let Redis redeliver it?**
Redis Streams has no native "redeliver after N seconds of backoff"
primitive — XAUTOCLAIM's idle threshold is for detecting a *crashed
consumer*, not for implementing exponential backoff. Overloading it for
both would mean either the backoff timer and the crash-detection timer
fight each other, or a retry and a crash-recovery redelivery of the same
entry could both fire and double-process a job. Keeping them separate —
Postgres owns "when should this logical attempt happen next",
Redis/XAUTOCLAIM owns "did the consumer that took this delivery die" —
means each mechanism does exactly one job.

**Trade-off accepted**: retry timing has up to 5 seconds of slop (the
sweep's cron interval) and depends on the API being up. If the API is
down, retries pause but resume correctly once it's back — nothing is
lost because the state lives in Postgres, not in a timer in memory.

---

## Rate limiting: fixed window, not sliding window or token bucket

**Decision**: `INCR` a key namespaced by `{userId}:{windowStart}`, `EXPIRE`
on first increment, reject once the count exceeds the limit.

**Why not sliding window or token bucket?** Both are more precise (no
burst-at-the-boundary behavior) but need either a sorted set with
per-request timestamps (more Redis memory and a ZREMRANGEBYSCORE cleanup
on every request) or a scheduled refill process. For "100
requests/minute/user", the fixed-window's worst case — up to 2x the
limit in a burst spanning a window boundary — is an acceptable trade for
two O(1) Redis commands and zero background maintenance.

**TTL and eviction**: the rate-limit key's own `EXPIRE` *is* the eviction
mechanism — no separate cleanup job, no unbounded key growth. Keys
naturally disappear `windowSeconds` after the window's first request.

---

## Redis cache: TTL choice for asset metadata

**Decision**: `GET /assets/:id` caches its response in Redis for
`ASSET_CACHE_TTL_SECONDS` (default 30s), keyed by `asset:{id}`, and
explicitly `DEL`s that key from `AssetsService.remove()` and could be
extended to invalidate on job completion (currently relies on TTL
expiry for that path — see "Future enhancements" below).

**Why 30 seconds?** Short enough that a user watching an asset go from
`PROCESSING` to `READY` on the dashboard never waits more than 30s past
actual completion even without explicit invalidation; long enough to
meaningfully absorb repeated polling (the frontend polls every 3-4s) —
roughly a 10x reduction in DB reads per active viewer.

**Known gap**: job completion (in `JobStore.completeJob`, running inside
a worker process, not the API) does not currently push a cache
invalidation for the asset it just finished — it only writes to
Postgres. The 30s TTL bounds the staleness this can cause. Explicitly
invalidating from the worker would require the worker to talk to the
API's Redis cache namespace, which is a reasonable v2 change (documented
as a future enhancement rather than implemented under time pressure).

---

## Workers use `pg`, not Prisma

**Decision**: `apps/api` uses Prisma for its full CRUD/query surface.
The three workers use plain parameterized SQL via the `pg` driver
(`packages/shared/src/worker/job-store.ts`).

**Why the split?** Prisma's generated client is tied to the package it's
generated into. Sharing one generated client across four independently
built and deployed services (api + 3 workers) means either committing a
generated-client build artifact or regenerating it per service — real
complexity for what is, on the worker side, five fixed SQL statements
(mark processing, complete + insert variant, fail + schedule retry,
recompute asset status). The API's much larger and more varied query
surface is where Prisma's ergonomics actually pay for themselves.

**Trade-off accepted**: the five SQL statements in `JobStore` must be
kept in sync with `prisma/schema.prisma` by hand — there's no
compile-time check linking them. Column names are written to match
Prisma's default camelCase mapping (`"assetId"`, `"createdAt"`, quoted
to preserve case) exactly.

---

## Auth: stateless JWT over server-side sessions

**Decision**: JWT bearer tokens, no session store, no refresh-token
rotation, no token blocklist for logout.

**Why not sessions?** The spec explicitly says "do not over-engineer
authentication." A session store adds a Redis (or DB) round trip to
every authenticated request and a session-invalidation story that isn't
needed for this project's scope.

**Trade-off accepted — logout is client-side only**: `/auth/logout` does
not invalidate the token server-side; the client just discards it. A
stolen token remains valid until it expires (`JWT_EXPIRES_IN`, default
1h). A real product would add a token blocklist (Redis, TTL'd to the
token's remaining lifetime) or move to short-lived access tokens with
refresh-token rotation. Documented here rather than silently shipped.

## Auth: no RBAC in v1

**Decision**: any authenticated user can view `/admin/*` endpoints
(operations dashboard). There is no role or permission model.

**Why not fake it?** A hardcoded `isAdmin` boolean not backed by any
real authorization logic would be worse than no RBAC at all — it
signals a security boundary that doesn't actually exist. Documented as
a future enhancement (see below) instead.

---

## Manual retry always resets to attempt 1

**Decision**: `POST /jobs/:id/retry` (the dashboard's retry button)
always sets `attempt = 0` and republishes as attempt 1, regardless of
how many attempts the job had already burned — including from
`DEAD_LETTER`, which the automatic retry sweep never touches.

**Why?** A human clicking "retry" is asserting "conditions have changed,
try again from scratch" (they fixed the FFmpeg config, the disk that
was full is no longer full, etc.), not "resume exactly where the
automatic backoff sequence left off." Automatic retries (which *do*
respect the running attempt count and `MAX_JOB_ATTEMPTS`) and manual
retries are deliberately different code paths for this reason.

---

## Asset status is derived, never written directly

**Decision**: `assets.status` is only ever set by
`JobStore.recomputeAssetStatus`, called after every job completion or
dead-lettering. Nothing else writes to it directly except the initial
`UPLOADING`/`PROCESSING` transitions in `AssetsService`.

**Why?** So "why is this asset READY / FAILED" always has exactly one
answer traceable to job state, instead of two independent state
machines (asset status, job status) that could drift out of sync.

---

## Future enhancements (explicitly not implemented)

Per the brief's instruction not to fake implementations: these are
real gaps, not oversights papered over.

- **RBAC / admin roles** — see "Auth: no RBAC in v1" above.
- **Refresh tokens / logout invalidation** — see "Auth: stateless JWT" above.
- **Cache invalidation on job completion from the worker side** — see
  "Redis cache: TTL choice" above; currently relies on TTL expiry.
- **Orphaned-upload cleanup** — an asset stuck in `UPLOADING` (client got
  a presigned URL, never actually uploaded, never confirmed) is never
  cleaned up automatically. A production system would add either an S3
  lifecycle rule on the `uploads/` prefix or a scheduled sweep job.
- **WebSocket/SSE push for status updates** — the frontend polls every
  3-4 seconds instead. Fine at this scale; a real product with many
  concurrent viewers would push updates instead of polling.
- **Multi-tenant / organization support** — assets are owned by
  individual users only.
