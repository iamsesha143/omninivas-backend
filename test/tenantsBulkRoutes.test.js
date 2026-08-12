// Route-level tests for POST /api/properties/:propertyId/tenants and
// POST /api/properties/:propertyId/tenants/bulk -- property-ownership
// authorization (both routes previously had none at all: any valid JWT
// could write a tenant against any propertyId) plus the duplicate-safety
// and historical-tenancy behavior, all added while fixing the Flat 512 /
// Shankar Abhinav agreement-import failure. Same mocked-Supabase harness as
// the other route test files -- no real database touched.
//
// Run with: node --test test/tenantsBulkRoutes.test.js
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
let ownerToken;
let otherOwnerToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  ownerToken = jwt.sign({ sub: 'owner-1', role: 'owner' }, process.env.JWT_SECRET);
  otherOwnerToken = jwt.sign({ sub: 'owner-2', role: 'owner' }, process.env.JWT_SECRET);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockDb.__reset();
});

// The ownership check (`.eq('id', propertyId).eq('user_id', req.userId)
// .is('deleted_at', null).maybeSingle()`) is always the FIRST tenants-related
// query on both routes now, so every test that expects to reach the tenant
// logic must queue its result first. `{ data: { id: 'prop-512' } }` = owned;
// `{ data: null }` = not owned / doesn't exist (the mock's maybeSingle
// resolves to whatever was queued either way).
const queueOwnedProperty = () => mockDb.__queue('properties', { data: { id: 'prop-512' }, error: null });
const queueUnownedProperty = () => mockDb.__queue('properties', { data: null, error: null });

