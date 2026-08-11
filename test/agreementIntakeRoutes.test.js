// Route-level tests for the Agreement Intake Completion slice's
// approval-to-record persistence idempotency guards:
//   - POST /api/properties/:propertyId/appliances (quantity/source, opt-in
//     dedupe when source='agreement')
//   - POST /api/properties/:propertyId/obligations (dedupe by type+label)
// Same mocked-Supabase harness as the other route test files -- no real
// database touched.
//
// Run with: node --test test/agreementIntakeRoutes.test.js
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

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  ownerToken = jwt.sign({ sub: 'owner-1', role: 'owner' }, process.env.JWT_SECRET);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockDb.__reset();
});

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// ---- POST /api/properties/:propertyId/appliances ----

test('appliances: source=agreement with quantity persists both fields', async () => {
  mockDb.__queue('appliances', { data: [], error: null }); // dedupe check: none found
  mockDb.__queue('appliances', { data: [{ id: 'app-1', name: 'Fan', quantity: 3, source: 'agreement' }], error: null }); // insert
  const res = await api('POST', '/api/properties/prop-1/appliances', { token: ownerToken, body: { name: 'Fan', quantity: 3, source: 'agreement' } });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('appliances')[0][0];
  assert.equal(inserted.quantity, 3);
  assert.equal(inserted.source, 'agreement');
});

test('appliances: omitting quantity/source defaults to quantity=1, source=manual (unchanged existing behavior)', async () => {
  mockDb.__queue('appliances', { data: [{ id: 'app-1', name: 'Geyser' }], error: null });
  const res = await api('POST', '/api/properties/prop-1/appliances', { token: ownerToken, body: { name: 'Geyser' } });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('appliances')[0][0];
  assert.equal(inserted.quantity, 1);
  assert.equal(inserted.source, 'manual');
});

test('appliances: approving the same agreement fixture twice is idempotent -- second call returns the existing row, no second insert', async () => {
  mockDb.__queue('appliances', { data: [], error: null }); // first call: dedupe check finds nothing
  mockDb.__queue('appliances', { data: [{ id: 'app-1', name: 'Geyser', quantity: 1, source: 'agreement' }], error: null }); // first call: insert
  const first = await api('POST', '/api/properties/prop-1/appliances', { token: ownerToken, body: { name: 'Geyser', quantity: 1, source: 'agreement' } });
  assert.equal(first.status, 201);

  mockDb.__queue('appliances', { data: [{ id: 'app-1', name: 'Geyser', quantity: 1, source: 'agreement' }], error: null }); // second call: dedupe check finds the row from the first call
  const second = await api('POST', '/api/properties/prop-1/appliances', { token: ownerToken, body: { name: 'Geyser', quantity: 1, source: 'agreement' } });
  assert.equal(second.status, 200, 'a duplicate agreement-sourced approval is a no-op success, not an error');
  assert.equal(second.body.id, 'app-1');
  assert.equal(mockDb.__inserts('appliances').length, 1, 'only one appliance row was ever actually inserted');
});

test('appliances: two manually-added appliances with the same name are NOT deduped (source=manual never triggers the guard)', async () => {
  mockDb.__queue('appliances', { data: [{ id: 'app-1', name: 'Fan' }], error: null });
  const first = await api('POST', '/api/properties/prop-1/appliances', { token: ownerToken, body: { name: 'Fan' } });
  assert.equal(first.status, 201);

  mockDb.__queue('appliances', { data: [{ id: 'app-2', name: 'Fan' }], error: null });
  const second = await api('POST', '/api/properties/prop-1/appliances', { token: ownerToken, body: { name: 'Fan' } });
  assert.equal(second.status, 201, 'a second manual "Fan" (e.g. a different room) must still be created');
  assert.equal(mockDb.__inserts('appliances').length, 2);
});

test('appliances: quantity is not accepted as a non-positive value', async () => {
  mockDb.__queue('appliances', { data: [{ id: 'app-1', name: 'Fan', quantity: 1 }], error: null });
  const res = await api('POST', '/api/properties/prop-1/appliances', { token: ownerToken, body: { name: 'Fan', quantity: 0 } });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('appliances')[0][0];
  assert.equal(inserted.quantity, 1, 'an invalid quantity (0) falls back to the safe default of 1, not 0');
});

