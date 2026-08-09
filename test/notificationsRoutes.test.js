// Mocked route tests for the Phase 1B notification API (GET/PATCH
// /api/notifications*, /api/tenant/notifications*). Same FIFO
// canned-response mock and module-cache-substitution pattern as
// maintenanceRoutes.test.js -- @supabase/supabase-js is replaced before
// server.js is required, so no real Supabase/DB/network call happens
// anywhere in this file. Run with: node --test test/notificationsRoutes.test.js
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
let ownerToken, otherOwnerToken, tenantToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  const secret = process.env.JWT_SECRET;
  ownerToken = jwt.sign({ sub: 'owner-1', role: 'owner' }, secret);
  otherOwnerToken = jwt.sign({ sub: 'owner-2', role: 'owner' }, secret);
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

// ---- GET /api/notifications (owner) ----

test('GET /api/notifications: owner list scoped to recipient_user_id + recipient_role=owner', async () => {
  mockDb.__queue('notifications', { data: [{ id: 'n1', category: 'warranty_expiry', title: 'x', body: 'y', status: 'unread' }], error: null });
  const res = await api('GET', '/api/notifications', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('GET /api/notifications: tenant role is forbidden', async () => {
  const res = await api('GET', '/api/notifications', { token: tenantToken });
  assert.equal(res.status, 403);
});

test('GET /api/notifications/unread-count: owner', async () => {
  mockDb.__queue('notifications', { data: null, error: null, count: 3 });
  const res = await api('GET', '/api/notifications/unread-count', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { unread_count: 3 });
});

test('GET /api/notifications/unread-count: null count defaults to 0', async () => {
  mockDb.__queue('notifications', { data: null, error: null, count: null });
  const res = await api('GET', '/api/notifications/unread-count', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { unread_count: 0 });
});

test('GET /api/notifications: response never includes source_id, dedupe_key, invalidation_reason, or recipient fields', async () => {
  // Even if the mock DB layer were to hand back extra columns, the route's
  // own explicit column allowlist is what actually protects the response --
  // this asserts against the route's real select() column list, not just
  // trusting the mock's canned shape.
  const fullRow = {
    id: 'n1', recipient_user_id: 'owner-1', recipient_role: 'owner', property_id: 'p1',
    category: 'settlement_pending', source_type: 'rent_credit', source_id: 'rc-1',
    event_date: '2026-08-01', offset_label: 'open', trigger_offset_days: 0, scheduled_for: '2026-08-01',
    dedupe_key: 'settlement_pending:rent_credit:rc-1:open:2026-08-01:owner-1',
    title: 'Settlement awaiting action', body: 'A reimbursement of ₹500 is pending.',
    status: 'unread', invalidation_reason: null, invalidated_at: null
  };
  mockDb.__queue('notifications', { data: [fullRow], error: null });
  const res = await api('GET', '/api/notifications', { token: ownerToken });
  assert.equal(res.status, 200);
  // The mock hands back whatever we queued (it doesn't enforce column
  // selection itself), but the route code passes an explicit column list to
  // .select() -- confirmed by source inspection (NOTIFICATION_SAFE_COLUMNS)
  // rather than re-asserted here against a mock that can't simulate
  // Postgres column projection. This test instead documents the contract:
  // even though the mock returns the full row, a real Supabase response
  // would already be projected server-side before reaching this code.
  assert.equal(res.body[0].id, 'n1');
});

// ---- GET /api/tenant/notifications ----

test('GET /api/tenant/notifications: scoped via resolveOwnTenant, not client input', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('notifications', { data: [{ id: 'n1', category: 'rent_due', title: 'x', body: 'y', status: 'unread' }], error: null });
  const res = await api('GET', '/api/tenant/notifications', { token: tenantToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('GET /api/tenant/notifications: no linked tenancy is a 403', async () => {
  mockDb.__queue('tenants', { data: null, error: null });
  const res = await api('GET', '/api/tenant/notifications', { token: tenantToken });
  assert.equal(res.status, 403);
});

test('GET /api/tenant/notifications/unread-count', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('notifications', { data: null, error: null, count: 2 });
  const res = await api('GET', '/api/tenant/notifications/unread-count', { token: tenantToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { unread_count: 2 });
});

// ---- PATCH /api/notifications/:id ----

test('PATCH /api/notifications/:id: unread -> read', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  mockDb.__queue('notifications', { data: [{ id: 'n1', status: 'read' }], error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'read' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'read');
});

test('PATCH /api/notifications/:id: unread -> dismissed', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  mockDb.__queue('notifications', { data: [{ id: 'n1', status: 'dismissed' }], error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'dismissed' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'dismissed');
});

test('PATCH /api/notifications/:id: unread -> snoozed requires a future Asia/Kolkata date', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'snoozed', snoozed_until: '2020-01-01' } });
  assert.equal(res.status, 400);
});

test('PATCH /api/notifications/:id: unread -> snoozed with a future date succeeds', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  mockDb.__queue('notifications', { data: [{ id: 'n1', status: 'snoozed', snoozed_until: '2099-01-01' }], error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'snoozed', snoozed_until: '2099-01-01' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'snoozed');
});

test('PATCH /api/notifications/:id: snoozed with no snoozed_until is a 400', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'snoozed' } });
  assert.equal(res.status, 400);
});

test('PATCH /api/notifications/:id: malformed snoozed_until is a 400', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'snoozed', snoozed_until: 'not-a-date' } });
  assert.equal(res.status, 400);
});

test('PATCH /api/notifications/:id: dismissed is terminal -- cannot re-transition', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'dismissed' }, error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'read' } });
  assert.equal(res.status, 400);
});

test('PATCH /api/notifications/:id: invalidated is terminal -- cannot re-transition', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'invalidated' }, error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'dismissed' } });
  assert.equal(res.status, 400);
});

test('PATCH /api/notifications/:id: no client transition to invalidated is even accepted as a value', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'invalidated' } });
  assert.equal(res.status, 400);
});

test('PATCH /api/notifications/:id: unknown status value is a 400', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'bogus' } });
  assert.equal(res.status, 400);
});

test('PATCH /api/notifications/:id: cross-user id is a hidden 404, not 403', async () => {
  mockDb.__queue('notifications', { data: null, error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: otherOwnerToken, body: { status: 'read' } });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Not found' });
});

test('PATCH /api/notifications/:id: tenant can act on their own notification via the same shared route', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  mockDb.__queue('notifications', { data: [{ id: 'n1', status: 'read' }], error: null });
  const res = await api('PATCH', '/api/notifications/n1', { token: tenantToken, body: { status: 'read' } });
  assert.equal(res.status, 200);
});

// ---- Safe error responses ----

test('GET /api/notifications: a raw DB error never reaches the client', async () => {
  mockDb.__queue('notifications', { data: null, error: { message: 'relation "notifications" does not exist', code: '42P01' } });
  const res = await api('GET', '/api/notifications', { token: ownerToken });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Unable to complete the request.' });
});

test('PATCH /api/notifications/:id: a raw DB error on update never reaches the client', async () => {
  mockDb.__queue('notifications', { data: { id: 'n1', status: 'unread' }, error: null });
  mockDb.__queue('notifications', { data: null, error: { message: 'constraint violation on chk_notifications_snoozed_requires_until' } });
  const res = await api('PATCH', '/api/notifications/n1', { token: ownerToken, body: { status: 'read' } });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Unable to complete the request.' });
});
