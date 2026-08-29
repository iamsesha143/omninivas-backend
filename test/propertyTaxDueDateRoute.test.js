// PATCH /api/properties/:id -- specifically the property_tax_due_date
// addition (Phase 6 spike). This just needs to round-trip through the
// existing field allow-list correctly; the reminder-generation logic it
// feeds is covered separately in test/reminders.test.js.
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

test('PATCH property: property_tax_due_date is accepted and persisted', async () => {
  mockDb.__queue('properties', { data: [{ id: 'p1', property_tax_due_date: '2027-04-30' }], error: null });

  const res = await fetch(`${baseUrl}/api/properties/p1`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_tax_due_date: '2027-04-30' })
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.property_tax_due_date, '2027-04-30');
  assert.deepEqual(mockDb.__updates('properties'), [{ property_tax_due_date: '2027-04-30' }]);
});

test('PATCH property: no token is a 401', async () => {
  const res = await fetch(`${baseUrl}/api/properties/p1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ property_tax_due_date: '2027-04-30' })
  });
  assert.equal(res.status, 401);
});
