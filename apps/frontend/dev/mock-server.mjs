#!/usr/bin/env node
/**
 * In-memory mock of the Media Platform API, for UI development and demos with
 * no Postgres/Redis/S3/workers. Implements the same routes and JSON shapes as
 * apps/api (including the Server-Sent Events stream, with simulated worker
 * progress after each upload).
 *
 *   npm run dev:mock      # this server on :3000 + Vite on :5173
 *
 * Sign in with any email/password. Emails demo@ or admin@ become admins.
 * It is NOT a substitute for the real API: no persistence, no validation depth.
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT ?? 3000);
const ORIGIN = `http://localhost:${PORT}`;
const now = () => new Date().toISOString();
const ago = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

// ------------------------------------------------------------------ media
// MOCK_VIDEO=webm: for browsers built without H.264 (e.g. Playwright's Chromium).
const WEBM = process.env.MOCK_VIDEO === 'webm';
let videoFile = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), 'mock-media-'));
  videoFile = path.join(dir, WEBM ? 'clip.webm' : 'clip.mp4');
  const codecs = WEBM ? ['-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libvorbis'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'];
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=8:size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', ...codecs, '-shortest', '-y', videoFile]);
} catch { videoFile = null; console.warn('[mock] ffmpeg not found: videos will not play'); }

/** A deterministic abstract "photograph": sky gradient, sun, layered hills. */
function photoSvg(hue, w = 1200, h = 800, sun = true) {
  const h2 = (hue + 40) % 360, h3 = (hue + 200) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 65% 34%)"/><stop offset="0.7" stop-color="hsl(${h2} 80% 70%)"/><stop offset="1" stop-color="hsl(${h2} 90% 84%)"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#s)"/>${sun ? `<circle cx="${w * 0.7}" cy="${h * 0.42}" r="${h * 0.09}" fill="hsl(${h2} 100% 92%)" opacity="0.95"/>` : ''}
