# Distributed Media Processing Platform

A production-oriented system-design portfolio project: upload
images/videos, process them asynchronously into multiple variants
(thumbnails, resized/compressed images, transcoded video renditions),
track job status through a documented state machine, and serve the
results — built to demonstrate distributed-systems and backend
engineering practices. It now also ships a full media **library**
(collections, tags, favourites, trash, search, sharing, quotas) with a
responsive, installable web app that works on phones, tablets and desktops.

## Quick start

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up --build
```

Then open http://localhost:8080 (app), http://localhost:3000/docs
(Swagger), http://localhost:3001 (Grafana). Register any account; emails
listed in `ADMIN_EMAILS` (see `.env.example`) become admins and get the
Operations page.

**Just want to see the UI?** No Docker needed:

```bash
npm install && npm run dev:mock --workspace apps/frontend
# http://localhost:5173 - sign in with any email; demo@example.com is an admin
```

That runs an in-memory mock of the whole API (including live processing
events) - see [docs/frontend.md](./docs/frontend.md). Full setup, every
environment variable, and manual cloud-provisioning steps are in
[`migration.md`](./migration.md) — start there for anything beyond the
happy path above.

## What's here

```text
apps/
  api/                NestJS REST API - auth, asset metadata, job orchestration
  image-worker/       Consumes image jobs, transforms with Sharp
  video-worker/       Consumes video jobs, transforms with FFmpeg
  thumbnail-worker/   Consumes video-frame-thumbnail jobs, FFmpeg
  metadata-worker/    Extracts dimensions, duration, EXIF/codec info, dominant colour
  frontend/           React PWA: library, viewer, collections, sharing, live processing, admin
packages/
  shared/             Job/queue contracts, idempotency logic, worker utilities -
                       the single source of truth every service imports from
infra/
  docker/             docker-compose.yml + Prometheus/Grafana/Loki/Promtail config
  k8s/                Kubernetes manifests for v2 deployment
  nginx/              Reverse proxy config
scripts/
  load-test/          k6 load test scripts
  integration/        End-to-end worker pipeline test (real Postgres/Redis/S3/FFmpeg)
docs/                 Architecture, database, API, scaling, failure-handling,
                       observability, load-testing, and engineering decisions
migration.md          The human execution guide - local setup through production deploy
```

## How to read this repo, in order

1. **[docs/architecture.md](./docs/architecture.md)** — the end-to-end
   path a file takes, and why the system is shaped the way it is.
2. **[docs/decisions.md](./docs/decisions.md)** — every non-obvious
   engineering choice (idempotency strategy, retry design, rate
   limiting, why workers use `pg` instead of Prisma, auth trade-offs)
   with alternatives considered and trade-offs accepted. Code comments
   throughout the repo point back here rather than repeating the
   reasoning inline.
3. **[docs/database.md](./docs/database.md)** — schema and indexing
   rationale.
4. **[docs/failure-handling.md](./docs/failure-handling.md)** — what the
   system does for every failure scenario the brief requires (worker
   crash, Redis/DB outage, duplicate delivery, FFmpeg failure, retry
   exhaustion, storage outage, large uploads, queue bursts).
5. **[docs/frontend.md](./docs/frontend.md)** — the web app: design system,
   responsive shell, real-time updates, PWA, and the mock API.
6. **[docs/scaling.md](./docs/scaling.md)** and
   **[docs/observability.md](./docs/observability.md)** — independent
   worker scaling, the KEDA autoscaling design, metrics/logging/dashboards.
7. **[docs/api.md](./docs/api.md)** — endpoint reference (or just hit
   `/docs` for live Swagger).
8. **[docs/load-testing.md](./docs/load-testing.md)** — k6 scripts and
   how to interpret results.
9. **[migration.md](./migration.md)** — everything to actually run this:
   local setup, every env var, object storage setup (MinIO -> S3),
   database migrations, Kubernetes deployment, monitoring access,
   the production checklist, and rollback procedures.

## The smallest thing that works

Before adding auth, rate limiting, caching, Kubernetes, or the
observability stack, this was built to prove out one path first:

```text
Upload -> Store -> Create Job -> Queue -> Worker -> Process -> Store Result -> API -> Frontend
```

Everything else in this repo layers on top of that path. See
`docs/architecture.md` for how it works end to end.

## Testing

```bash
npm test --workspaces --if-present                       # unit tests (API, shared)
node scripts/integration/worker-pipeline.mjs             # workers vs real services (see header for env)
DATABASE_URL=... npm run db:check-drift --workspace apps/api   # migrations == schema.prisma
python3 apps/frontend/e2e/smoke.py                       # browser smoke test on the mock API
cd apps/api && npm run test:e2e                          # full-stack API flow (needs docker compose up)
```

## Known gaps

Explicitly documented rather than silently missing — see
"Future enhancements" in [docs/decisions.md](./docs/decisions.md):
no refresh-token rotation or server-side logout, uploads are a single
presigned PUT (no resumable multipart), search is `ILIKE` rather than a
search engine, and no multi-tenant/organisation model. (RBAC, worker-side
cache invalidation, orphaned-upload cleanup and push updates - previously
gaps - are now implemented; see the decisions doc.)
