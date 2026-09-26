// Simulates a burst of uploads hitting the queue at once, without
// actually transferring large file bodies - confirmUpload requires a
// real object in storage, so this script pre-seeds tiny objects via the
// presigned upload flow with a minimal in-memory payload. This exercises
// job creation, XADD volume, and queue depth growth/drain under burst
// load, which is the part of the pipeline that actually needs stressing.
//
// Usage: k6 run --env BASE_URL=http://localhost:8080/api --env VUS=200 scripts/load-test/queue-burst.js
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080/api';
const VUS = parseInt(__ENV.VUS || '200', 10);
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

export const options = {
  scenarios: {
    burst: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: VUS,
      maxDuration: '2m',
    },
  },
};

export function setup() {
  const email = `burst-${Date.now()}@example.com`;
  const password = 'load-test-password-123';
  http.post(`${BASE_URL}/auth/register`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const loginRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
  });
  return { token: loginRes.json('accessToken') };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.token}`, 'Content-Type': 'application/json' };

  const urlRes = http.post(
    `${BASE_URL}/assets/upload-url`,
    JSON.stringify({ fileName: `burst-${__VU}-${__ITER}.jpg`, mimeType: 'image/jpeg', fileSize: 1024 }),
    { headers },
  );
  if (!check(urlRes, { 'upload-url 201': (r) => r.status === 201 || r.status === 200 })) return;

  const { uploadUrl, storageKey } = urlRes.json();
  const bytes = TINY_JPEG.split(',')[1];
  http.put(uploadUrl, http.file(bytes, 'image.jpg', 'image/jpeg'), { headers: { 'Content-Type': 'image/jpeg' } });

  const confirmRes = http.post(
    `${BASE_URL}/assets`,
    JSON.stringify({ storageKey, fileName: `burst-${__VU}-${__ITER}.jpg`, mimeType: 'image/jpeg' }),
    { headers },
  );
  check(confirmRes, { 'confirm 201': (r) => r.status === 201 || r.status === 200 });
}
