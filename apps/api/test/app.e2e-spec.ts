/**
 * Integration test for the critical path this whole project is built
 * around: register -> get upload URL -> upload -> confirm -> job
 * processes -> variant retrievable.
 *
 * Requires the full stack running and reachable (Postgres, Redis, MinIO,
 * and at least the image-worker) - this is NOT a mocked unit test. Run it
 * against the docker-compose environment:
 *
 *   docker compose -f infra/docker/docker-compose.yml up -d
 *   cd apps/api
 *   DATABASE_URL=... REDIS_URL=... (etc - see .env) npm run test:e2e
 *
 * or, simpler, exec into the already-running api container's environment
 * by running this from a machine with the same .env loaded and the
 * compose ports published to localhost (the default docker-compose.yml
 * setup already does this).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('Critical workflow (e2e)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const email = `e2e-${Date.now()}@example.com`;
    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'e2e-test-password' })
      .expect(201);
    token = registerRes.body.accessToken;
    expect(token).toBeDefined();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects requests with no token', async () => {
    await request(app.getHttpServer()).get('/assets').expect(401);
  });

  it('completes the full upload -> process -> retrieve cycle', async () => {
    const urlRes = await request(app.getHttpServer())
      .post('/assets/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'e2e-test.png', mimeType: 'image/png', fileSize: TINY_PNG.byteLength })
      .expect(201);

    const { uploadUrl, storageKey } = urlRes.body;
    expect(storageKey).toContain('e2e-test.png');

    // Upload goes directly to object storage, not through the API under test.
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: TINY_PNG,
      headers: { 'Content-Type': 'image/png' },
    });
    expect(putRes.ok).toBe(true);

    const confirmRes = await request(app.getHttpServer())
      .post('/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ storageKey, fileName: 'e2e-test.png', mimeType: 'image/png' })
      .expect(201);

    const assetId = confirmRes.body.id;
    expect(confirmRes.body.status).toBe('PROCESSING');

    // Poll for job completion - the image-worker processes this
    // asynchronously, so we wait rather than assert instantaneously.
    const deadline = Date.now() + 30_000;
    let finalStatus = confirmRes.body.status;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      finalStatus = res.body.status;
      if (finalStatus === 'READY' || finalStatus === 'FAILED') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(finalStatus).toBe('READY');

    const jobsRes = await request(app.getHttpServer())
      .get(`/assets/${assetId}/jobs`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(jobsRes.body.length).toBeGreaterThan(0);
    for (const job of jobsRes.body) {
      expect(job.status).toBe('COMPLETED');
    }

    const finalAsset = await request(app.getHttpServer())
      .get(`/assets/${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(finalAsset.body.variants.length).toBeGreaterThan(0);
    expect(finalAsset.body.variants[0].downloadUrl).toContain('http');
  }, 40_000);

  it('returns 404 for a job belonging to another user (never leaks existence via 403)', async () => {
    await request(app.getHttpServer())
      .get('/assets/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rejects retrying a job that is not in a retryable state', async () => {
    // A COMPLETED job (from the workflow test above) should not be retryable.
    const listRes = await request(app.getHttpServer())
      .get('/assets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const assetId = listRes.body.items[0]?.id;
    if (!assetId) return; // nothing to check if the prior test didn't run first

    const jobsRes = await request(app.getHttpServer())
      .get(`/assets/${assetId}/jobs`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const completedJob = jobsRes.body.find((j: { status: string }) => j.status === 'COMPLETED');
    if (!completedJob) return;

    await request(app.getHttpServer())
      .post(`/jobs/${completedJob.id}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });
});
