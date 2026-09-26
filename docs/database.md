# Database

Schema source of truth: `apps/api/prisma/schema.prisma`.

## Entity relationships

```text
User (1) ----< (many) Asset (1) ----< (many) ProcessingJob
                  |                        |
                  |                        | (1:1, nullable)
                  +----< (many) AssetVariant
```

- A `User` owns many `Asset`s.
- An `Asset` has many `ProcessingJob`s (one per transformation requested
  on upload) and many `AssetVariant`s (one per completed transformation).
- Library tables (added in migration `20260919000000_library_platform`):
  `Collection` ↔ `Asset` (many-to-many via `collection_assets`), `Tag` ↔ `Asset`
  (via `asset_tags`, tags are per-user and unique by name), `ShareLink`
  (targets exactly one asset **or** collection, enforced by a `CHECK`), and
  `ActivityLog` (append-only audit trail with a denormalised `entityName`
  so entries still read correctly after the entity is deleted).
- `Asset` gained `title`, `description`, `isFavorite`, `deletedAt` (trash),
  and metadata columns filled by the metadata-worker (`width`, `height`,
  `durationMs`, `dominantColor`, `capturedAt`, `metadata` JSONB).
  `User` gained `role`, `displayName`, `storageQuotaBytes`.
- Indexes added for the library's hot paths: `(ownerId, deletedAt, createdAt DESC)`
  (every library view) and `(ownerId, isFavorite)`.
- A `ProcessingJob` produces at most one `AssetVariant` (the
  `AssetVariant.jobId` foreign key is unique) — a job either hasn't
  completed yet (no variant) or completed exactly once (one variant).
  This 1:1 is nullable rather than required because a job can exist
  (PENDING/PROCESSING/FAILED) with no variant yet.

## Why these four tables and no more

The brief's minimum entity list (`users`, `assets`, `processing_jobs`,
`asset_variants`) maps directly onto the two things this system actually
needs to track: "what did the user upload" (Asset) and "what happened to
it" (ProcessingJob + AssetVariant, separated because a job is a
unit-of-work record with retry/failure state, while a variant is the
successful *result* of one — conflating them would mean either
retry/failure columns on every successful variant row, or losing the
attempt history once a job succeeds).

## Indexing decisions

| Index | On | Why |
|---|---|---|
| `assets(ownerId, createdAt DESC)` | Asset | The dashboard's primary query is "this user's assets, newest first" (`GET /assets`). Composite index serves both the equality filter and the sort without a separate sort step. |
| `assets(ownerId, status)` | Asset | Dashboard filtering by status ("show me my FAILED assets") is a second common access pattern on the same table; a separate composite avoids relying on the first index's leading column alone doing an inefficient scan when status is the primary filter. |
| `processing_jobs(status, scheduledAt)` | ProcessingJob | Two consumers of this exact shape: the admin dashboard's "queue depth"/"oldest pending job" queries, and `RetrySchedulerService`'s sweep (`WHERE status = 'RETRY' AND scheduledAt <= now()`), which runs every 5 seconds and must not table-scan. |
| `processing_jobs(assetId)` | ProcessingJob | `GET /assets/:id/jobs` and the asset-status recomputation query both fetch "all jobs for this asset." |
| `processing_jobs UNIQUE(assetId, idempotencyKey)` | ProcessingJob | The idempotency guarantee itself — see docs/decisions.md. Doubles as an index for the lookup `job-producer.service.ts` does on conflict. |
| `asset_variants UNIQUE(assetId, type, storageKey)` | AssetVariant | Second-layer idempotency guard at the point a variant is actually persisted (belt-and-suspenders beneath the job-level constraint — see docs/decisions.md). |
| `asset_variants(assetId)` | AssetVariant | Asset detail responses join in all variants for one asset. |

No index was added on `users.email` beyond the implicit one from its
`@unique` constraint — Postgres/Prisma creates that automatically, and
login is the only query against it.

## Why `fileSize` is `BigInt`

Video files can comfortably exceed the 2^31 byte ceiling of a 32-bit
integer (the max upload size validated in `CreateUploadUrlDto` is 5GB).
Postgres `bigint` and Prisma's `BigInt` type avoid silent overflow;
`AssetsService.toResponse` converts to `Number` only at the API
boundary, where a 5GB file size is still well within `Number`'s safe
integer range.

## Why job `params` and job `idempotencyKey` are separate columns

`params` is the human-readable record of what was requested (`{width:
480}`) — useful for debugging and displayed in the admin dashboard's job
inspector. `idempotencyKey` is the derived hash used for the uniqueness
constraint. Storing both means a developer investigating a stuck job
never has to recompute the hash by hand to understand what it represents.

## Cascade behavior

`Asset.owner` and `ProcessingJob.asset` cascade `onDelete: Cascade` —
deleting a user deletes their assets, deleting an asset deletes its jobs
and variants. `AssetVariant.job` uses `onDelete: SetNull` instead: if a
job row were ever deleted independently of its variant (not a flow this
app currently exposes, but schema-safe regardless), the variant survives
as an orphaned-but-intact record rather than being cascade-deleted for
no reason.


## Migrations

`apps/api/prisma/migrations/` holds reviewed SQL:

| Migration | Contents |
|---|---|
| `20260916000000_init` | The original four tables and enums |
| `20260919000000_library_platform` | Everything above; purely additive (nullable columns / defaults) |

`npm run db:check-drift --workspace apps/api` (needs `DATABASE_URL`) compares
the live database with `schema.prisma` — tables, columns, types, nullability,
unique constraints, foreign keys with their `ON DELETE` rule, and enum values.
It matters here because the workers write to Postgres with hand-written SQL
(`JobStore`), which Prisma cannot type-check. Run it in CI after
`prisma migrate deploy`.
