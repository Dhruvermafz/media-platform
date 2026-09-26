# Distributed Media Processing Platform

A production-oriented system-design portfolio project: upload
images/videos, process them asynchronously into multiple variants
(thumbnails, resized/compressed images, transcoded video renditions),
track job status through a documented state machine, and serve the
results — built to demonstrate distributed-systems and backend
engineering practices, not to showcase UI.

## Quick start

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up --build
```

Then open http://localhost:8080 (app), http://localhost:3000/docs
(Swagger), http://localhost:3001 (Grafana). Full setup, every
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
  frontend/           React + Vite dashboard: upload, asset list/detail, ops dashboard
packages/
  shared/             Job/queue contracts, idempotency logic, worker utilities -
                       the single source of truth every service imports from
infra/
  docker/             docker-compose.yml + Prometheus/Grafana/Loki/Promtail config
  k8s/                Kubernetes manifests for v2 deployment
  nginx/              Reverse proxy config
scripts/
  load-test/          k6 load test scripts
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
5. **[docs/scaling.md](./docs/scaling.md)** and
   **[docs/observability.md](./docs/observability.md)** — independent
   worker scaling, the KEDA autoscaling design, metrics/logging/dashboards.
6. **[docs/api.md](./docs/api.md)** — endpoint reference (or just hit
   `/docs` for live Swagger).
7. **[docs/load-testing.md](./docs/load-testing.md)** — k6 scripts and
   how to interpret results.
8. **[migration.md](./migration.md)** — everything to actually run this:
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

## Known gaps

Explicitly documented rather than silently missing — see
"Future enhancements" in [docs/decisions.md](./docs/decisions.md): no
RBAC, no refresh-token rotation, no worker-triggered cache invalidation
(TTL-only), no orphaned-upload cleanup, no push-based status updates
(the dashboard polls).