test('PATCH /api/appliances/:id: quantity can be corrected afterward', async () => {
  mockDb.__queue('appliances', { data: [{ id: 'app-1', name: 'Fan', quantity: 5 }], error: null });
  const res = await api('PATCH', '/api/appliances/app-1', { token: ownerToken, body: { quantity: 5 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.quantity, 5);
});

test('PATCH /api/appliances/:id: a non-positive quantity is rejected', async () => {
  const res = await api('PATCH', '/api/appliances/app-1', { token: ownerToken, body: { quantity: -1 } });
  assert.equal(res.status, 400);
});

// ---- POST /api/properties/:propertyId/obligations ----

test('obligations: approving the same agreement responsibility clause twice is idempotent -- second call returns the existing row, no duplicate obligation', async () => {
  mockDb.__queue('obligations', { data: [], error: null }); // first call: dedupe check finds nothing
  mockDb.__queue('obligations', { data: [{ id: 'ob-1', label: 'Electricity', type: 'electricity', paid_by: 'tenant' }], error: null }); // first call: insert
  const first = await api('POST', '/api/properties/prop-1/obligations', { token: ownerToken, body: { type: 'electricity', label: 'Electricity', paid_by: 'tenant' } });
  assert.equal(first.status, 201);

  mockDb.__queue('obligations', { data: [{ id: 'ob-1', label: 'Electricity', type: 'electricity', paid_by: 'tenant' }], error: null }); // second call: dedupe finds the existing row
  const second = await api('POST', '/api/properties/prop-1/obligations', { token: ownerToken, body: { type: 'electricity', label: 'Electricity', paid_by: 'tenant' } });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, 'ob-1');
  assert.equal(mockDb.__inserts('obligations').length, 1);
});

test('obligations: a different label with the same type is NOT treated as a duplicate', async () => {
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('obligations', { data: [{ id: 'ob-1', label: 'Internet', type: 'other' }], error: null });
  const first = await api('POST', '/api/properties/prop-1/obligations', { token: ownerToken, body: { type: 'other', label: 'Internet', paid_by: 'tenant' } });
  assert.equal(first.status, 201);

  mockDb.__queue('obligations', { data: [], error: null }); // dedupe check for a DIFFERENT label finds nothing
  mockDb.__queue('obligations', { data: [{ id: 'ob-2', label: 'DTH', type: 'other' }], error: null });
  const second = await api('POST', '/api/properties/prop-1/obligations', { token: ownerToken, body: { type: 'other', label: 'DTH', paid_by: 'tenant' } });
  assert.equal(second.status, 201);
  assert.equal(mockDb.__inserts('obligations').length, 2);
});

test('obligations: missing label is still rejected before any dedupe check runs', async () => {
  const res = await api('POST', '/api/properties/prop-1/obligations', { token: ownerToken, body: { type: 'rent' } });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__inserts('obligations').length, 0);
});

test('obligations: invalid paid_by is rejected', async () => {
  const res = await api('POST', '/api/properties/prop-1/obligations', { token: ownerToken, body: { label: 'Rent', paid_by: 'nobody' } });
  assert.equal(res.status, 400);
});

test('owner isolation: two different owners approving fixtures with the same name for their own property each get their own row (mock cannot verify the DB-level filter itself, only that each request is served from its own queued response independently -- see test/supabaseMock.js header)', async () => {
  mockDb.__queue('appliances', { data: [], error: null });
  mockDb.__queue('appliances', { data: [{ id: 'app-owner1', name: 'Geyser', source: 'agreement' }], error: null });
  const res1 = await api('POST', '/api/properties/prop-1/appliances', { token: jwt.sign({ sub: 'owner-1', role: 'owner' }, process.env.JWT_SECRET), body: { name: 'Geyser', source: 'agreement' } });
  assert.equal(res1.body.id, 'app-owner1');

  mockDb.__queue('appliances', { data: [], error: null });
  mockDb.__queue('appliances', { data: [{ id: 'app-owner2', name: 'Geyser', source: 'agreement' }], error: null });
  const res2 = await api('POST', '/api/properties/prop-2/appliances', { token: jwt.sign({ sub: 'owner-2', role: 'owner' }, process.env.JWT_SECRET), body: { name: 'Geyser', source: 'agreement' } });
  assert.equal(res2.body.id, 'app-owner2');
});
