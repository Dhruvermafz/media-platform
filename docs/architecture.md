# Architecture

## The end-to-end path

```text
1. Client asks the API for a presigned upload URL (POST /assets/upload-url)
2. Client PUTs the file directly to object storage (MinIO/S3) - never through the API
3. Client confirms the upload (POST /assets)
4. API HEADs the object to verify it actually landed, then:
     - writes an Asset row (status: PROCESSING)
     - writes ProcessingJob rows for each required transformation
     - XADDs a job message onto the matching worker's Redis Stream
5. A worker (image/video/thumbnail) XREADGROUPs the message, downloads
   the original from storage, transforms it, uploads the variant
6. Worker writes an AssetVariant row and marks the job COMPLETED (or
   RETRY/DEAD_LETTER on failure), then recomputes the asset's status
7. Client polls GET /assets/:id and sees status flip to READY, with
   presigned download URLs for each variant
```

Nothing about this path requires the frontend, NGINX, or the
observability stack to function — they layer on top. This is
deliberate: the system was built inside-out, starting from "can a file
get uploaded, processed, and downloaded at all" before adding auth, rate
limiting, caching, metrics, or a UI.

## Why direct-to-storage upload

The API process never touches file bytes for uploads or downloads (see
`StorageService.getPresignedUploadUrl` / `getPresignedDownloadUrl`). A
5GB video upload would otherwise hold open an API connection and consume
API memory/bandwidth for the entire transfer — multiplied by however
many concurrent uploads are in flight. Presigned URLs let the object
store handle that load, which is what it's built for; the API's job is
just brokering short-lived, scoped permission to read/write specific
keys.

## Why separate worker services instead of one NestJS monolith

`image-worker`, `video-worker`, and `thumbnail-worker` are separate
processes/containers, not modules inside the API:

- **Independent scaling**: video transcoding is CPU-heavy and slow
  (seconds to minutes); thumbnailing is fast. Baking them into one
  process means they'd have to scale together. As separate services,
  `docker compose --scale video-worker=8 --scale thumbnail-worker=2`
  (or Kubernetes HPA/KEDA per-Deployment) reflects their actual resource
  profiles.
- **Blast radius**: a native dependency crash in the video pipeline
  (FFmpeg segfault, OOM on a huge file) kills that worker process, not
  the API serving live requests.
- **Deploy independence**: shipping a Sharp version bump doesn't require
  redeploying the video pipeline.

They are *not* split further than this — e.g. no separate "database
writer" microservice — because the brief explicitly calls for avoiding
unnecessary microservices, and there's no independent scaling or failure
isolation reason to split further.

## Why the API keeps a monolithic module structure internally

Within `apps/api`, `auth`, `assets`, `jobs`, `admin`, `storage`, `queue`
are NestJS modules within one process, not separate services. There is
no scaling or failure-isolation argument for splitting authentication
from asset metadata CRUD — they share the same database, the same
request volume profile, and the same deploy cadence. Splitting them
would add network calls and deployment coordination for no benefit.

## Data flow ownership

- **Postgres** is the single source of truth for everything durable:
  users, assets, job state, variants. If Redis disappeared entirely
  right now, no data would be lost — only in-flight queue messages not
  yet reflected in a Postgres row (and those are, at most, jobs that
  haven't started PROCESSING yet, which is a safe state to be caught in).
- **Redis** is used for three purposes, each read explicitly in
  docs/decisions.md: the job queue (Streams), a short-TTL cache for hot
  asset metadata reads, and rate-limit counters. None of Redis's state
  is authoritative — it's an accelerant, not a database.
- **Object storage** holds the actual bytes (originals and variants).
  Postgres holds only the storage keys, never the files themselves.

## Component diagram

```text
                         +-------------+
                         |   Browser   |
                         +------+------+
                                |
                         +------v------+
                         |    NGINX    |  (reverse proxy: / -> frontend, /api -> API)
                         +--+-------+--+
                            |       |
                  +---------+       +----------+
                  |                            |
           +------v------+             +-------v------+
           |  Frontend    |             |     API      |
           |  (static)    |             |  (NestJS)    |
           +--------------+             +---+----+-----+
                                             |    |
                              +--------------+    +--------------+
                              |                                  |
                       +------v------+                   +-------v------+
                       | PostgreSQL  |                   |    Redis      |
                       | (metadata)  |                   | (queue/cache/ |
                       +-------------+                   |  rate limit)  |
                                                          +---+---+---+--+
                                                              |   |   |
                                            +-----------------+   |   +-----------------+
                                            |                     |                     |
                                     +------v------+       +------v------+      +-------v------+
                                     |image-worker |       |video-worker |      |thumbnail-     |
                                     |             |       |             |      |worker         |
                                     +------+------+       +------+------+      +-------+-------+
                                            |                     |                     |
                                            +----------+----------+---------------------+
                                                       |
                                              +--------v--------+
                                              |  Object Storage  |
                                              | (MinIO / S3)     |
                                              +------------------+
```
