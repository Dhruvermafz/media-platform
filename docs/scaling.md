# Scaling

## Independent worker scaling

Because each worker kind consumes its own Redis Stream via its own
consumer group (docs/decisions.md), replica count for image/video/
thumbnail workers is completely decoupled. Adding a replica is just
starting another process with the same `WorkerKind` and a unique
`consumerName` (derived from `HOSTNAME`, which Docker/Kubernetes set
uniquely per container) — no coordination step, no config to update on
the existing replicas.

**Docker Compose:**
```bash
docker compose -f infra/docker/docker-compose.yml up -d \
  --scale image-worker=2 --scale video-worker=8 --scale thumbnail-worker=2
```

**Kubernetes:** each worker kind is its own `Deployment` with its own
`replicas` field (`infra/k8s/*-worker-deployment.yaml`) —
`kubectl scale deployment/video-worker --replicas=8`.

## Why Postgres and Redis are NOT run inside Kubernetes here

`infra/k8s/` deliberately has no Postgres or Redis manifests. Running
stateful services inside Kubernetes means owning StatefulSets,
persistent volume provisioning, backup/restore tooling, failover, and
version upgrades yourself — solved problems that managed services (RDS,
ElastiCache, Cloud SQL, MemoryStore) already handle well. The brief
explicitly calls this out: "use external/managed services rather than
pretending stateful infrastructure should always run inside Kubernetes."
`DATABASE_URL`/`REDIS_URL` point at those managed endpoints in
production; nothing in the application code cares whether they're
managed or self-hosted.

## Autoscaling design (KEDA), not faked

The brief is explicit: "do not fake autoscaling metrics." This project
does not ship a working KEDA installation with load-tested thresholds —
that requires a real cluster and real traffic to tune. What's documented
here is the *design* for queue-depth-based autoscaling, ready to apply
once those prerequisites exist.

KEDA's Redis Streams scaler can drive a `ScaledObject` per worker
Deployment, scaling on **pending entries in the consumer group**
(`XPENDING`), which better reflects backlog than raw stream length (a
long stream that's being drained fast shouldn't scale up):

```yaml
# infra/k8s/keda-scaledobjects.yaml (illustrative — tune thresholds against real load test results, docs/load-testing.md)
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: video-worker-scaler
  namespace: media-platform
spec:
  scaleTargetRef:
    name: video-worker
  minReplicaCount: 2
  maxReplicaCount: 20
  cooldownPeriod: 60
  triggers:
    - type: redis-streams
      metadata:
        address: <redis-host>:6379
        stream: stream:jobs:video-worker
        consumerGroup: cg:video-worker
        pendingEntriesCount: "10" # scale up once >10 unclaimed pending entries per replica
        activationLagCount: "1"
```

One `ScaledObject` per worker kind, with independent `min`/`max`/threshold
values reflecting each kind's actual processing cost — this is exactly
why per-worker-kind streams (docs/decisions.md) matter for autoscaling,
not just for isolation.

## Horizontal scaling of the API

The API is stateless (JWT auth, no in-memory session/cache state — Redis
holds the shared cache and rate-limit counters) so it scales
horizontally behind a load balancer/Ingress with no special
coordination. `app.enableShutdownHooks()` in `main.ts` ensures in-flight
requests drain cleanly on a rolling deploy or scale-down.

## What would need to change at 10x-100x current scale

Documented honestly rather than pretended-away:
- Redis Streams would likely need to become Kafka for partitioned,
  ordered, high-throughput consumption with consumer-side offset
  management, rather than Redis's single-node (or Cluster-sharded, with
  added complexity) model.
- The fixed-window rate limiter (docs/decisions.md) would want to become
  a proper sliding window under heavier, more adversarial traffic.
- Read replicas for Postgres would offload the admin dashboard's
  aggregate queries from the primary handling write traffic.