<path d="M0 ${h * 0.68} Q ${w * 0.25} ${h * 0.5} ${w * 0.5} ${h * 0.66} T ${w} ${h * 0.6} V ${h} H0Z" fill="hsl(${h3} 35% 28%)"/>
<path d="M0 ${h * 0.8} Q ${w * 0.3} ${h * 0.68} ${w * 0.6} ${h * 0.82} T ${w} ${h * 0.76} V ${h} H0Z" fill="hsl(${h3} 40% 16%)"/></svg>`;
}
const hslHex = (h, s, l) => { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join(''); };

// ------------------------------------------------------------------ state
const users = [];
const assets = [];
const collections = [];
const shares = [];
const activity = [];
const log = (action, entityType, entityName, entityId = null) => activity.unshift({ id: randomUUID(), action, entityType, entityId, entityName, meta: null, createdAt: now() });

const TAGS = ['travel', 'family', 'city', 'nature', 'work', 'food'];
const IMG_JOBS = [['IMAGE_THUMBNAIL', {}], ['IMAGE_RESIZE', { width: 1600 }], ['IMAGE_COMPRESS', { quality: 80 }], ['METADATA_EXTRACT', {}]];
const VID_JOBS = [['VIDEO_THUMBNAIL', {}], ['VIDEO_TRANSCODE', { resolution: '720p' }], ['VIDEO_TRANSCODE', { resolution: '480p' }], ['VIDEO_PREVIEW', {}], ['METADATA_EXTRACT', {}]];

function makeAsset({ name, kind = 'IMAGE', hue, hoursAgo, fav = false, tags = [], title = null, status = 'READY', w = 4000, h = 3000, jobsDone = null, collectionIds = [], deleted = false, size }) {
  const id = randomUUID();
  const a = {
    id, ownerId: users[0]?.id ?? 'u', fileName: name, title, description: null,
    mimeType: kind === 'IMAGE' ? 'image/jpeg' : 'video/mp4', kind, fileSize: size ?? (kind === 'IMAGE' ? 2_400_000 + hue * 9000 : 48_000_000 + hue * 90_000),
    status, isFavorite: fav, width: w, height: h, durationMs: kind === 'VIDEO' ? 8000 : null, dominantColor: hslHex((hue + 40) % 360, 70, 55),
    capturedAt: ago(hoursAgo + 3), tags, createdAt: ago(hoursAgo), updatedAt: ago(hoursAgo), deletedAt: deleted ? ago(30) : null,
    hue, collectionIds, variants: [], jobs: [],
    metadata: kind === 'IMAGE' ? { format: 'jpeg', colorSpace: 'srgb', camera: 'FUJIFILM X-T5', lens: 'XF 23mm F2', exposure: '1/500', aperture: 'f/4', iso: 160, focalLengthMm: 23 } : { container: 'mov,mp4,m4a', videoCodec: 'h264', audioCodec: 'aac', fps: 24, bitrateKbps: 5200 },
  };
  const defs = kind === 'IMAGE' ? IMG_JOBS : VID_JOBS;
  a.jobs = defs.map(([type, params], i) => ({ id: randomUUID(), assetId: id, type, params, status: jobsDone === null || i < jobsDone ? 'COMPLETED' : 'PENDING', attempt: 1, maxAttempts: 3, failureReason: null, createdAt: a.createdAt, updatedAt: a.updatedAt, completedAt: a.createdAt }));
  if (jobsDone === null) addVariants(a);
  assets.push(a);
  return a;
}
function addVariants(a) {
  const v = (type, name, extra = {}) => ({ id: randomUUID(), type, name, mimeType: type.startsWith('IMAGE') ? 'image/jpeg' : 'video/mp4', fileSize: 180_000, width: null, height: null, durationMs: null, createdAt: a.createdAt, ...extra });
  a.variants = a.kind === 'IMAGE'
    ? [v('IMAGE_THUMBNAIL', 'thumbnail_320x320.jpg', { width: 320, height: 320, fileSize: 24_000 }), v('IMAGE_RESIZE', 'resize_1600w.jpg', { width: 1600, height: 1200, fileSize: 610_000 }), v('IMAGE_COMPRESS', 'compressed_q80.jpg', { width: a.width, height: a.height, fileSize: 1_300_000 })]
    : [v('VIDEO_THUMBNAIL', 'thumbnail.jpg', { width: 640, height: 360, fileSize: 40_000 }), v('VIDEO_TRANSCODE', '720p.mp4', { width: 1280, height: 720, fileSize: 9_000_000 }), v('VIDEO_TRANSCODE', '480p.mp4', { width: 854, height: 480, fileSize: 4_100_000 }), v('VIDEO_PREVIEW', 'preview_5s.mp4', { durationMs: 5000, fileSize: 700_000 })];
}

function seed() {
  users.push({ id: randomUUID(), email: 'demo@example.com', displayName: 'Ada Lovelace', role: 'ADMIN', createdAt: ago(900), password: 'password123', storageQuotaBytes: 5 * 1024 ** 3 });
  users.push({ id: randomUUID(), email: 'grace@example.com', displayName: 'Grace', role: 'USER', createdAt: ago(300), password: 'x', storageQuotaBytes: 2 * 1024 ** 3 });
  const names = ['Lisbon rooftops', 'Alfama tram', 'Harbour at dusk', 'Sunday market', 'Cliffs', 'Old town door', 'Morning coffee', 'Tiles', 'Ferry crossing', 'Vineyard', 'Night street', 'Fort walls'];
  const dims = [[4000, 3000], [3000, 4000], [4000, 2667], [3000, 3000]];
  let hue = 12;
  const hoursAt = [0.2, 0.5, 1, 3, 5, 26, 30, 50, 72, 96, 200, 240, 400, 420, 700, 730, 1100, 1300, 1800, 2000, 2400, 2500, 2600, 2700, 2900, 3100];
  hoursAt.forEach((h, i) => {
    const [w, hh] = dims[i % dims.length];
    makeAsset({ name: `IMG_${2041 + i}.jpg`, title: i < names.length ? names[i] : null, hue: (hue += 37) % 360, hoursAgo: h, fav: i % 5 === 0, tags: [TAGS[i % 6], ...(i % 3 === 0 ? [TAGS[(i + 2) % 6]] : [])], w, h: hh });
  });
  ['Beach day.mp4', 'Tram ride.mp4', 'Sunset timelapse.mov', 'Family lunch.mp4', 'Drone pass.mp4'].forEach((n, i) => makeAsset({ name: n, kind: 'VIDEO', hue: (hue += 53) % 360, hoursAgo: [4, 28, 120, 500, 1500][i], tags: [TAGS[i]], w: 1920, h: 1080, fav: i === 1 }));
  makeAsset({ name: 'IMG_2099.jpg', hue: 200, hoursAgo: 0.05, status: 'PROCESSING', jobsDone: 2, w: 4000, h: 3000 });
  makeAsset({ name: 'Wedding_full.mp4', kind: 'VIDEO', hue: 300, hoursAgo: 0.1, status: 'PROCESSING', jobsDone: 1, w: 1920, h: 1080, size: 1_800_000_000 });
  const bad = makeAsset({ name: 'corrupt.jpg', hue: 20, hoursAgo: 2, status: 'FAILED', jobsDone: 1, w: 100, h: 100 });
  bad.jobs[1].status = 'DEAD_LETTER'; bad.jobs[1].failureReason = 'Input buffer contains unsupported image format'; bad.jobs[2].status = 'COMPLETED';
  [0, 1, 2].forEach((i) => makeAsset({ name: `old_${i}.jpg`, hue: 100 + i * 30, hoursAgo: 900 + i, deleted: true }));
  const c1 = { id: randomUUID(), name: 'Lisbon trip', description: 'Ten days of tiles, trams and pastel de nata.', createdAt: ago(600), updatedAt: ago(2) };
  const c2 = { id: randomUUID(), name: 'Family', description: null, createdAt: ago(400), updatedAt: ago(30) };
  const c3 = { id: randomUUID(), name: 'Work references', description: null, createdAt: ago(200), updatedAt: ago(100) };
  collections.push(c1, c2, c3);
  assets.slice(0, 12).forEach((a) => a.collectionIds.push(c1.id));
  assets.filter((a) => a.tags.includes('family')).forEach((a) => a.collectionIds.push(c2.id));
  [2, 8].forEach((i) => assets[i].collectionIds.push(c3.id));
  shares.push({ id: randomUUID(), token: randomBytes(9).toString('base64url'), ownerId: users[0].id, assetId: null, collectionId: c1.id, password: null, allowDownload: true, expiresAt: new Date(Date.now() + 5 * 864e5).toISOString(), revokedAt: null, viewCount: 14, lastViewedAt: ago(5), createdAt: ago(48) });
  shares.push({ id: randomUUID(), token: randomBytes(9).toString('base64url'), ownerId: users[0].id, assetId: assets[2].id, collectionId: null, password: 'secret', allowDownload: false, expiresAt: null, revokedAt: null, viewCount: 3, lastViewedAt: ago(20), createdAt: ago(90) });
  ['asset.uploaded', 'asset.uploaded', 'collection.created', 'share.created', 'asset.trashed'].forEach((act, i) => log(act, act.split('.')[0], ['IMG_2099.jpg', 'Wedding_full.mp4', 'Lisbon trip', 'Lisbon trip', 'old_0.jpg'][i]));
  simulateProcessing();
}

// ------------------------------------------------------------------ SSE
const clients = new Set();
function emit(event) {
  const frame = `id: ${randomUUID()}\nevent: platform\ndata: ${JSON.stringify({ id: randomUUID(), ts: now(), event })}\n\n`;
  for (const res of clients) res.write(frame);
}
setInterval(() => { for (const res of clients) res.write('event: ping\ndata: {}\n\n'); }, 20_000);

/** Walks every PROCESSING asset's PENDING jobs to COMPLETED, emitting the same events the workers do. */
function simulateProcessing() {
  const tick = () => {
    for (const a of assets) {
      if (a.status !== 'PROCESSING') continue;
      const next = a.jobs.find((j) => j.status === 'PENDING');
      if (!next) continue;
      next.status = 'PROCESSING'; next.updatedAt = now();
      emit({ type: 'job.updated', assetId: a.id, jobId: next.id, jobType: next.type, status: 'PROCESSING' });
      setTimeout(() => {
        next.status = 'COMPLETED'; next.updatedAt = next.completedAt = now();
        emit({ type: 'job.updated', assetId: a.id, jobId: next.id, jobType: next.type, status: 'COMPLETED' });
        if (a.jobs.every((j) => j.status === 'COMPLETED')) { addVariants(a); a.status = 'READY'; a.updatedAt = now(); emit({ type: 'asset.updated', assetId: a.id, status: 'READY' }); }
      }, 1400);
    }
  };
  setInterval(tick, 3200);
}

// ------------------------------------------------------------------ presenters
const media = (a, kind) => `${ORIGIN}/media/${a.kind === 'VIDEO' && kind !== 'thumb' ? 'video.mp4' : `${a.id}.svg`}?k=${kind}`;
const pipeline = (a) => a.status === 'READY' ? null : { total: a.jobs.length, done: a.jobs.filter((j) => j.status === 'COMPLETED').length, running: a.jobs.filter((j) => j.status === 'PROCESSING').length, failed: a.jobs.filter((j) => ['FAILED', 'DEAD_LETTER'].includes(j.status)).length };
const hasThumb = (a) => a.variants.some((v) => v.type.endsWith('THUMBNAIL'));
const base = (a) => ({ id: a.id, ownerId: a.ownerId, fileName: a.fileName, title: a.title, description: a.description, mimeType: a.mimeType, kind: a.kind, fileSize: a.fileSize, status: a.status, isFavorite: a.isFavorite, width: a.width, height: a.height, durationMs: a.durationMs, dominantColor: a.dominantColor, capturedAt: a.capturedAt, tags: [...a.tags].sort(), createdAt: a.createdAt, updatedAt: a.updatedAt, deletedAt: a.deletedAt });
const listItem = (a) => ({ ...base(a), thumbnailUrl: hasThumb(a) ? media(a, 'thumb') : null, clipUrl: a.variants.some((v) => v.type === 'VIDEO_PREVIEW') ? media(a, 'clip') : null, pipeline: pipeline(a) });
const detail = (a) => ({ ...base(a), thumbnailUrl: hasThumb(a) ? media(a, 'thumb') : null, clipUrl: null, previewUrl: a.kind === 'IMAGE' && a.variants.some((v) => v.type === 'IMAGE_RESIZE') ? media(a, 'preview') : null, originalUrl: media(a, 'original'), metadata: a.status === 'READY' ? a.metadata : null, collections: collections.filter((c) => a.collectionIds.includes(c.id)).map((c) => ({ id: c.id, name: c.name })), variants: a.variants.map((v) => ({ ...v, downloadUrl: media(a, v.name) })) });
const colSummary = (c, covers = false) => { const items = assets.filter((a) => !a.deletedAt && a.collectionIds.includes(c.id)); return { id: c.id, name: c.name, description: c.description, itemCount: items.length, createdAt: c.createdAt, updatedAt: c.updatedAt, ...(covers ? { covers: items.slice(0, 4).map((a) => ({ assetId: a.id, dominantColor: a.dominantColor, url: hasThumb(a) ? media(a, 'thumb') : null })) } : {}) }; };
const publicUser = (u) => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role, createdAt: u.createdAt });
const shareDto = (s) => ({ id: s.id, token: s.token, path: `/s/${s.token}`, hasPassword: !!s.password, allowDownload: s.allowDownload, expiresAt: s.expiresAt, revokedAt: s.revokedAt, viewCount: s.viewCount, lastViewedAt: s.lastViewedAt, createdAt: s.createdAt, targetType: s.assetId ? 'asset' : 'collection', targetName: s.assetId ? (assets.find((a) => a.id === s.assetId)?.title ?? assets.find((a) => a.id === s.assetId)?.fileName) : collections.find((c) => c.id === s.collectionId)?.name });

// ------------------------------------------------------------------ http
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const err = (res, status, message, code) => json(res, status, { statusCode: status, message, ...(code ? { code } : {}) });
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { try { r(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { r({}); } }); });
const me = () => users[0];

async function route(req, res, url) {
  const p = url.pathname, m = req.method, q = url.searchParams;
  let x;
  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: ready\ndata: {}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (p.startsWith('/media/')) return serveMedia(req, res, url);
  if (p.startsWith('/mock-upload/')) { req.resume(); return req.on('end', () => { res.writeHead(200, { ETag: '"mock"' }); res.end(); }); }

  if (p === '/auth/login' || p === '/auth/register') {
    const b = await readBody(req);
    if (!b.email) return err(res, 400, ['email must be an email']);
    let u = users.find((u) => u.email === b.email);
    if (p === '/auth/register' && u) return err(res, 409, 'An account with this email already exists');
    if (p === '/auth/login' && u && u.password !== b.password && u.email !== 'demo@example.com') return err(res, 401, 'Invalid email or password');
    if (!u) { u = { id: randomUUID(), email: b.email, displayName: b.displayName ?? null, role: /^(admin|demo)@/.test(b.email) ? 'ADMIN' : 'USER', createdAt: now(), password: b.password, storageQuotaBytes: 5 * 1024 ** 3 }; users.push(u); }
    users.splice(users.indexOf(u), 1); users.unshift(u);
    return json(res, p.endsWith('register') ? 201 : 200, { user: publicUser(u), accessToken: 'mock-token' });
  }
  if (!/Bearer /.test(req.headers.authorization ?? '') && !p.startsWith('/public/')) return err(res, 401, 'Unauthorized');

  if (p === '/me' && m === 'GET') return json(res, 200, { ...publicUser(me()), storageQuotaBytes: me().storageQuotaBytes });
  if (p === '/me' && m === 'PATCH') { const b = await readBody(req); me().displayName = (b.displayName ?? '').trim() || null; return json(res, 200, { ...publicUser(me()), storageQuotaBytes: me().storageQuotaBytes }); }
  if (p === '/me/password') { const b = await readBody(req); if (b.currentPassword !== me().password && me().email !== 'demo@example.com') return err(res, 400, 'Current password is incorrect'); return json(res, 200, { message: 'Password updated' }); }
  if (p === '/me/usage') {
    const live = assets.filter((a) => !a.deletedAt), tr = assets.filter((a) => a.deletedAt), sum = (l) => l.reduce((s, a) => s + a.fileSize, 0);
    return json(res, 200, { usedBytes: sum(assets), quotaBytes: me().storageQuotaBytes, trashBytes: sum(tr), counts: { total: live.length, trashed: tr.length, images: live.filter((a) => a.kind === 'IMAGE').length, videos: live.filter((a) => a.kind === 'VIDEO').length }, breakdown: { imageBytes: sum(live.filter((a) => a.kind === 'IMAGE')), videoBytes: sum(live.filter((a) => a.kind === 'VIDEO')) } });
  }

  // ---- assets
  if (p === '/assets' && m === 'GET') {
    let l = assets.filter((a) => (q.get('trashed') === 'true') === !!a.deletedAt);
    if (q.get('kind')) l = l.filter((a) => a.kind === q.get('kind'));
    if (q.get('status')) l = l.filter((a) => a.status === q.get('status'));
    if (q.get('favorite') === 'true') l = l.filter((a) => a.isFavorite);
    if (q.get('collectionId')) l = l.filter((a) => a.collectionIds.includes(q.get('collectionId')));
    if (q.get('tag')) l = l.filter((a) => a.tags.includes(q.get('tag').toLowerCase()));
    if (q.get('q')) { const s = q.get('q').toLowerCase(); l = l.filter((a) => [a.fileName, a.title, a.description, ...a.tags].some((f) => f?.toLowerCase().includes(s))); }
    const sort = q.get('sort') ?? 'createdAt', dir = q.get('order') === 'asc' ? 1 : -1;
    l.sort((a, b) => (a[sort] > b[sort] ? 1 : a[sort] < b[sort] ? -1 : 0) * dir);
    const page = Number(q.get('page') ?? 1), size = Number(q.get('pageSize') ?? 20);
    return json(res, 200, { items: l.slice((page - 1) * size, page * size).map(listItem), total: l.length, page, pageSize: size, hasMore: page * size < l.length });
  }
  if (p === '/assets/upload-url' && m === 'POST') { const b = await readBody(req); const key = `uploads/${me().id}/${randomUUID()}-${b.fileName}`; return json(res, 201, { uploadUrl: `${ORIGIN}/mock-upload/${encodeURIComponent(key)}`, storageKey: key, expiresIn: 900, method: 'PUT' }); }
  if (p === '/assets' && m === 'POST') {
    const b = await readBody(req);
    const kind = b.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE';
    const a = makeAsset({ name: b.fileName, kind, hue: Math.floor(Math.random() * 360), hoursAgo: 0, status: 'PROCESSING', jobsDone: 0, w: 4000, h: 3000, collectionIds: b.collectionId ? [b.collectionId] : [], size: 3_100_000 });
    a.mimeType = b.mimeType; log('asset.uploaded', 'asset', a.fileName, a.id); emit({ type: 'asset.created', assetId: a.id });
    return json(res, 201, listItem(a));
  }
  if (p === '/assets/bulk' && m === 'POST') {
    const b = await readBody(req); const sel = assets.filter((a) => b.ids.includes(a.id));
    for (const a of sel) {
      if (b.action === 'trash') a.deletedAt = now(); else if (b.action === 'restore') a.deletedAt = null;
      else if (b.action === 'favorite') a.isFavorite = true; else if (b.action === 'unfavorite') a.isFavorite = false;
      else if (b.action === 'addToCollection' && !a.collectionIds.includes(b.collectionId)) a.collectionIds.push(b.collectionId);
      else if (b.action === 'removeFromCollection') a.collectionIds = a.collectionIds.filter((c) => c !== b.collectionId);
      else if (b.action === 'addTags') a.tags = [...new Set([...a.tags, ...b.tags.map((t) => t.trim().toLowerCase())])];
      else if (b.action === 'delete') assets.splice(assets.indexOf(a), 1);
    }
    if (b.action === 'trash') log('asset.trashed', 'asset', sel.length === 1 ? sel[0].fileName : `${sel.length} items`);
    emit({ type: 'library.changed', scope: 'assets' });
    return json(res, 200, { affected: sel.length });
  }
  const am = p.match(/^\/assets\/([^/]+)(?:\/(\w+))?$/);
  if (am) {
    const a = assets.find((s) => s.id === am[1]); if (!a) return err(res, 404, 'Asset not found');
    const sub = am[2];
    if (!sub && m === 'GET') return json(res, 200, detail(a));
    if (!sub && m === 'PATCH') { const b = await readBody(req); if (b.title !== undefined) a.title = b.title.trim() || null; if (b.description !== undefined) a.description = b.description.trim() || null; if (b.isFavorite !== undefined) a.isFavorite = b.isFavorite; return json(res, 200, detail(a)); }
    if (!sub && m === 'DELETE') { assets.splice(assets.indexOf(a), 1); return json(res, 204); }
    if (sub === 'tags') { const b = await readBody(req); a.tags = [...new Set(b.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]; return json(res, 200, detail(a)); }
    if (sub === 'trash') { a.deletedAt = now(); log('asset.trashed', 'asset', a.fileName); return json(res, 204); }
    if (sub === 'restore') { a.deletedAt = null; return json(res, 204); }
    if (sub === 'download') return json(res, 200, { url: media(a, 'download'), fileName: a.fileName });
    if (sub === 'jobs') return json(res, 200, a.jobs);
    if (sub === 'variants') {
      const b = await readBody(req);
      if ((a.kind === 'IMAGE') !== b.type.startsWith('IMAGE_')) return err(res, 400, `${b.type} cannot be applied to a ${a.kind.toLowerCase()}`);
      const job = { id: randomUUID(), assetId: a.id, type: b.type, params: b.params ?? {}, status: 'PENDING', attempt: 0, maxAttempts: 3, failureReason: null, createdAt: now(), updatedAt: now(), completedAt: null };
      a.jobs.push(job); a.status = 'PROCESSING'; log('variant.requested', 'asset', a.fileName, a.id);
      return json(res, 201, { job, created: true });
    }
  }

  // ---- collections & tags
  if (p === '/collections' && m === 'GET') return json(res, 200, collections.map((c) => colSummary(c, true)));
  if (p === '/collections' && m === 'POST') {
    const b = await readBody(req);
    if (collections.some((c) => c.name === b.name)) return err(res, 409, 'You already have a collection with this name');
    const c = { id: randomUUID(), name: b.name, description: b.description ?? null, createdAt: now(), updatedAt: now() }; collections.unshift(c); log('collection.created', 'collection', c.name, c.id); return json(res, 201, colSummary(c));
  }
  const cm = p.match(/^\/collections\/([^/]+)$/);
  if (cm) {
    const c = collections.find((s) => s.id === cm[1]); if (!c) return err(res, 404, 'Collection not found');
    if (m === 'GET') return json(res, 200, colSummary(c));
    if (m === 'PATCH') { const b = await readBody(req); if (b.name) c.name = b.name; if (b.description !== undefined) c.description = b.description || null; return json(res, 200, colSummary(c)); }
    if (m === 'DELETE') { collections.splice(collections.indexOf(c), 1); assets.forEach((a) => (a.collectionIds = a.collectionIds.filter((i) => i !== c.id))); return json(res, 204); }
  }
  if (p === '/tags') { const counts = {}; assets.filter((a) => !a.deletedAt).forEach((a) => a.tags.forEach((t) => (counts[t] = (counts[t] ?? 0) + 1))); return json(res, 200, Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ id: name, name, count }))); }

  // ---- shares
  if (p === '/shares' && m === 'GET') { let l = shares; if (q.get('assetId')) l = l.filter((s) => s.assetId === q.get('assetId')); if (q.get('collectionId')) l = l.filter((s) => s.collectionId === q.get('collectionId')); return json(res, 200, l.map(shareDto)); }
  if (p === '/shares' && m === 'POST') { const b = await readBody(req); const s = { id: randomUUID(), token: randomBytes(18).toString('base64url'), ownerId: me().id, assetId: b.assetId ?? null, collectionId: b.collectionId ?? null, password: b.password ?? null, allowDownload: b.allowDownload ?? true, expiresAt: b.expiresInHours ? new Date(Date.now() + b.expiresInHours * 36e5).toISOString() : null, revokedAt: null, viewCount: 0, lastViewedAt: null, createdAt: now() }; shares.unshift(s); const d = shareDto(s); log('share.created', 'share', d.targetName); return json(res, 201, d); }
  if ((x = p.match(/^\/shares\/([^/]+)$/)) && m === 'DELETE') { const s = shares.find((s) => s.id === x[1]); if (s) s.revokedAt = now(); return json(res, 204); }
  if ((x = p.match(/^\/public\/shares\/(.+)$/))) {
    const s = shares.find((s) => s.token === decodeURIComponent(x[1]));
    if (!s || s.revokedAt) return err(res, 404, 'This link is not available');
    if (s.expiresAt && new Date(s.expiresAt) < new Date()) return err(res, 410, 'This link has expired');
    if (s.password) { const pw = req.headers['x-share-password']; if (!pw) return err(res, 401, 'This link is password protected', 'PASSWORD_REQUIRED'); if (pw !== s.password) return err(res, 401, 'Incorrect password', 'PASSWORD_INVALID'); }
    s.viewCount++;
    const list = s.assetId ? assets.filter((a) => a.id === s.assetId) : assets.filter((a) => !a.deletedAt && a.collectionIds.includes(s.collectionId));
    return json(res, 200, { type: s.assetId ? 'asset' : 'collection', title: shareDto(s).targetName, allowDownload: s.allowDownload, expiresAt: s.expiresAt, items: list.map((a) => ({ id: a.id, name: a.title ?? a.fileName, kind: a.kind, mimeType: a.mimeType, width: a.width, height: a.height, durationMs: a.durationMs, dominantColor: a.dominantColor, thumbnailUrl: media(a, 'thumb'), viewUrl: media(a, 'view'), downloadUrl: s.allowDownload ? media(a, 'download') : null })) });
  }

  // ---- jobs, activity
  if (p === '/jobs' && m === 'GET') {
    const all = assets.flatMap((a) => a.jobs.map((j) => ({ ...j, asset: { id: a.id, fileName: a.fileName, title: a.title, kind: a.kind, deletedAt: a.deletedAt } }))).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const counts = {}; all.forEach((j) => (counts[j.status] = (counts[j.status] ?? 0) + 1));
    return json(res, 200, { items: all.slice(0, 100), counts });
  }
  if ((x = p.match(/^\/(?:admin\/)?jobs\/([^/]+)\/retry$/))) { for (const a of assets) { const j = a.jobs.find((j) => j.id === x[1]); if (j) { j.status = 'PENDING'; j.failureReason = null; a.status = 'PROCESSING'; return json(res, 201, j); } } return err(res, 404, 'Job not found'); }
  if (p === '/activity') return json(res, 200, { items: activity.slice(0, 40), nextCursor: null });

  // ---- admin
  if (p.startsWith('/admin/') && me().role !== 'ADMIN') return err(res, 403, 'You do not have permission to perform this action');
  if (p === '/admin/stats') {
    const by = (l, k) => l.reduce((o, i) => ((o[i[k]] = (o[i[k]] ?? 0) + 1), o), {}); const jobs = assets.flatMap((a) => a.jobs);
    return json(res, 200, { totalAssets: assets.length, assetsByStatus: by(assets, 'status'), jobsByStatus: by(jobs, 'status'), queueDepths: { 'image-worker': 0, 'video-worker': 2, 'thumbnail-worker': 0, 'metadata-worker': 1 }, deadLetterDepths: { 'image-worker': 1, 'video-worker': 0, 'thumbnail-worker': 0, 'metadata-worker': 0 }, activeWorkers: { 'image-worker': 2, 'video-worker': 1, 'thumbnail-worker': 1, 'metadata-worker': 1 }, averageProcessingTimeMs: 1840, p95ProcessingTimeMs: 6200, retryCount: jobs.filter((j) => j.status === 'RETRY').length, deadLetterJobCount: jobs.filter((j) => j.status === 'DEAD_LETTER').length });
  }
  if (p === '/admin/jobs/failed') return json(res, 200, assets.flatMap((a) => a.jobs.filter((j) => ['FAILED', 'DEAD_LETTER'].includes(j.status)).map((j) => ({ ...j, asset: { fileName: a.fileName, ownerId: a.ownerId } }))));
  if (p === '/admin/users' && m === 'GET') return json(res, 200, users.map((u) => ({ ...publicUser(u), storageQuotaBytes: u.storageQuotaBytes, usedBytes: u === users[0] ? assets.reduce((s, a) => s + a.fileSize, 0) : 210_000_000, assetCount: u === users[0] ? assets.length : 42 })));
  if ((x = p.match(/^\/admin\/users\/([^/]+)$/)) && m === 'PATCH') { const u = users.find((u) => u.id === x[1]); const b = await readBody(req); if (b.role) u.role = b.role; if (b.storageQuotaBytes !== undefined) u.storageQuotaBytes = b.storageQuotaBytes; return json(res, 200, { ...publicUser(u), storageQuotaBytes: u.storageQuotaBytes }); }
  return err(res, 404, `Not found: ${m} ${p}`);
}

function serveMedia(req, res, url) {
  const name = url.pathname.slice('/media/'.length);
  const kind = url.searchParams.get('k') ?? '';
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=3600' };
  if (name === 'video.mp4') {
    if (!videoFile) { res.writeHead(404, cors); return res.end(); }
    const size = statSync(videoFile).size; const range = req.headers.range;
    if (range) { const [s, e] = range.replace('bytes=', '').split('-'); const start = Number(s), end = e ? Number(e) : size - 1; res.writeHead(206, { ...cors, 'Content-Type': WEBM ? 'video/webm' : 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 }); return createReadStream(videoFile, { start, end }).pipe(res); }
    res.writeHead(200, { ...cors, 'Content-Type': WEBM ? 'video/webm' : 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' }); return createReadStream(videoFile).pipe(res);
  }
  const a = assets.find((s) => `${s.id}.svg` === name);
  if (!a) { res.writeHead(404, cors); return res.end(); }
  const tall = a.height > a.width;
  const svg = kind === 'thumb' ? photoSvg(a.hue, 400, 400) : photoSvg(a.hue, tall ? 900 : 1200, tall ? 1200 : 800);
  res.writeHead(200, { ...cors, 'Content-Type': 'image/svg+xml', ...(kind === 'download' ? { 'Content-Disposition': `attachment; filename="${a.fileName}.svg"` } : {}) });
  res.end(svg);
}

seed();
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'ETag');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try { await route(req, res, new URL(req.url, ORIGIN)); }
  catch (e) { console.error(e); if (!res.headersSent) err(res, 500, e.message); }
}).listen(PORT, () => console.log(`[mock] API on ${ORIGIN}  (sign in with any email; demo@example.com is admin)`));
