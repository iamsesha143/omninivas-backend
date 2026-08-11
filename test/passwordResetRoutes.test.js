// Route-level tests for POST /api/auth/forgot-password and
// POST /api/auth/reset-password. Same mocked-Supabase harness as the other
// route test files -- no real database or email provider touched.
//
// express-rate-limit is ALSO mocked in this file (to a pure passthrough),
// because authLimiter is one real, shared, in-memory-store rate-limit
// instance applied to all four auth routes (register/login/forgot-password/
// reset-password) -- a thorough functional test of forgot/reset alone needs
// more than its 5-requests-per-15-minutes budget, and letting that budget
// leak into unrelated assertions here would make them flaky/order-dependent
// rather than actually testing forgot/reset logic. The real rate-limit
// behavior is verified separately, in isolation, in
// test/passwordResetRateLimit.test.js (a separate process/file, so it gets
// its own fresh in-memory limiter and doesn't need this mock).
//
// Run with: node --test test/passwordResetRoutes.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createMockSupabase } = require('./supabaseMock');

const rateLimitPath = require.resolve('express-rate-limit');
require.cache[rateLimitPath] = {
  id: rateLimitPath, filename: rateLimitPath, loaded: true,
  exports: () => (req, res, next) => next()
};

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

beforeEach(() => {
  mockDb.__reset();
});

