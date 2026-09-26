# Migration & Operations Guide

This is the human execution guide for everything the application code
cannot do for you: installing tools, provisioning cloud resources,
running migrations, and deploying. If you're setting this project up
for the first time, start at section 1 and work down.

---

## 1. Local Setup

### Required software

| Tool | Version | Why |
|---|---|---|
| Docker | 24+ | Runs every service; this is the only hard requirement |
| Docker Compose | v2 (bundled with Docker Desktop) | Orchestrates local services |
| Node.js | 20.x | Only needed if you want to run a service outside Docker for debugging |
| npm | 10.x | Comes with Node 20 |

You do **not** need Postgres, Redis, MinIO, or FFmpeg installed on your
host — they all run in containers.

### Commands

```bash
git clone <this-repo>
cd media-platform
cp .env.example .env          # edit if you want non-default credentials
docker compose -f infra/docker/docker-compose.yml up --build
```

First boot will:
1. Build the API, three workers, and the frontend images.
2. Start Postgres, Redis, and MinIO and wait for their health checks.
3. Run `prisma migrate deploy` against Postgres (baked into the API's
   container command — see `infra/docker/docker-compose.yml`).
4. Auto-create the MinIO bucket (dev convenience only — see
   `StorageService.ensureDevBucket`; production buckets are created
   manually, section 3).

When it settles:

| Service | URL |
|---|---|
| App (via NGINX) | http://localhost:8080 |
| API directly | http://localhost:3000 |
| API docs (Swagger) | http://localhost:3000/docs |
| MinIO console | http://localhost:9001 |
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |

To scale workers independently (see docs/scaling.md):

```bash
docker compose -f infra/docker/docker-compose.yml up --build \
  --scale image-worker=2 --scale video-worker=4 --scale thumbnail-worker=2
```

---

## 2. Environment Variables

All variables are documented in `.env.example` at the repo root. Copy it
to `.env` before running compose.

| Name | Purpose | Required? | Example | Where to obtain it |
|---|---|---|---|---|
| `NODE_ENV` | Runtime mode | Yes | `development` / `production` | You set this |
| `PORT` | API listen port | Yes | `3000` | You choose |
| `DATABASE_URL` | Postgres connection string | Yes | `postgresql://user:pass@host:5432/db` | Built from Postgres credentials, section 5 |
| `REDIS_URL` | Redis connection string | Yes | `redis://host:6379` | Your Redis provider, section 6 |
| `JWT_SECRET` | Signs auth tokens | Yes | 64+ random chars | Generate with `openssl rand -hex 32` |
| `JWT_EXPIRES_IN` | Token lifetime | No (defaults to `1h`) | `1h` | You choose |
| `RATE_LIMIT_WINDOW_SECONDS` | Rate-limit window | No (default `60`) | `60` | You choose |
| `RATE_LIMIT_MAX_REQUESTS` | Requests/window/user | No (default `100`) | `100` | You choose |
| `ASSET_CACHE_TTL_SECONDS` | Asset metadata cache TTL | No (default `30`) | `30` | You choose |
| `S3_ENDPOINT` | Object storage endpoint | Yes | `http://minio:9000` (local) / `https://s3.us-east-1.amazonaws.com` (prod) | MinIO (local) or AWS Console (prod) |
| `S3_REGION` | Bucket region | Yes | `us-east-1` | AWS Console, or arbitrary for MinIO |
| `S3_ACCESS_KEY` | Storage access key | Yes | — | MinIO root user (local) or IAM user (prod) |
| `S3_SECRET_KEY` | Storage secret key | Yes | — | Same as above |
| `S3_BUCKET` | Bucket name | Yes | `media-platform` | You create this, section 3 |
| `S3_FORCE_PATH_STYLE` | Path-style S3 addressing | Yes | `true` (MinIO), `false` (AWS) | — |
| `METRICS_PORT` | Worker metrics port | No (default `9100`) | `9100` | You choose |
| `VITE_API_BASE_URL` | Frontend's API base URL | Yes (build-time) | `http://localhost:8080/api` | Wherever NGINX/API is reachable |

