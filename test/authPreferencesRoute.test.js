// GET /api/auth/me and PATCH /api/auth/me/preferences -- specifically the
// whatsapp_enabled addition. This is a DPDP consent flag, not an ordinary
// preference: the frontend only ever PATCHes it to true after showing the
// full disclosure (sender, message categories, opt-out), but the route
// itself has no way to know that -- these tests only cover that the field
// round-trips correctly and email_enabled/whatsapp_enabled don't clobber
// each other, not the frontend's disclosure UI.
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

test('GET /api/auth/me includes whatsapp_enabled', async () => {
  mockDb.__queue('users', {
    data: { id: 'owner-1', email: 'o@test.com', full_name: 'Owner', role: 'owner', email_enabled: true, whatsapp_enabled: false },
    error: null
  });

  const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.whatsapp_enabled, false);
});

test('PATCH preferences: whatsapp_enabled true is accepted and persisted', async () => {
  mockDb.__queue('users', { data: [{ id: 'owner-1', email: 'o@test.com', full_name: 'Owner', role: 'owner', email_enabled: true, whatsapp_enabled: true }], error: null });

  const res = await fetch(`${baseUrl}/api/auth/me/preferences`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp_enabled: true })
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.whatsapp_enabled, true);
  assert.deepEqual(mockDb.__updates('users'), [{ whatsapp_enabled: true }]);
});

test('PATCH preferences: whatsapp_enabled and email_enabled update independently, one without the other', async () => {
  mockDb.__queue('users', { data: [{ id: 'owner-1', email: 'o@test.com', full_name: 'Owner', role: 'owner', email_enabled: false, whatsapp_enabled: false }], error: null });

  const res = await fetch(`${baseUrl}/api/auth/me/preferences`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp_enabled: false })
  });

  assert.equal(res.status, 200);
  // Only whatsapp_enabled was sent -- email_enabled must not appear in the
  // write payload at all, not even as undefined/false.
  assert.deepEqual(mockDb.__updates('users'), [{ whatsapp_enabled: false }]);
});

test('PATCH preferences: no token is a 401', async () => {
  const res = await fetch(`${baseUrl}/api/auth/me/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp_enabled: true })
  });
  assert.equal(res.status, 401);
});
