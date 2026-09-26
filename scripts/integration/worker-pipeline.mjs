#!/usr/bin/env node
/**
 * End-to-end test of the asynchronous processing pipeline, with no mocks:
 *
 *   real Postgres (migrated) + real Redis Streams + S3-compatible storage
 *   + the actual compiled worker processes (Sharp / FFmpeg)
 *
 * It plays the API's role (inserts asset + job rows, XADDs the same message
 * shape JobProducerService publishes), then asserts what the workers wrote
 * back: variants, extracted metadata, derived asset status, retry state on
 * failure, and the real-time events published to Redis.
 *
 *   npm run build --workspaces --if-present     # compile workers to dist/
 *   DATABASE_URL=... REDIS_URL=... S3_ENDPOINT=... S3_ACCESS_KEY=... \
 *     S3_SECRET_KEY=... S3_BUCKET=... node scripts/integration/worker-pipeline.mjs
 *
 * Set SPAWN_WORKERS=false to test against workers that are already running
 * (e.g. the docker-compose stack) instead of starting local processes.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const { Pool } = require('pg');
const Redis = require('ioredis');
const sharp = require('sharp');
const { S3Client, CreateBucketCommand, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const shared = require(path.join(root, 'packages/shared/dist'));

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://media:media_dev_password@localhost:5432/media_platform',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:5000',
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'test',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'test',
  S3_BUCKET: process.env.S3_BUCKET ?? 'media-platform',
  S3_FORCE_PATH_STYLE: 'true',
};

let failures = 0;
const check = (cond, msg, detail) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}${detail !== undefined ? `\n         got: ${JSON.stringify(detail)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeoutMs = 90_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(400);
  }
}

const pool = new Pool({ connectionString: env.DATABASE_URL });
const redis = new Redis(env.REDIS_URL);
const sub = new Redis(env.REDIS_URL);
const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT, region: env.S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
});
const workers = [];
const tmp = mkdtempSync(path.join(tmpdir(), 'pipeline-it-'));

async function cleanup() {
  for (const w of workers) w.kill('SIGTERM');
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
  sub.disconnect(); redis.disconnect(); await pool.end().catch(() => {});
}

async function main() {
  // ---------- fixtures
  try { await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET })); }
  catch { await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET })); }

  const userId = randomUUID();
  await pool.query(`INSERT INTO users (id, email, "passwordHash", "updatedAt") VALUES ($1, $2, 'x', now())`, [userId, `it-${userId}@example.com`]);

  // Portrait photo stored rotated (EXIF orientation 6): displayed size must be swapped.
  const jpeg = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'T-1000' },
      IFD2: { DateTimeOriginal: '2024:05:06 07:08:09', ExposureTime: '1/250', FNumber: '2.8', ISOSpeedRatings: '200', FocalLength: '35' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 26/1 46/1', GPSLongitudeRef: 'W', GPSLongitude: '79/1 58/1 56/1' },
    })
    .withMetadata({ orientation: 6 }) // sharp's withExif() drops Orientation, so set it here
    .jpeg().toBuffer();
  const mp4Path = path.join(tmp, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', mp4Path]);
  const mp4 = readFileSync(mp4Path);

  const put = (key, body, type) => s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: type }));
  const createAsset = async (fileName, mime, kind, body) => {
    const id = randomUUID();
    const key = `uploads/${userId}/${randomUUID()}-${fileName}`;
    await put(key, body, mime);
    await pool.query(`INSERT INTO assets (id, "ownerId", "fileName", "mimeType", kind, "fileSize", "storageKey", status, "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,'PROCESSING', now())`, [id, userId, fileName, mime, kind, body.length, key]);
    return { id, key };
  };
  const image = await createAsset('photo.jpg', 'image/jpeg', 'IMAGE', jpeg);
  const video = await createAsset('clip.mp4', 'video/mp4', 'VIDEO', mp4);
  const broken = await createAsset('broken.jpg', 'image/jpeg', 'IMAGE', Buffer.from('this is not an image'));

  // ---------- start listening for events + workers
  const events = [];
  await sub.psubscribe('events:user:*');
  sub.on('pmessage', (_p, ch, msg) => { if (ch === shared.userEventsChannel(userId)) events.push(JSON.parse(msg).event); });

  if ((process.env.SPAWN_WORKERS ?? 'true') !== 'false') {
    for (const name of ['metadata-worker', 'image-worker', 'video-worker', 'thumbnail-worker']) {
      const p = spawn('node', ['dist/main.js'], { cwd: path.join(root, 'apps', name), env: { ...process.env, ...env, METRICS_PORT: String(9200 + workers.length) }, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
      p.stderr.on('data', (d) => process.stderr.write(`[${name}!] ${d}`));
      workers.push(p);
    }
    await sleep(1500);
  }

  // ---------- act as the API: insert jobs and publish to streams
  const enqueue = async (asset, type, params) => {
    const full = { ...params, originalStorageKey: asset.key };
    const jobId = randomUUID();
    const idempotencyKey = shared.computeIdempotencyKey(asset.id, type, full);
    await pool.query(`INSERT INTO processing_jobs (id, "assetId", type, params, "idempotencyKey", "updatedAt") VALUES ($1,$2,$3,$4::jsonb,$5, now())`, [jobId, asset.id, type, JSON.stringify(full), idempotencyKey]);
    await redis.xadd(shared.streamKeyFor(shared.JOB_TYPE_TO_WORKER[type]), '*', 'payload', JSON.stringify({
      jobId, assetId: asset.id, type, attempt: 1, idempotencyKey, params: full, createdAt: new Date().toISOString(),
    }));
    return jobId;
  };
  for (const [type, params] of [
    ['IMAGE_THUMBNAIL', { width: 320, height: 320 }], ['IMAGE_RESIZE', { width: 300 }], ['IMAGE_COMPRESS', { quality: 80 }], ['METADATA_EXTRACT', { kind: 'IMAGE' }],
  ]) await enqueue(image, type, params);
  for (const [type, params] of [
    ['VIDEO_THUMBNAIL', { atSeconds: 1 }], ['VIDEO_TRANSCODE', { resolution: '480p' }], ['VIDEO_PREVIEW', { startSeconds: 0, durationSeconds: 2 }], ['METADATA_EXTRACT', { kind: 'VIDEO' }],
  ]) await enqueue(video, type, params);
  const brokenJob = await enqueue(broken, 'METADATA_EXTRACT', { kind: 'IMAGE' });

  // ---------- wait + assert
  const statusOf = async (id) => (await pool.query('SELECT * FROM assets WHERE id=$1', [id])).rows[0];
  console.log('\nWaiting for workers (image + video pipelines)...');
  await waitFor(async () => (await statusOf(image.id)).status === 'READY', 'image asset READY');
  await waitFor(async () => (await statusOf(video.id)).status === 'READY', 'video asset READY');
  await waitFor(async () => (await pool.query('SELECT status FROM processing_jobs WHERE id=$1', [brokenJob])).rows[0].status === 'RETRY', 'broken job to enter RETRY');
  await sleep(500); // let trailing events arrive

  console.log('\nImage pipeline');
  const imgRow = await statusOf(image.id);
  const imgVariants = (await pool.query('SELECT type, "storageKey", width, height, "fileSize" FROM asset_variants WHERE "assetId"=$1', [image.id])).rows;
  check(['IMAGE_THUMBNAIL', 'IMAGE_RESIZE', 'IMAGE_COMPRESS'].every((t) => imgVariants.some((v) => v.type === t)), 'thumbnail, resize and compress variants were written', imgVariants.map((v) => v.type));
  check(imgVariants.length === 3, 'no variant row for METADATA_EXTRACT (it has no output file)', imgVariants.length);
  check(imgRow.width === 400 && imgRow.height === 600, 'EXIF orientation 6 swaps stored 600x400 into displayed 400x600', [imgRow.width, imgRow.height]);
  check(/^#[0-9a-f]{6}$/.test(imgRow.dominantColor) && parseInt(imgRow.dominantColor.slice(1, 3), 16) > 150, 'dominant colour is reddish hex', imgRow.dominantColor);
  check(imgRow.capturedAt && new Date(imgRow.capturedAt).getFullYear() === 2024, 'capturedAt read from EXIF DateTimeOriginal', imgRow.capturedAt);
  check(imgRow.metadata?.camera === 'TestCam T-1000', 'camera make+model extracted', imgRow.metadata?.camera);
  check(imgRow.metadata?.exposure === '1/250' && imgRow.metadata?.aperture === 'f/2.8' && imgRow.metadata?.iso === 200, 'exposure / aperture / ISO formatted', imgRow.metadata);
  check(!/gps|latitude|longitude/i.test(JSON.stringify(imgRow.metadata)), 'GPS location is NOT stored (privacy)', imgRow.metadata);

  console.log('\nVideo pipeline');
  const vidRow = await statusOf(video.id);
  const vidVariants = (await pool.query('SELECT type, "storageKey" FROM asset_variants WHERE "assetId"=$1', [video.id])).rows;
  check(['VIDEO_THUMBNAIL', 'VIDEO_TRANSCODE', 'VIDEO_PREVIEW'].every((t) => vidVariants.some((v) => v.type === t)), 'thumbnail, transcode and preview variants were written', vidVariants.map((v) => v.type));
  check(vidRow.width === 320 && vidRow.height === 240, 'ffprobe dimensions', [vidRow.width, vidRow.height]);
  check(Math.abs(vidRow.durationMs - 3000) < 250, 'ffprobe duration ~3s', vidRow.durationMs);
  check(vidRow.metadata?.videoCodec === 'h264' && vidRow.metadata?.audioCodec === 'aac' && vidRow.metadata?.hasAudio === true, 'codecs + audio detected', vidRow.metadata);
  check(vidRow.metadata?.fps === 15, 'frame rate parsed from rational', vidRow.metadata?.fps);

  console.log('\nFailure handling');
  const bj = (await pool.query('SELECT * FROM processing_jobs WHERE id=$1', [brokenJob])).rows[0];
  const brokenRow = await statusOf(broken.id);
  check(bj.status === 'RETRY' && bj.attempt === 1, 'corrupt file -> job RETRY on attempt 1 (backoff scheduled)', [bj.status, bj.attempt]);
  check(typeof bj.failureReason === 'string' && bj.failureReason.length > 0, 'failure reason recorded', bj.failureReason);
  check(brokenRow.status !== 'READY' && brokenRow.status !== 'FAILED', 'asset stays PROCESSING while retries remain', brokenRow.status);
  check(new Date(bj.scheduledAt) > new Date(Date.now() - 5000), 'retry scheduled in the future via scheduledAt (durable backoff)', bj.scheduledAt);

  console.log('\nReal-time events (Redis pub/sub)');
  const types = new Set(events.map((e) => e.type));
  check(types.has('job.updated') && types.has('asset.updated'), 'workers published job.updated and asset.updated', [...types]);
  check(events.filter((e) => e.type === 'asset.updated' && e.assetId === image.id && e.status === 'READY').length === 1, 'exactly one asset.updated READY for the image', events.filter((e) => e.assetId === image.id && e.type === 'asset.updated'));
  check(events.some((e) => e.type === 'job.updated' && e.jobId === brokenJob && e.status === 'RETRY'), 'failure published as job.updated RETRY');
  check(events.every((e) => !e.assetId || [image.id, video.id, broken.id].includes(e.assetId)), 'only this user\'s assets appeared on this user\'s channel');
}

main()
  .then(async () => { await cleanup(); console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed'); process.exit(failures ? 1 : 0); })
  .catch(async (err) => { console.error('\nERROR:', err); await cleanup(); process.exit(2); });