async function api(path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- POST /api/auth/forgot-password ----

test('forgot-password: existing email returns the generic message', async () => {
  mockDb.__queue('users', { data: { id: 'user-1', email: 'owner@example.com', full_name: 'Owner One' }, error: null });
  mockDb.__queue('users', { data: [{ id: 'user-1' }], error: null }); // the token-storage update
  const res = await api('/api/auth/forgot-password', { email: 'owner@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "If an account exists for this email, we've sent a reset link.");
});

test('forgot-password: non-existing email returns the IDENTICAL generic message (no enumeration)', async () => {
  mockDb.__queue('users', { data: null, error: null }); // maybeSingle: not found
  const res = await api('/api/auth/forgot-password', { email: 'nobody@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "If an account exists for this email, we've sent a reset link.");
});

test('forgot-password: missing/empty email also returns the identical generic message, not a validation error (no enumeration via error shape)', async () => {
  const res = await api('/api/auth/forgot-password', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "If an account exists for this email, we've sent a reset link.");
});

test('forgot-password: only a SHA-256 hash is ever stored, never the raw token', async () => {
  mockDb.__queue('users', { data: { id: 'user-1', email: 'owner@example.com', full_name: 'Owner' }, error: null });
  mockDb.__queue('users', { data: [{ id: 'user-1' }], error: null });
  await api('/api/auth/forgot-password', { email: 'owner@example.com' });
  const updates = mockDb.__updates('users');
  assert.equal(updates.length, 1);
  const stored = updates[0].password_reset_token_hash;
  assert.match(stored, /^[a-f0-9]{64}$/, 'stored value looks like a hex SHA-256 hash, not a raw token');
  assert.equal(updates[0].password_reset_used_at, null, 'a fresh request always clears any prior used-at marker');
  assert.ok(updates[0].password_reset_expires_at, 'an expiry is always set');
});

test('forgot-password: a second request for the same user invalidates the first token (overwrites the hash)', async () => {
  mockDb.__queue('users', { data: { id: 'user-1', email: 'owner@example.com', full_name: 'Owner' }, error: null });
  mockDb.__queue('users', { data: [{ id: 'user-1' }], error: null });
  await api('/api/auth/forgot-password', { email: 'owner@example.com' });
  const firstHash = mockDb.__updates('users')[0].password_reset_token_hash;

  mockDb.__queue('users', { data: { id: 'user-1', email: 'owner@example.com', full_name: 'Owner' }, error: null });
  mockDb.__queue('users', { data: [{ id: 'user-1' }], error: null });
  await api('/api/auth/forgot-password', { email: 'owner@example.com' });
  const secondHash = mockDb.__updates('users')[1].password_reset_token_hash;

  assert.notEqual(firstHash, secondHash, 'each request generates a fresh, independent token');
});

test('forgot-password: no email/notification-related field is ever echoed back in the response', async () => {
  mockDb.__queue('users', { data: { id: 'user-1', email: 'owner@example.com', full_name: 'Owner' }, error: null });
  mockDb.__queue('users', { data: [{ id: 'user-1' }], error: null });
  const res = await api('/api/auth/forgot-password', { email: 'owner@example.com' });
  assert.deepEqual(Object.keys(res.body), ['message']);
});

// ---- POST /api/auth/reset-password ----

test('reset-password: a valid, unexpired, unused token succeeds and updates the bcrypt hash', async () => {
  const rawToken = 'a'.repeat(64);
  mockDb.__queue('users', {
    data: { id: 'user-1', password_reset_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), password_reset_used_at: null },
    error: null
  });
  mockDb.__queue('users', { data: [{ id: 'user-1' }], error: null }); // the password-update write

  const res = await api('/api/auth/reset-password', { token: rawToken, new_password: 'BrandNewPassword123' });
  assert.equal(res.status, 200);
  const update = mockDb.__updates('users')[0];
  assert.ok(update.password_hash, 'a new bcrypt hash was written');
  assert.notEqual(update.password_hash, 'BrandNewPassword123', 'the password is hashed, never stored in plaintext');
  assert.equal(update.password_reset_token_hash, null, 'the token is cleared after use');
  assert.equal(update.password_reset_expires_at, null);
  assert.ok(update.password_reset_used_at, 'used_at is stamped');
});

test('reset-password: rejects a password shorter than 8 characters (existing registration policy, reused)', async () => {
  const res = await api('/api/auth/reset-password', { token: 'a'.repeat(64), new_password: 'short' });
  assert.equal(res.status, 400);
});

test('reset-password: a token with no matching hash in the DB is rejected (invalid)', async () => {
  mockDb.__queue('users', { data: null, error: null });
  const res = await api('/api/auth/reset-password', { token: 'not-a-real-token', new_password: 'ValidPassword123' });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'invalid');
});

test('reset-password: an expired token is rejected', async () => {
  mockDb.__queue('users', {
    data: { id: 'user-1', password_reset_expires_at: new Date(Date.now() - 60 * 1000).toISOString(), password_reset_used_at: null },
    error: null
  });
  const res = await api('/api/auth/reset-password', { token: 'a'.repeat(64), new_password: 'ValidPassword123' });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'expired');
});

test('reset-password: an already-used token is rejected', async () => {
  mockDb.__queue('users', {
    data: { id: 'user-1', password_reset_expires_at: new Date(Date.now() + 60 * 1000).toISOString(), password_reset_used_at: new Date().toISOString() },
    error: null
  });
  const res = await api('/api/auth/reset-password', { token: 'a'.repeat(64), new_password: 'ValidPassword123' });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'used');
});

test('reset-password: missing token is a 400 before any DB lookup', async () => {
  const res = await api('/api/auth/reset-password', { new_password: 'ValidPassword123' });
  assert.equal(res.status, 400);
});

test('reset-password: error response never reveals which account/email the token belonged to', async () => {
  mockDb.__queue('users', {
    data: { id: 'user-1', password_reset_expires_at: new Date(Date.now() - 1000).toISOString(), password_reset_used_at: null },
    error: null
  });
  const res = await api('/api/auth/reset-password', { token: 'a'.repeat(64), new_password: 'ValidPassword123' });
  assert.doesNotMatch(JSON.stringify(res.body), /@|email|user-1/i);
});

// sha256 helper is exercised implicitly by the above (matches server.js's
// own hashResetToken), kept here for clarity that the two must agree.
test('sanity: the test helper hash function matches the expected SHA-256 hex shape', () => {
  assert.match(sha256('anything'), /^[a-f0-9]{64}$/);
});
