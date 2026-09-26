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

## Auth: role-based access control (ADMIN / USER)

**Decision**: users have a `role` (`USER` default, `ADMIN`). The role is a
claim in the JWT and `RolesGuard` enforces `@Roles(Role.ADMIN)` on
`/admin/*`. Admins are bootstrapped from the `ADMIN_EMAILS` env var
(promoted on register *and* login, so accounts that pre-date roles are
covered) and can then promote others from the Operations > Users page.

**Trade-off accepted**: because the role lives in a stateless token, a
demotion takes effect when the user's current token expires
(`JWT_EXPIRES_IN`, default 1h) — the same staleness the stateless-JWT
decision already accepts for logout. Checking the database on every
request would remove that gap but adds a query to every call; not worth it
for an admin-only surface. An admin can't demote themselves, so the last
admin can't lock everyone out of the page.

**Why `ADMIN_EMAILS` rather than "first user is admin"?** "First user wins"
is a race and a footgun on shared databases; an explicit allow-list is
auditable and works in Kubernetes via the ConfigMap.

---

## Real-time updates: SSE over Redis pub/sub, not WebSockets or polling

**Decision**: workers and the API publish small events
(`job.updated`, `asset.updated`, `asset.created`, ...) to a per-user Redis
channel (`events:user:{id}`). Every API replica `psubscribe`s once and fans
events out to that user's open `GET /events` streams (Server-Sent Events).

**Events are hints, not data.** They say "something changed, refetch";
Postgres stays the source of truth. So pub/sub's lack of delivery
guarantees is harmless: a lost event means a slightly late refresh, and
the client refetches everything on every (re)connect to cover the gap.
That is why no persistence, replay or ack machinery was built.

**Why SSE?** Updates are one-directional; SSE is plain HTTP (works through
the existing NGINX/ingress with buffering off — see the config), reconnects
by itself, and needs no sticky sessions because fan-out goes through Redis.
WebSockets would add bidirectional complexity nobody uses here.

**Auth without EventSource**: the browser `EventSource` cannot set an
`Authorization` header and a token in the URL would leak into proxy logs,
so the frontend consumes the stream with `fetch()` and parses the SSE
framing itself (~40 lines).

**Also fixes**: the asset-detail cache is now deleted when a worker event
passes through the API, so a client told "READY" never reads pre-completion
data from the 30 s cache (the old "worker-triggered invalidation" gap).
Polling remains as a fallback only while the stream is down *and* something
is still processing.

**Cost**: one long-lived connection per open tab. `connectionCount()` is
available for a metric; a per-user cap is a sensible next step.

---

## Soft delete (trash) with a retention sweep

**Decision**: `POST /assets/:id/trash` sets `deletedAt`; the library hides
trashed rows; `DELETE /assets/:id` remains the permanent, irreversible
delete (kept as-is for backward compatibility). `CleanupService` purges
assets trashed longer than `TRASH_RETENTION_DAYS` (default 30) hourly.

**Why not delete straight away?** Accidental deletion of media is the
worst thing a library can do. Trashed items still count toward the quota
(the bytes are still stored) until purged.

**Multi-replica safety**: every API replica schedules the crons, but each
run first takes a Redis lock (`SET NX EX`), so exactly one does the work
without a separate scheduler deployment.

---

## Orphaned uploads: swept, with a TTL far above the presign window

An upload that never reached `POST /assets` leaves an object with no row —
invisible and still billed. The daily sweep lists `uploads/`, and deletes
objects older than `ORPHAN_UPLOAD_TTL_HOURS` (24) that no asset references.
The TTL must be much larger than the 15-minute presigned-PUT lifetime so an
in-flight upload is never deleted under its owner. (An S3 lifecycle rule on
the prefix is the zero-code alternative in production; this works everywhere,
including MinIO.)

---

## Presigned URLs: browser-reachable endpoint + cache-stable signing

Two separate bugs/needs are solved in `StorageService`:

1. **Reachability.** In docker-compose the API talks to MinIO at
   `http://minio:9000`, a hostname a browser can't resolve, so presigned
   URLs signed against it can never work from a browser. Presigning uses a
   second client bound to `S3_PUBLIC_ENDPOINT` (defaults to `S3_ENDPOINT`,
   so real S3 needs no config).
2. **Cacheability.** A URL signed at "now" differs on every request, so the
   browser re-downloads every thumbnail on every list refresh — fatal for a
   library that refreshes live. Download URLs are signed against the
   *start of the current 30-minute window* with a 3-hour expiry, so the URL
   is identical for everyone inside a window (HTTP cache and any CDN work)
   and always has ≥2.5 h of validity left.

---

## Storage quotas count originals only

`storageQuotaBytes` (default 5 GiB, admin-editable) is compared with the sum
of *original* file sizes (including trash). Renditions are cheap to
regenerate and would make the number a user sees impossible to reason
about. The quota is checked twice: at `upload-url` (fast feedback) and again
at confirm using the *real* object size, deleting the object on failure —
because the size declared at upload-url time is client-supplied.

---

## metadata-worker: extracted onto the asset row, GPS deliberately dropped

**Decision**: a fourth worker consumes `METADATA_EXTRACT` jobs and writes
width/height/duration/dominant colour/EXIF/codec info onto the *asset*
(one transaction with marking the job complete), not into `asset_variants` —
there is no derived file. It follows the existing worker pattern exactly, so
retries, idempotency, DLQ, metrics and KEDA scaling all apply.

**Privacy**: photos routinely embed the exact GPS location of someone's
home. This platform can publish media via public links, so GPS is never
extracted or stored. Camera settings and capture time are kept.

**Robustness**: EXIF orientation 5–8 swaps reported width/height (so a phone
photo shows as portrait); videos are streamed to a temp file rather than
loaded into memory (uploads can be 5 GiB and a Node `Buffer` cannot hold
that). The other workers still use `downloadToBuffer` for video — moving them
to `downloadToFile` is a worthwhile follow-up.

---

## Public share links: capability URLs with layered limits

A link is a 192-bit random token (unguessable), optionally password-protected
(bcrypt hash), expiring, revocable, and never cached (`Cache-Control:
no-store`, `Referrer-Policy: no-referrer` on the SPA). Unknown and revoked
tokens both return 404 (indistinguishable); expired returns 410. Wrong
passwords are limited to 10 per (link, IP) per 15 minutes on top of the
per-IP request limiter (which needs `trust proxy`, now enabled, or every
visitor behind NGINX would share one bucket). A `CHECK` constraint
guarantees exactly one target per link even if service code regresses.

---

## Future enhancements (explicitly not implemented)

Per the brief's instruction not to fake implementations: these are
real gaps, not oversights papered over.

- **Refresh tokens / logout invalidation** — see "Auth: stateless JWT" above.
- **Resumable/multipart uploads** — each file is one presigned PUT (up to
  5 GiB). Unreliable mobile networks would benefit from S3 multipart with
  per-part retry; the client already retries once on transient errors.
- **Real search** — `q` is `ILIKE` over name/title/description/tags, fine
  to ~100k assets per user; beyond that add `pg_trgm` GIN indexes or a
  search engine.
- **Per-user cap on SSE connections**, and an `Idempotency-Key` on
  `POST /assets/bulk`.
- **Streaming downloads in the other workers** (see metadata-worker above).
- **Multi-tenant / organization support** — assets are owned by
  individual users only.
