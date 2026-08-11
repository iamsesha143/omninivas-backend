// Verifies authLimiter (5 requests / 15 minutes, real express-rate-limit,
// NOT mocked here) actually applies to POST /api/auth/forgot-password.
// Deliberately isolated in its own file/process (node --test runs each test
// file separately) so it gets a pristine in-memory rate-limit store and
// doesn't interfere with -- or get interfered with by -- the broader
// functional coverage in test/passwordResetRoutes.test.js (which mocks
// express-rate-limit to a passthrough specifically because a thorough
// functional suite needs far more than 5 requests). This file makes exactly
// 6 requests: nothing else touches these routes in this process.
//
// Run with: node --test test/passwordResetRateLimit.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMockSupabase } = require('./supabaseMock');

const supabasePath = require.resolve('@supabase/supabase-js');
const mockDb = createMockSupabase();
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { createClient: () => mockDb }
};

const app = require('../server');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function forgotPassword() {
  // Every request is for a non-existing email -- keeps this test focused
  // purely on rate-limit behavior, not on forgot-password's own DB logic
  // (already covered in test/passwordResetRoutes.test.js).
  mockDb.__queue('users', { data: null, error: null });
  const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ratelimit-probe@example.com' })
  });
  return res.status;
}

test('authLimiter: the 6th request within the window is rate-limited (429), the first 5 are not', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push(await forgotPassword());
  }
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200], 'the first 5 requests all succeed');
  assert.equal(statuses[5], 429, 'the 6th request in the same window is rejected by authLimiter');
});
