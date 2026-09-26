// Concurrent API request load test.
// Usage: k6 run --env BASE_URL=http://localhost:8080/api scripts/load-test/api-load.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080/api';
const errors = new Counter('custom_errors');

export const options = {
  scenarios: {
    ramping_api_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'], // 95% of requests under 1s
    http_req_failed: ['rate<0.01'], // less than 1% errors
  },
};

export function setup() {
  // One shared account is enough for a read-heavy load test; a
  // register-storm isn't what this scenario is testing (see queue-burst.js
  // for asset/job creation load instead).
  const email = `loadtest-${Date.now()}@example.com`;
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
  const headers = { Authorization: `Bearer ${data.token}` };

  const listRes = http.get(`${BASE_URL}/assets`, { headers });
  const ok = check(listRes, { 'list assets 200': (r) => r.status === 200 });
  if (!ok) errors.add(1);

  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, { 'health 200': (r) => r.status === 200 });

  sleep(1);
}
