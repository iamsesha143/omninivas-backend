// Separate file (not folded into razorpayWebhookRoute.test.js) specifically
// because RAZORPAY_WEBHOOK_SECRET must be UNSET here, for the whole file --
// each test file gets its own fresh module registry under node --test, so
// this is the clean way to test the "not configured" state without a
// mid-file re-require of server.js (untested, fragile territory; every
// other route test file in this repo sets its env/mocks once at the top
// and never changes them mid-file).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMockSupabase } = require('./supabaseMock');

const supabasePath = require.resolve('@supabase/supabase-js');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { createClient: () => createMockSupabase() }
};

delete process.env.RAZORPAY_WEBHOOK_SECRET;
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

test('POST /api/webhooks/razorpay returns 503 when RAZORPAY_WEBHOOK_SECRET is not set', async () => {
  const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(res.status, 503);
});