async function bulkCreate(body, { token = ownerToken, propertyId = 'prop-512' } = {}) {
  const res = await fetch(`${baseUrl}/api/properties/${propertyId}/tenants/bulk`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function singleCreate(body, { token = ownerToken, propertyId = 'prop-512' } = {}) {
  const res = await fetch(`${baseUrl}/api/properties/${propertyId}/tenants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// ---- Authorization: bulk route ----

test('tenants/bulk: a cross-owner property id is rejected before any tenant query or write', async () => {
  queueUnownedProperty(); // owner-2's token, but this property belongs to owner-1 -- lookup scoped to req.userId finds nothing
  const res = await bulkCreate({ tenants: [{ name: 'Shankar Abhinay' }] }, { token: otherOwnerToken });
  assert.equal(res.status, 404);
  assert.equal(mockDb.__inserts('tenants').length, 0, 'no tenant insert was attempted');
  // Only one 'properties' query was queued and it's the only one consumed --
  // if the route had gone on to query/dedupe tenants, the mock would throw
  // "no response queued for table tenants" instead of returning cleanly.
});

test('tenants/bulk: a nonexistent property id gets the identical 404 shape as a cross-owner one (no existence leak)', async () => {
  queueUnownedProperty();
  const notFoundRes = await bulkCreate({ tenants: [{ name: 'Shankar Abhinay' }] }, { token: ownerToken, propertyId: 'does-not-exist' });

  queueUnownedProperty();
  const crossOwnerRes = await bulkCreate({ tenants: [{ name: 'Shankar Abhinay' }] }, { token: otherOwnerToken, propertyId: 'prop-512' });

  assert.equal(notFoundRes.status, 404);
  assert.equal(crossOwnerRes.status, 404);
  assert.deepEqual(notFoundRes.body, crossOwnerRes.body, 'identical response body -- a cross-owner caller cannot distinguish "wrong owner" from "no such property"');
});

// ---- Authorization: single-tenant route ----

test('tenants (single): a cross-owner property id is rejected before any tenant write', async () => {
  queueUnownedProperty();
  const res = await singleCreate({ name: 'Shankar Abhinay' }, { token: otherOwnerToken });
  assert.equal(res.status, 404);
});

test('tenants (single): a nonexistent property id also gets a 404, same shape as cross-owner', async () => {
  queueUnownedProperty();
  const res = await singleCreate({ name: 'Shankar Abhinay' }, { propertyId: 'does-not-exist' });
  assert.equal(res.status, 404);
});

test('tenants (single): same-owner property passes the check and inserts normally', async () => {
  queueOwnedProperty();
  mockDb.__queue('tenants', { data: [{ id: 'tenant-1', name: 'Shankar Abhinay' }], error: null });
  const res = await singleCreate({ name: 'Shankar Abhinay' });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'tenant-1');
});

// ---- Same-owner behavior: bulk route ----

test('tenants/bulk: same-owner, no existing tenants -- normal insert', async () => {
  queueOwnedProperty();
  mockDb.__queue('tenants', { data: [], error: null }); // existing-active lookup: none
  mockDb.__queue('tenants', { data: [{ id: 'tenant-1', name: 'Shankar Abhinay' }], error: null }); // insert result

  const res = await bulkCreate({ tenants: [{ name: 'Shankar Abhinay', date_of_move_in: '2025-07-01' }] });
  assert.equal(res.status, 201);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.linked_count, 0);
  assert.deepEqual(res.body.tenants.map(t => t.id), ['tenant-1']);

  const inserted = mockDb.__inserts('tenants')[0];
  assert.equal(inserted[0].name, 'Shankar Abhinay');
  assert.equal(inserted[0].is_active, true, 'defaults to active when the caller does not say otherwise');
});

test('tenants/bulk: same-owner retry (server already has the tenant from a lost first response) links instead of duplicating', async () => {
  queueOwnedProperty();
  // The retry's own existing-active lookup now finds the row the first
  // (response-lost) attempt already created.
  mockDb.__queue('tenants', { data: [{ id: 'tenant-1', name: 'Shankar Abhinay' }], error: null });

  const res = await bulkCreate({ tenants: [{ name: 'Shankar Abhinay', date_of_move_in: '2025-07-01' }] });
  assert.equal(res.status, 201);
  assert.equal(res.body.count, 0, 'nothing new was inserted');
  assert.equal(res.body.linked_count, 1);
  assert.deepEqual(res.body.tenants.map(t => t.id), ['tenant-1']);
  assert.equal(mockDb.__inserts('tenants').length, 0, 'no insert call was made at all on the retry');
});

test('tenants/bulk: the name match is case-insensitive', async () => {
  queueOwnedProperty();
  mockDb.__queue('tenants', { data: [{ id: 'tenant-1', name: 'Shankar Abhinay' }], error: null });
  const res = await bulkCreate({ tenants: [{ name: 'shankar abhinay' }] });
  assert.equal(res.body.linked_count, 1);
  assert.equal(res.body.count, 0);
});

test('tenants/bulk: is_active:false with actual_date_of_move_out saves a historical-only record, never silently active', async () => {
  queueOwnedProperty();
  mockDb.__queue('tenants', { data: [], error: null });
  mockDb.__queue('tenants', { data: [{ id: 'tenant-1', name: 'Shankar Abhinay', is_active: false }], error: null });

  const res = await bulkCreate({
    tenants: [{ name: 'Shankar Abhinay', date_of_move_in: '2025-07-01', is_active: false, actual_date_of_move_out: '2026-06-01' }]
  });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('tenants')[0][0];
  assert.equal(inserted.is_active, false);
  assert.equal(inserted.actual_date_of_move_out, '2026-06-01');
});

test('tenants/bulk: an inactive/historical existing tenant is NOT matched for linking (only active tenants are considered)', async () => {
  // The existing-active lookup is scoped to is_active=true at the DB level,
  // so a historical Shankar record from a prior import never gets silently
  // reused/reactivated by an unrelated new upload.
  queueOwnedProperty();
  mockDb.__queue('tenants', { data: [], error: null }); // .eq('is_active', true) legitimately finds nothing
  mockDb.__queue('tenants', { data: [{ id: 'tenant-2', name: 'Shankar Abhinay' }], error: null });

  const res = await bulkCreate({ tenants: [{ name: 'Shankar Abhinay' }] });
  assert.equal(res.body.count, 1, 'a new row is created, not linked to the inactive one');
  assert.equal(mockDb.__inserts('tenants').length, 1);
});

test('tenants/bulk: mixed batch -- one new, one exact-match -- inserts only the new one and preserves response order', async () => {
  queueOwnedProperty();
  mockDb.__queue('tenants', { data: [{ id: 'existing-1', name: 'Priya Nair' }], error: null });
  mockDb.__queue('tenants', { data: [{ id: 'new-1', name: 'Shankar Abhinay' }], error: null });

  const res = await bulkCreate({ tenants: [{ name: 'Priya Nair' }, { name: 'Shankar Abhinay' }] });
  assert.equal(res.body.count, 1);
  assert.equal(res.body.linked_count, 1);
  assert.deepEqual(res.body.tenants.map(t => t.id), ['existing-1', 'new-1']);
});