Never commit a real `.env` — it's gitignored. `.env.example` contains
placeholder values only.

---

## 3. Object Storage Setup

### Local (MinIO)

Handled automatically: `docker compose up` starts MinIO and the API
creates the `media-platform` bucket (with a permissive dev CORS policy)
on first boot if it doesn't exist. You can inspect it at
http://localhost:9001 with the `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`
from your `.env`.

### Production (AWS S3 or another S3-compatible provider)

The app never auto-creates buckets outside development. Do this once,
manually:

1. **Create the bucket**
   ```bash
   aws s3api create-bucket --bucket media-platform-prod --region us-east-1
   ```
2. **Block public access** (the app serves files via presigned URLs, not
   public bucket policy):
   ```bash
   aws s3api put-public-access-block --bucket media-platform-prod \
     --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   ```
3. **Configure CORS** so browsers can PUT directly to presigned URLs:
   ```json
   [
     {
       "AllowedMethods": ["GET", "PUT"],
       "AllowedOrigins": ["https://your-domain.com"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```
   ```bash
   aws s3api put-bucket-cors --bucket media-platform-prod --cors-configuration file://cors.json
   ```
4. **Lifecycle policy (optional)** — if you want to auto-expire
   originals after variants are generated, or clean up abandoned
   `UPLOADING`-status uploads that never got confirmed:
   ```bash
   aws s3api put-bucket-lifecycle-configuration --bucket media-platform-prod --lifecycle-configuration file://lifecycle.json
   ```
   This is **not implemented** by the app itself — see docs/decisions.md
   "Future enhancements" for why orphaned-upload cleanup is out of scope
   for v1.
5. **Presigned URL configuration** — no bucket-side config needed; this
   is controlled entirely by `StorageService` (upload URLs expire after
   15 minutes, download URLs after 1 hour). Adjust the constants in
   `apps/api/src/storage/storage.service.ts` if you need different TTLs.

---

## 4. AWS / Cloud Provider Setup

If deploying to AWS, the manual steps beyond the bucket (section 3) are:

```text
[ ] Create an IAM policy scoped to the bucket:
      s3:PutObject, s3:GetObject, s3:HeadObject, s3:DeleteObject
      on arn:aws:s3:::media-platform-prod/*
[ ] Create an IAM user (or role, if running on EKS/ECS with IRSA) and
    attach the policy above
[ ] Generate an access key pair for that user (skip if using IRSA —
    then no static keys are needed at all)
[ ] Provision managed Postgres (RDS) and Redis (ElastiCache) — see
    docs/scaling.md for why these are NOT run inside Kubernetes
[ ] Note the RDS/ElastiCache endpoints for DATABASE_URL / REDIS_URL
[ ] Configure environment variables (section 2) in your deployment
    platform's secret store — never in source control
```

