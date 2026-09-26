# API Reference

Interactive, always-current docs are served by Swagger at `/docs` once
the API is running (`http://localhost:8080/docs` behind NGINX, or
`http://localhost:3000/docs` directly). This file is a quick reference;
migration.md §8 has full curl walkthroughs.

## Endpoints

JWT = `Authorization: Bearer <token>`. Admin = JWT whose user has role `ADMIN`.

### Auth & account

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create an account (optional `displayName`); returns `{ user, accessToken }` |
| POST | `/auth/login` | — | Exchange credentials for a JWT |
| POST | `/auth/logout` | — | Stateless — client discards the token (see docs/decisions.md) |
| GET | `/me` | JWT | Profile incl. role and storage quota |
| PATCH | `/me` | JWT | Update display name |
| POST | `/me/password` | JWT | Change password (needs current password) |
| GET | `/me/usage` | JWT | Bytes used vs quota, counts, photo/video/trash breakdown |

### Assets

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/assets/upload-url` | JWT | Presigned PUT URL. **413 `QUOTA_EXCEEDED`** if it would exceed the quota |
| POST | `/assets` | JWT | Confirm an upload; creates the asset, enqueues jobs. Idempotent per `storageKey`. Optional `collectionId`, `tags` |
| GET | `/assets` | JWT | List with `q`, `kind`, `status`, `favorite`, `trashed`, `collectionId`, `tag`, `sort` (`createdAt|updatedAt|fileName|fileSize`), `order`, `page`, `pageSize` (≤100). Items include `thumbnailUrl`, `clipUrl`, and `pipeline` progress while processing |
| GET | `/assets/:id` | JWT | Detail: `variants[]` (each with `downloadUrl`), `previewUrl`, `originalUrl`, `metadata`, `collections` |
| PATCH | `/assets/:id` | JWT | `title`, `description`, `isFavorite` (empty string clears text) |
| PUT | `/assets/:id/tags` | JWT | Replace the asset's tag list (lower-cased, ≤20, ≤32 chars each) |
| POST | `/assets/:id/trash` · `/restore` | JWT | Soft delete / restore. Trash is purged after `TRASH_RETENTION_DAYS` |
| DELETE | `/assets/:id` | JWT | **Permanent** delete of the asset, variants and stored objects |
| GET | `/assets/:id/download` | JWT | `{ url, fileName }` — attachment URL for the original, or `?variantId=` |
| POST | `/assets/:id/variants` | JWT | Request an extra rendition: `IMAGE_RESIZE`, `IMAGE_COMPRESS`, `IMAGE_FORMAT_CONVERT`, `VIDEO_TRANSCODE`, `VIDEO_PREVIEW` (params are range-checked). Returns `{ job, created }` |
| POST | `/assets/bulk` | JWT | `{ ids (≤200), action }`: `trash`, `restore`, `delete`, `favorite`, `unfavorite`, `addToCollection`, `removeFromCollection`, `addTags` |
| GET | `/assets/:id/jobs` | JWT | Processing jobs for an asset |

### Collections, tags, sharing

| Method | Path | Auth | Description |
|---|---|---|---|
| GET/POST | `/collections` | JWT | List (with counts + cover thumbnails) / create. Duplicate name → 409 |
| GET/PATCH/DELETE | `/collections/:id` | JWT | Read / rename / delete (assets are kept) |
| GET | `/tags` | JWT | Tags with live usage counts |
| PATCH/DELETE | `/tags/:id` | JWT | Rename everywhere / remove from all assets |
| POST | `/shares` | JWT | Create a public link to one asset **or** one collection; optional `expiresInHours`, `password`, `allowDownload` |
| GET | `/shares` | JWT | Your links (`?assetId=` / `?collectionId=` to narrow) |
| DELETE | `/shares/:id` | JWT | Revoke immediately |
| GET | `/public/shares/:token` | — | Open a link (password in `x-share-password`). 404 unknown/revoked, 410 expired, 401 `PASSWORD_REQUIRED` / `PASSWORD_INVALID`, 429 `TOO_MANY_ATTEMPTS` |

### Jobs, activity, real time

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/jobs` | JWT | Your recent jobs across assets, with counts by status (`?status=`, `?limit=`) |
| GET | `/jobs/:id` | JWT | A single job's full detail |
| POST | `/jobs/:id/retry` | JWT | Manually retry a `FAILED`/`DEAD_LETTER` job (resets to attempt 1) |
| GET | `/activity` | JWT | Audit trail, newest first (`?limit=`, `?cursor=`) |
| GET | `/events` | JWT | **Server-Sent Events** stream: `ready`, `ping` (25 s), and `platform` events `{ id, ts, event }`. Send the JWT in the `Authorization` header (use `fetch` streaming; `EventSource` can't). Events are *refetch hints*, not data |

### Admin (role `ADMIN` — others get 403)

| Method | Path | Description |
|---|---|---|
| GET | `/admin/stats` | Queue depths, DLQ depths, active replicas per worker, job/asset counts, avg/p95 job time |
| GET | `/admin/jobs/failed` | Recent `FAILED`/`DEAD_LETTER` jobs from all users |
| POST | `/admin/jobs/:id/retry` | Retry any user's job |
| GET | `/admin/users` | Users with usage and quota |
| PATCH | `/admin/users/:id` | Change `role` or `storageQuotaBytes` (you can't demote yourself) |

### Ops

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness/readiness: checks Postgres and Redis |
| GET | `/metrics` | Prometheus-format metrics |

### Asset `metadata` (from `metadata-worker`)

Images: `format, colorSpace, hasAlpha, density, pages, camera, lens, exposure, aperture, iso, focalLengthMm`.
Videos: `container, videoCodec, audioCodec, audioChannels, fps, bitrateKbps, rotation, hasAudio`.
GPS coordinates are deliberately **not** extracted (privacy).

## Error shape

Every error response, regardless of cause, has this shape
(`AllExceptionsFilter`, `apps/api/src/common/filters/http-exception.filter.ts`):

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Asset not found",
  "path": "/assets/does-not-exist",
  "timestamp": "2026-09-17T10:00:00.000Z"
}
```

| Status | Meaning | Example cause |
|---|---|---|
| 400 | Validation error | Missing/malformed request body field |
| 401 | Authentication error | Missing/invalid/expired JWT, wrong login credentials |
| 403 | Authorization error | Valid JWT, but not the resource's owner |
| 404 | Resource not found | Asset/job doesn't exist, or belongs to another user (see below) |
| 409 | Conflict | Duplicate registration email; Prisma unique-constraint violation |
| 429 | Rate limit exceeded | More than `RATE_LIMIT_MAX_REQUESTS` in the current window |
| 500 | Internal error | Unhandled exception; logged server-side with a stack trace |

**Note on 404 vs 403 for ownership**: `GET /assets/:id` returns 404 (not
403) when the asset exists but belongs to another user — this avoids
confirming to an unauthorized caller that a given asset ID exists at
all. `GET /jobs/:id` does the reverse (403) because a job ID is not
guessable/enumerable the way sequential or predictable asset access
might be probed, and returning 403 there is clearer for legitimate
debugging. Both are deliberate per-endpoint choices, not an
inconsistency.

## Pagination

`GET /assets` uses `page`/`pageSize` query params (`pageSize` capped at
100), returning `{ items, total, page, pageSize }`. No cursor-based
pagination — offset pagination is sufficient at the scale a
single-user asset list reaches, and is simpler to implement correctly.
