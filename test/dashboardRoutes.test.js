// Route-level tests for GET /api/dashboard, focused on the Portfolio Overview
// `occupiedProperties` addition (a property counts as occupied when it has at
// least one active tenant, derived from the same active-tenants rows the
// route already fetches -- no new query). Same mocked-Supabase harness as
// the other route test files -- no real database touched.
//
// Run with: node --test test/dashboardRoutes.test.js
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

async function api(path, token) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// GET /api/dashboard's fixed call sequence (per server.js): properties,
// tenants, payments (paid), maintenance_costs (pending), obligations,
// payments (this-month, second queue entry), then a second Promise.all:
// properties (second queue entry, with agreement fields), appliances.
function queueDashboard(mockDb, { properties = [], tenants = [], fullProperties = null } = {}) {
  mockDb.__queue('properties', { data: properties, error: null });
  mockDb.__queue('tenants', { data: tenants, error: null });
  mockDb.__queue('payments', { data: [], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [], error: null });
  mockDb.__queue('properties', { data: fullProperties || properties, error: null });
  mockDb.__queue('appliances', { data: [], error: null });
}

const ownerToken = () => jwt.sign({ sub: 'owner-1', role: 'owner' }, process.env.JWT_SECRET);

test('GET /api/dashboard: no tenants at all -> occupiedProperties is 0', async () => {
  queueDashboard(mockDb, {
    properties: [{ id: 'p-1', property_name: 'A' }, { id: 'p-2', property_name: 'B' }],
    tenants: []
  });
  const res = await api('/api/dashboard', ownerToken());
  assert.equal(res.status, 200);
  assert.equal(res.body.occupiedProperties, 0);
  assert.equal(res.body.totalProperties, 2);
});

test('GET /api/dashboard: two active tenants on the same property count as one occupied property', async () => {
  queueDashboard(mockDb, {
    properties: [{ id: 'p-1', property_name: 'A' }],
    tenants: [
      { id: 't-1', name: 'Alice', property_id: 'p-1' },
      { id: 't-2', name: 'Bob', property_id: 'p-1' }
    ]
  });
  const res = await api('/api/dashboard', ownerToken());
  assert.equal(res.status, 200);
  assert.equal(res.body.occupiedProperties, 1);
  assert.equal(res.body.totalTenants, 2);
});

test('GET /api/dashboard: mixed occupied and vacant properties', async () => {
  queueDashboard(mockDb, {
    properties: [{ id: 'p-1', property_name: 'A' }, { id: 'p-2', property_name: 'B' }, { id: 'p-3', property_name: 'C' }],
    tenants: [
      { id: 't-1', name: 'Alice', property_id: 'p-1' },
      { id: 't-2', name: 'Bob', property_id: 'p-3' }
    ]
  });
  const res = await api('/api/dashboard', ownerToken());
  assert.equal(res.status, 200);
  assert.equal(res.body.totalProperties, 3);
  assert.equal(res.body.occupiedProperties, 2);
  // vacant is derived on the frontend as totalProperties - occupiedProperties (3 - 2 = 1),
  // not returned as a separate field by this route.
});

// Isolation note: the mocked Supabase client (test/supabaseMock.js) is a FIFO
// queue per table and does not evaluate .eq('user_id', ...) filter arguments,
// so it cannot prove the real Supabase query actually scopes by owner. What
// this test DOES verify: each request only ever sees the response queued for
// it, independently, with no bleed-through of another request's tenant data --
// combined with the route's unchanged `.eq('user_id', req.userId)` filters
// (server.js:2243-2244, not touched by this slice), that's the same isolation
// guarantee every other route in this codebase relies on and is tested the
// same way (see test/propertyTypeRoutes.test.js, test/feedbackRoutes.test.js).
test('GET /api/dashboard: two separate requests each get their own queued (owner-scoped) data, no cross-request bleed', async () => {
  queueDashboard(mockDb, {
    properties: [{ id: 'p-1', property_name: 'Owner1 Property' }],
    tenants: [{ id: 't-1', name: 'Owner1 Tenant', property_id: 'p-1' }]
  });
  const res1 = await api('/api/dashboard', jwt.sign({ sub: 'owner-1', role: 'owner' }, process.env.JWT_SECRET));
  assert.equal(res1.body.occupiedProperties, 1);
  assert.equal(res1.body.totalProperties, 1);

  queueDashboard(mockDb, {
    properties: [{ id: 'p-2', property_name: 'Owner2 Property A' }, { id: 'p-3', property_name: 'Owner2 Property B' }],
    tenants: []
  });
  const res2 = await api('/api/dashboard', jwt.sign({ sub: 'owner-2', role: 'owner' }, process.env.JWT_SECRET));
  assert.equal(res2.body.occupiedProperties, 0);
  assert.equal(res2.body.totalProperties, 2);
});
