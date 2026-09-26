# API Reference

Interactive, always-current docs are served by Swagger at `/docs` once
the API is running (`http://localhost:8080/docs` behind NGINX, or
`http://localhost:3000/docs` directly). This file is a quick reference;
migration.md §8 has full curl walkthroughs.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create an account, returns a JWT |
| POST | `/auth/login` | — | Exchange credentials for a JWT |
| POST | `/auth/logout` | — | Stateless — client discards the token (see docs/decisions.md) |
| POST | `/assets/upload-url` | JWT | Get a presigned URL to PUT a file directly to object storage |
| POST | `/assets` | JWT | Confirm an upload finished; creates the Asset and enqueues processing jobs |
| GET | `/assets` | JWT | List the caller's assets (`?status=`, `?page=`, `?pageSize=`) |
| GET | `/assets/:id` | JWT | Asset details, including ready variants with presigned download URLs |
| DELETE | `/assets/:id` | JWT | Delete an asset, its variants, and the underlying storage objects |
| GET | `/assets/:id/jobs` | JWT | Processing jobs for an asset |
| GET | `/jobs/:id` | JWT | A single job's full detail (attempt count, failure reason, timestamps) |
| POST | `/jobs/:id/retry` | JWT | Manually retry a `FAILED` or `DEAD_LETTER` job (resets to attempt 1) |
| GET | `/admin/stats` | JWT | Aggregate counts for the operations dashboard |
| GET | `/admin/jobs/failed` | JWT | Recent `FAILED`/`DEAD_LETTER` jobs, any user's, for inspection |
| GET | `/health` | — | Liveness/readiness: checks Postgres and Redis connectivity |
| GET | `/metrics` | — | Prometheus-format metrics |

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
