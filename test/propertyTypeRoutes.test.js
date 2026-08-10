// Focused route-level tests for property_type validation on
// POST /api/properties and PATCH /api/properties/:id. Same mocked-Supabase
// harness as the other route test files -- no real database touched, no
// migration/CHECK constraint involved (deliberately deferred this slice).
//
// Run with: node --test test/propertyTypeRoutes.test.js
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
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const baseProperty = { property_name: 'Test Property', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };

// ---- POST /api/properties ----

for (const type of ['residential', 'commercial', 'land']) {
  test(`POST /api/properties: property_type='${type}' is accepted`, async () => {
    mockDb.__queue('properties', { data: null, error: null }); // dupe check: none found
    mockDb.__queue('properties', { data: [{ id: 'p-1', ...baseProperty, property_type: type }], error: null }); // insert
    const res = await api('POST', '/api/properties', { token: ownerToken, body: { ...baseProperty, property_type: type } });
    assert.equal(res.status, 201);
    const inserted = mockDb.__inserts('properties')[0][0];
    assert.equal(inserted.property_type, type);
  });
}

test('POST /api/properties: an invalid property_type is rejected before any query', async () => {
  const res = await api('POST', '/api/properties', { token: ownerToken, body: { ...baseProperty, property_type: 'farmland' } });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__inserts('properties').length, 0);
});

test('POST /api/properties: omitting property_type entirely still defaults to residential (unchanged existing behavior)', async () => {
  mockDb.__queue('properties', { data: null, error: null });
  mockDb.__queue('properties', { data: [{ id: 'p-1', ...baseProperty, property_type: 'residential' }], error: null });
  const res = await api('POST', '/api/properties', { token: ownerToken, body: { ...baseProperty } });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('properties')[0][0];
  assert.equal(inserted.property_type, 'residential');
});

// ---- PATCH /api/properties/:id ----

for (const type of ['residential', 'commercial', 'land']) {
  test(`PATCH /api/properties/:id: property_type='${type}' is accepted`, async () => {
    mockDb.__queue('properties', { data: [{ id: 'p-1', property_type: type }], error: null });
    const res = await api('PATCH', '/api/properties/p-1', { token: ownerToken, body: { property_type: type } });
    assert.equal(res.status, 200);
    assert.equal(res.body.property_type, type);
  });
}

test('PATCH /api/properties/:id: an invalid property_type is rejected and never reaches the update call', async () => {
  const res = await api('PATCH', '/api/properties/p-1', { token: ownerToken, body: { property_type: 'industrial' } });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__inserts('properties').length, 0);
});

test('PATCH /api/properties/:id: an empty-string property_type is rejected, not silently accepted', async () => {
  const res = await api('PATCH', '/api/properties/p-1', { token: ownerToken, body: { property_type: '' } });
  assert.equal(res.status, 400);
});

test('PATCH /api/properties/:id: other fields are unaffected when property_type is absent from the body', async () => {
  mockDb.__queue('properties', { data: [{ id: 'p-1', property_name: 'Renamed' }], error: null });
  const res = await api('PATCH', '/api/properties/p-1', { token: ownerToken, body: { property_name: 'Renamed' } });
  assert.equal(res.status, 200);
});
