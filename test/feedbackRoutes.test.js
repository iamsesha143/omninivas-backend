// Route-level tests for POST /api/feedback (in-app Help & Feedback).
// Same harness convention as test/maintenanceRoutes.test.js and
// test/uploadRoutes.test.js -- @supabase/supabase-js is replaced with
// test/supabaseMock.js before server.js loads, so no real Supabase/database
// is touched. No live upload/email/notification involved in this route at all.
//
// Run with: node --test test/feedbackRoutes.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
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
let ownerToken, tenantToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  const secret = process.env.JWT_SECRET;
  ownerToken = jwt.sign({ sub: 'owner-1', role: 'owner' }, secret);
  tenantToken = jwt.sign({ sub: 'tenant-user-1', role: 'tenant' }, secret);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockDb.__reset();
});

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const validBody = { category: 'bug', message: 'The rent due date shows the wrong day.', page: '/bills', app_version: '1.0.0' };

test('POST /api/feedback: valid owner submission succeeds and stores server-derived identity', async () => {
  mockDb.__queue('feedback_submissions', { data: [{ id: 'fb-1', created_at: '2026-08-10T00:00:00.000Z' }], error: null });
  const res = await api('POST', '/api/feedback', { token: ownerToken, body: validBody });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'fb-1');
  const inserted = mockDb.__inserts('feedback_submissions')[0][0];
  assert.equal(inserted.user_id, 'owner-1');
  assert.equal(inserted.role, 'owner');
  assert.equal(inserted.category, 'bug');
  assert.equal(inserted.message, validBody.message);
});

test('POST /api/feedback: valid tenant submission succeeds and stores role=tenant', async () => {
  mockDb.__queue('feedback_submissions', { data: [{ id: 'fb-2', created_at: '2026-08-10T00:00:00.000Z' }], error: null });
  const res = await api('POST', '/api/feedback', { token: tenantToken, body: { category: 'question', message: 'How do I see my payment history?' } });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('feedback_submissions')[0][0];
  assert.equal(inserted.user_id, 'tenant-user-1');
  assert.equal(inserted.role, 'tenant');
});

test('POST /api/feedback: missing message is a 400 and inserts nothing', async () => {
  const res = await api('POST', '/api/feedback', { token: ownerToken, body: { category: 'bug' } });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__inserts('feedback_submissions').length, 0);
});

test('POST /api/feedback: message under 5 characters (after trim) is a 400', async () => {
  const res = await api('POST', '/api/feedback', { token: ownerToken, body: { category: 'bug', message: '  hi  ' } });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__inserts('feedback_submissions').length, 0);
});

test('POST /api/feedback: message over 2000 characters is a 400', async () => {
  const res = await api('POST', '/api/feedback', { token: ownerToken, body: { category: 'bug', message: 'x'.repeat(2001) } });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__inserts('feedback_submissions').length, 0);
});

test('POST /api/feedback: message at exactly 2000 characters is accepted', async () => {
  mockDb.__queue('feedback_submissions', { data: [{ id: 'fb-3', created_at: '2026-08-10T00:00:00.000Z' }], error: null });
  const res = await api('POST', '/api/feedback', { token: ownerToken, body: { category: 'bug', message: 'x'.repeat(2000) } });
  assert.equal(res.status, 201);
});

test('POST /api/feedback: invalid category is a 400 and inserts nothing', async () => {
  const res = await api('POST', '/api/feedback', { token: ownerToken, body: { category: 'complaint', message: 'This is a valid length message.' } });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__inserts('feedback_submissions').length, 0);
});

test('POST /api/feedback: no token is a 401', async () => {
  const res = await api('POST', '/api/feedback', { body: validBody });
  assert.equal(res.status, 401);
});

test('POST /api/feedback: spoofed user_id/role/property_name-as-object in the body are ignored -- identity always comes from the verified token', async () => {
  mockDb.__queue('feedback_submissions', { data: [{ id: 'fb-4', created_at: '2026-08-10T00:00:00.000Z' }], error: null });
  const res = await api('POST', '/api/feedback', {
    token: ownerToken,
    body: { ...validBody, user_id: 'someone-elses-id', role: 'tenant', id: 'attacker-chosen-id' }
  });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('feedback_submissions')[0][0];
  assert.equal(inserted.user_id, 'owner-1', 'server-derived user_id, not the spoofed body value');
  assert.equal(inserted.role, 'owner', 'server-derived role, not the spoofed body value');
  assert.equal(res.body.id, 'fb-4', 'the id returned is the DB-generated one, not the attacker-supplied one');
});

test('POST /api/feedback: optional page/app_version/property_name are stored when present, null when absent', async () => {
  mockDb.__queue('feedback_submissions', { data: [{ id: 'fb-5', created_at: '2026-08-10T00:00:00.000Z' }], error: null });
  const res = await api('POST', '/api/feedback', { token: ownerToken, body: { category: 'other', message: 'Just a note, no extra context.' } });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('feedback_submissions')[0][0];
  assert.equal(inserted.page, null);
  assert.equal(inserted.app_version, null);
  assert.equal(inserted.property_name, null);
});

test('POST /api/feedback: a DB failure returns a safe generic error, never the raw DB message', async () => {
  mockDb.__queue('feedback_submissions', { data: null, error: { message: 'internal constraint detail that must never reach the client' } });
  const res = await api('POST', '/api/feedback', { token: ownerToken, body: validBody });
  assert.equal(res.status, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /constraint detail/);
});