IAM least-privilege example policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:HeadObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::media-platform-prod/*"
    }
  ]
}
```

---

## 5. Database Migration

```bash
# Create the database (if it doesn't already exist)
createdb media_platform

# Run pending migrations (development, interactive — will prompt to
# name a new migration if the schema changed)
cd apps/api
npx prisma migrate dev

# Run pending migrations (production/CI — non-interactive, applies
# committed migration files only, never generates new ones)
npx prisma migrate deploy

# Seed (creates nothing destructive — see prisma/seed.ts)
npx prisma db seed

# Rollback
# Prisma Migrate has no automatic "down" migration. To roll back:
#   1. Identify the last-known-good migration in prisma/migrations/
#   2. Write a new forward migration that undoes the change (preferred), OR
#   3. Restore the database from a snapshot taken before the migration ran
#      (see section 15, Rollback, for why (2) is strongly preferred over (3))
```

In `docker compose`, migrations run automatically as part of the API
container's startup command (`prisma migrate deploy && node dist/main.js`)
— see section 10.

---

## 6. Redis Setup

### Local

Runs as the `redis` service in `docker-compose.yml` with
`--appendonly yes` (AOF persistence), so streams and job state survive a
container restart during development.

### Production

Use a managed Redis (ElastiCache, Upstash, Redis Cloud, etc.) or a
self-managed cluster with persistence enabled. Requirements:

- **Persistence**: AOF or RDB snapshotting must be on. Redis Streams
  (the job queue) are not durable across a Redis restart otherwise —
  in-flight jobs would be silently lost, which defeats the entire
  reliability story documented in docs/failure-handling.md.
- **maxmemory-policy**: set to `noeviction`. The default `volatile-lru`
  or similar eviction policies can silently drop stream entries under
  memory pressure; this queue must never lose data by "helpfully"
  evicting it.
- **Connection URL**: `REDIS_URL=redis://:<password>@<host>:<port>`
  (use `rediss://` for TLS).

---

## 7. FFmpeg

FFmpeg is required by `video-worker` and `thumbnail-worker` (via
`fluent-ffmpeg`, which shells out to the system binary — it is not
bundled in the npm package).

**In Docker**: already handled. Both workers' Dockerfiles install it via
`apt-get install ffmpeg` in the runtime stage.

**Running a worker outside Docker** (e.g. local debugging):

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt-get update && sudo apt-get install ffmpeg

# Verify
ffmpeg -version
```

Minimum tested version: FFmpeg 6.x. Ensure `ffmpeg` is on `PATH` — the
worker calls it by name, not by absolute path.

---

## 8. API Usage

Full request/response examples. All endpoints are also documented
interactively at `/docs` (Swagger UI) once the API is running.

### 1. Register

```bash
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "at-least-8-chars"}'
```
```json
{
  "user": { "id": "3f2a...", "email": "you@example.com", "createdAt": "2026-09-17T10:00:00.000Z" },
  "accessToken": "eyJhbGciOi..."
}
```

### 2. Login

```bash
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "at-least-8-chars"}'
```
Response: same shape as register. Save `accessToken`:
```bash
export TOKEN="eyJhbGciOi..."
```

### 3. Request an upload URL

```bash
curl -X POST http://localhost:8080/api/assets/upload-url \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"fileName": "vacation.mp4", "mimeType": "video/mp4", "fileSize": 52428800}'
```
```json
{ "uploadUrl": "http://localhost:9000/media-platform/uploads/...", "storageKey": "uploads/3f2a.../abcd-vacation.mp4", "expiresIn": 900, "method": "PUT" }
```

### 4. Upload the file directly to storage

```bash
curl -X PUT "$UPLOAD_URL" -H "Content-Type: video/mp4" --data-binary @vacation.mp4
```

### 5. Confirm the upload (creates the asset, enqueues processing jobs)

```bash
curl -X POST http://localhost:8080/api/assets \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"storageKey": "uploads/3f2a.../abcd-vacation.mp4", "fileName": "vacation.mp4", "mimeType": "video/mp4"}'
```
```json
{ "id": "9a1c...", "fileName": "vacation.mp4", "status": "PROCESSING", "kind": "VIDEO", "fileSize": 52428800 }
```

### 6. Check processing status

```bash
curl http://localhost:8080/api/assets/9a1c... -H "Authorization: Bearer $TOKEN"
curl http://localhost:8080/api/assets/9a1c.../jobs -H "Authorization: Bearer $TOKEN"
```
`status` moves `PROCESSING` → `READY` (or `FAILED` if a job hit DEAD_LETTER).

### 7. Retrieve processed variants

Once `status: "READY"`, the asset detail response includes a
`variants` array with presigned `downloadUrl`s (1-hour expiry):
```json
{ "variants": [{ "type": "VIDEO_THUMBNAIL", "downloadUrl": "http://...", "width": 640 }] }
```

### Error examples

```json
// 401 - bad credentials
{ "statusCode": 401, "error": "Unauthorized", "message": "Invalid email or password" }

// 404 - not found / not yours
{ "statusCode": 404, "error": "Not Found", "message": "Asset not found" }

// 429 - rate limited
{ "statusCode": 429, "error": "Too Many Requests", "message": "Rate limit exceeded" }

// 400 - validation
{ "statusCode": 400, "error": "Bad Request", "message": ["mimeType must start with one of: image/, video/"] }
```

---

## 9. Frontend Configuration

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Build-time base URL the SPA calls. Set to `/api` when served behind the bundled NGINX (default), or an absolute URL if hosting the frontend separately from the API. |

```bash
cd apps/frontend
npm install
npm run dev          # http://localhost:5173 - set VITE_API_BASE_URL to your API's full URL for standalone dev
npm run build         # outputs to dist/, served by nginx.conf in the Docker image
```

In `docker-compose.yml`, NGINX (section 10) serves the built frontend at
`/` and proxies `/api/*` to the API — the frontend never needs CORS
configured against the API in that setup.

---

## 10. Docker Deployment

```bash
# Start everything (build if images don't exist)
docker compose -f infra/docker/docker-compose.yml up -d

# Rebuild after code changes
docker compose -f infra/docker/docker-compose.yml up -d --build

# Restart one service
docker compose -f infra/docker/docker-compose.yml restart api

# Tail logs
docker compose -f infra/docker/docker-compose.yml logs -f api
docker compose -f infra/docker/docker-compose.yml logs -f image-worker video-worker thumbnail-worker

# Stop everything (keeps volumes/data)
docker compose -f infra/docker/docker-compose.yml stop

# Stop and remove containers (keeps volumes/data)
docker compose -f infra/docker/docker-compose.yml down

# Full clean slate - DESTROYS all data (Postgres, Redis, MinIO, Grafana)
docker compose -f infra/docker/docker-compose.yml down -v

# Reset only the database
docker compose -f infra/docker/docker-compose.yml stop api image-worker video-worker thumbnail-worker
docker compose -f infra/docker/docker-compose.yml exec postgres \
  psql -U media -c "DROP DATABASE media_platform;" -d postgres
docker compose -f infra/docker/docker-compose.yml exec postgres \
  psql -U media -c "CREATE DATABASE media_platform;" -d postgres
docker compose -f infra/docker/docker-compose.yml up -d
```

---

## 11. Kubernetes Deployment

See `infra/k8s/` for manifests. This section is the runbook for using
them; docs/scaling.md explains the reasoning.

### Prerequisites

```text
[ ] A running cluster (EKS, GKE, or any conformant cluster) with kubectl configured
[ ] Managed Postgres and Redis already provisioned (section 4) - this
    project does NOT run stateful Postgres/Redis inside Kubernetes
[ ] An ingress controller installed (e.g. ingress-nginx)
[ ] (Optional, for queue-depth autoscaling) KEDA installed:
      helm repo add kedacore https://kedacore.github.io/charts
      helm install keda kedacore/keda --namespace keda --create-namespace
```

### Commands

```bash
kubectl create namespace media-platform

# Secrets (never commit real values - see infra/k8s/secrets.example.yaml)
kubectl -n media-platform create secret generic app-secrets \
  --from-literal=DATABASE_URL="postgresql://..." \
  --from-literal=REDIS_URL="redis://..." \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=S3_ACCESS_KEY="..." \
  --from-literal=S3_SECRET_KEY="..."

# Non-secret config
kubectl apply -f infra/k8s/configmap.yaml

# Migrations - run once as a Job, before rolling out the API
kubectl apply -f infra/k8s/migration-job.yaml
kubectl -n media-platform wait --for=condition=complete job/db-migrate --timeout=120s

# Application
kubectl apply -f infra/k8s/api-deployment.yaml
kubectl apply -f infra/k8s/api-service.yaml
kubectl apply -f infra/k8s/image-worker-deployment.yaml
kubectl apply -f infra/k8s/video-worker-deployment.yaml
kubectl apply -f infra/k8s/thumbnail-worker-deployment.yaml
kubectl apply -f infra/k8s/ingress.yaml

# Autoscaling (requires KEDA; see docs/scaling.md for the queue-depth trigger design)
kubectl apply -f infra/k8s/keda-scaledobjects.yaml

kubectl -n media-platform get pods -w
```

---

## 12. Monitoring Setup

| Tool | Local URL | Notes |
|---|---|---|
| Grafana | http://localhost:3001 | Login with `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD` from `.env`. Prometheus and Loki datasources, and the "Media Platform Overview" dashboard, are auto-provisioned. |
| Prometheus | http://localhost:9090 | Raw metrics browser / query UI. |
| Loki | (queried through Grafana's Explore tab) | |

Useful PromQL queries (also on the provisioned dashboard):

```promql
queue_depth
dead_letter_queue_depth
sum(rate(http_requests_total{status_code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
sum(rate(worker_jobs_completed_total[1m])) by (job_type)
```

Useful LogQL query (Grafana Explore, Loki datasource):
```logql
{service="video-worker"} | json | level="error"
```

In production, never hard-code `GRAFANA_ADMIN_PASSWORD` - inject it from
your secret manager the same way as `JWT_SECRET`.

---

## 13. External Services / API Keys

| Service | Why Required | API Key Required | Where to Get It | Configuration |
|---|---|---|---|---|
| AWS S3 (or MinIO locally) | Object storage for originals and variants | Yes (S3) / No (MinIO) | AWS Console -> IAM | `.env` (`S3_*`) |
| PostgreSQL | Metadata store | No (connection string, not an API key) | Your Postgres provider | `.env` (`DATABASE_URL`) |
| Redis | Job queue, cache, rate limiting | No | Your Redis provider | `.env` (`REDIS_URL`) |

No other third-party services (Sentry, a CDN provider, etc.) are wired
into the code as shipped. If you add one, add a row here.

---

## 14. Production Migration Checklist

```text
[ ] Provision managed PostgreSQL and Redis (section 4)
[ ] Configure production DATABASE_URL / REDIS_URL
[ ] Run `npx prisma migrate deploy` against production DB
[ ] Create production S3 bucket (section 3)
[ ] Configure bucket CORS and public-access-block
[ ] Create IAM policy + user/role scoped to that bucket
[ ] Configure all secrets in your platform's secret manager (never in git)
[ ] Configure domain + DNS
[ ] Configure TLS (e.g. via ingress-nginx + cert-manager, or your LB)
[ ] Deploy API (section 11)
[ ] Deploy all three workers
[ ] Point Prometheus/Grafana/Loki at the production cluster
[ ] Configure database backups (e.g. RDS automated snapshots)
[ ] Configure alerts (see docs/observability.md "Alerting")
[ ] Run smoke test: GET /health returns 200
[ ] Run upload test: full register -> upload-url -> PUT -> confirm cycle
[ ] Run processing test: confirm an asset, verify variants appear
[ ] Test worker failure: kill a worker mid-job, confirm XAUTOCLAIM recovery
[ ] Test retry mechanism: force a job to fail, confirm RETRY -> backoff -> COMPLETED or DEAD_LETTER
```

---

## 15. Rollback

### Application deployment

Kubernetes: `kubectl -n media-platform rollout undo deployment/api` (and
per-worker equivalents). Docker Compose: redeploy the previous image tag
- compose has no built-in rollback, so tag images with a version/SHA
rather than relying on `:latest` in production.

### Database migration

**Destructive** - Prisma Migrate has no automatic "down". Prefer writing
a new forward migration that reverses the change over restoring a
snapshot, because a snapshot restore loses every write made after the
snapshot was taken (every asset uploaded, every job processed since).
Only restore from snapshot if the migration corrupted data in a way no
forward migration can fix.

### Worker version

Workers are stateless consumers - rolling back is just redeploying the
previous image tag for that worker's Deployment. In-flight jobs are safe
across a worker version change: unacked stream entries survive in Redis
and are picked up by whichever version's replica claims them next.

### Configuration

Kubernetes: `kubectl apply` the previous ConfigMap/Secret manifest (keep
them in version control). Docker Compose: revert `.env` and
`docker compose up -d` to apply.

**Never destructive** unless explicitly noted above: application and
worker rollbacks. **Always destructive**: `docker compose down -v`,
restoring a database snapshot, and deleting a dead-letter stream entry
before investigating it.
