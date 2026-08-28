// Route-level tests for POST /api/webhooks/razorpay, using real HTTP
// requests through the actual express app (not a direct function call) so
// the express.json() verify hook really populates req.rawBody and the
// signature check runs against the exact bytes an HTTP client would send --
// the one thing a unit test of verifyWebhookSignature() alone can't prove.
//
// Uses the in-memory table mock (test/inMemorySupabaseMock.js), not the
// FIFO canned-response mock -- the idempotency guarantee this route relies
// on is a real upsert(..., {onConflict, ignoreDuplicates}), which only the
// in-memory mock implements (the same reason jobs/runReminders.js's own
// tests use it, for the identical dedupe pattern).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createInMemorySupabase } = require('./inMemorySupabaseMock');

const supabasePath = require.resolve('@supabase/supabase-js');
let currentSupabase;
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { createClient: () => currentSupabase }
};

const WEBHOOK_SECRET = 'test-razorpay-webhook-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

// server.js's own `supabase` const is created once at require time, bound
// to whatever currentSupabase pointed to at that moment -- so tests can't
// swap the instance out per-test the way FIFO-mock tests do. Instead each
// test seeds the ONE shared instance's tables directly before making its
// request, and clears them after. Acceptable here since this route only
// touches two tables (obligations, payments) and every test is single-shot
// (one webhook call each).
currentSupabase = createInMemorySupabase({ obligations: [], payments: [] });
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

function resetTables(overrides = {}) {
  currentSupabase.__tables.obligations = overrides.obligations || [];
  currentSupabase.__tables.payments = overrides.payments || [];
}

function sign(bodyString) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(bodyString).digest('hex');
}

async function postWebhook(bodyObj, { signature, skipSignature } = {}) {
  const bodyString = JSON.stringify(bodyObj);
  const sig = skipSignature ? undefined : (signature !== undefined ? signature : sign(bodyString));
  const headers = { 'Content-Type': 'application/json' };
  if (sig !== undefined) headers['x-razorpay-signature'] = sig;
  return fetch(`${baseUrl}/api/webhooks/razorpay`, { method: 'POST', headers, body: bodyString });
}

const paidPayload = (overrides = {}) => ({
  event: 'payment_link.paid',
  payload: {
    payment: { entity: { id: 'pay_test123', amount: 1000000 } }, // paise -> 10000.00 rupees
    payment_link: { entity: { id: 'plink_test123', reference_id: 'ob1:2026-08-01' } }
  },
  ...overrides
});

test('rejects with an invalid signature', async () => {
  resetTables();
  const res = await postWebhook(paidPayload(), { signature: 'not-a-real-signature' });
  assert.equal(res.status, 400);
});

test('rejects with a missing signature header', async () => {
  resetTables();
  const res = await postWebhook(paidPayload(), { skipSignature: true });
  assert.equal(res.status, 400);
});

test('a non-payment_link.paid event is acknowledged and ignored, not processed', async () => {
  resetTables();
  const res = await postWebhook(paidPayload({ event: 'payment_link.cancelled' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ignored, 'payment_link.cancelled');
  assert.equal(currentSupabase.__tables.payments.length, 0);
});

test('a malformed reference_id (no period) is rejected as 400', async () => {
  resetTables();
  const res = await postWebhook(paidPayload({
    payload: { payment: { entity: { id: 'pay_x', amount: 100 } }, payment_link: { entity: { id: 'plink_x', reference_id: 'ob1' } } }
  }));
  assert.equal(res.status, 400);
});

test('an unknown obligation reference is acknowledged (200) but creates nothing', async () => {
  resetTables({ obligations: [] });
  const res = await postWebhook(paidPayload());
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ignored, 'unknown obligation reference');
  assert.equal(currentSupabase.__tables.payments.length, 0);
});

test('a valid new payment is created with the correct fields, amount converted from paise', async () => {
  resetTables({ obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1' }] });

  const res = await postWebhook(paidPayload());
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.created, true);
  assert.equal(currentSupabase.__tables.payments.length, 1);
  const written = currentSupabase.__tables.payments[0];
  assert.equal(written.property_id, 'p1');
  assert.equal(written.user_id, 'owner-1');
  assert.equal(written.obligation_id, 'ob1');
  assert.equal(written.period, '2026-08-01');
  assert.equal(written.amount, 10000); // 1000000 paise -> 10000 rupees
  assert.equal(written.status, 'paid');
  assert.equal(written.payment_method, 'razorpay');
  assert.equal(written.razorpay_payment_id, 'pay_test123');
});

test('a replayed webhook for an already-processed payment is acknowledged without creating a duplicate', async () => {
  resetTables({
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1' }],
    payments: [{ id: 'existing-payment', razorpay_payment_id: 'pay_test123', obligation_id: 'ob1', status: 'paid' }]
  });

  const res = await postWebhook(paidPayload());
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.created, false);
  assert.equal(currentSupabase.__tables.payments.length, 1); // still just the one row
});
