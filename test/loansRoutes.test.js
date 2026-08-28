// Route-level tests for the Phase 5 spike: POST/GET /api/properties/:id/loans
// and PATCH /api/loans/:id. Same FIFO mocked-Supabase harness as the other
// route test files. loanMath.js's own correctness is covered separately in
// test/loanMath.test.js -- these tests only cover the routes' auth/
// ownership/wiring, not re-deriving the amortization math.
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
let tenantToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  ownerToken = jwt.sign({ sub: 'owner-1', role: 'owner' }, process.env.JWT_SECRET);
  tenantToken = jwt.sign({ sub: 'tenant-1', role: 'tenant' }, process.env.JWT_SECRET);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockDb.__reset();
});

const validLoan = { lender_name: 'HDFC Bank', principal: 1000000, interest_rate: 8.5, tenure_months: 240, emi_amount: 8700, start_date: '2024-01-01' };

test('POST loans: a tenant token is rejected with 403 (owner-only)', async () => {
  const res = await fetch(`${baseUrl}/api/properties/p1/loans`, {
    method: 'POST', headers: { Authorization: `Bearer ${tenantToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(validLoan)
  });
  assert.equal(res.status, 403);
});

test('POST loans: no token is a 401', async () => {
  const res = await fetch(`${baseUrl}/api/properties/p1/loans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validLoan) });
  assert.equal(res.status, 401);
});

test('POST loans: missing a required field is a 400, never reaches the DB', async () => {
  const res = await fetch(`${baseUrl}/api/properties/p1/loans`, {
    method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...validLoan, lender_name: '' })
  });
  assert.equal(res.status, 400);
});

test('POST loans: a property_id NOT belonging to the owner (or nonexistent) is rejected before any write, generic 404', async () => {
  mockDb.__queue('properties', { data: null, error: null }); // maybeSingle: no row
  const res = await fetch(`${baseUrl}/api/properties/not-mine/loans`, {
    method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(validLoan)
  });
  assert.equal(res.status, 404);
  assert.deepEqual(mockDb.__inserts('loans'), []);
});

test('POST loans: a valid request against an owned property creates the loan', async () => {
  mockDb.__queue('properties', { data: { id: 'p1' }, error: null });
  mockDb.__queue('loans', { data: [{ id: 'loan1', property_id: 'p1', ...validLoan }], error: null });

  const res = await fetch(`${baseUrl}/api/properties/p1/loans`, {
    method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(validLoan)
  });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.id, 'loan1');
  const [[written]] = mockDb.__inserts('loans'); // .insert([{...}]) -- array-of-one-array
  assert.equal(written.lender_name, 'HDFC Bank');
  assert.equal(written.user_id, 'owner-1');
});

test('GET loans: unauthorized/nonexistent property is a generic 404', async () => {
  mockDb.__queue('properties', { data: null, error: null });
  const res = await fetch(`${baseUrl}/api/properties/not-mine/loans`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(res.status, 404);
});

test('GET loans: returns each loan enriched with computed months_elapsed and outstanding_balance', async () => {
  mockDb.__queue('properties', { data: { id: 'p1' }, error: null });
  mockDb.__queue('loans', {
    data: [{ id: 'loan1', property_id: 'p1', lender_name: 'HDFC Bank', principal: 1000000, interest_rate: 12, tenure_months: 12, emi_amount: 88849.15, start_date: '2026-01-01', active: true }],
    error: null
  });

  const res = await fetch(`${baseUrl}/api/properties/p1/loans`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.length, 1);
  assert.ok('months_elapsed' in body[0]);
  assert.ok('outstandingBalance' in body[0]);
  assert.equal(body[0].emiCoversInterest, true);
});

test('PATCH loans: updates only the fields sent, scoped to the owner', async () => {
  mockDb.__queue('loans', { data: [{ id: 'loan1', emi_amount: 9000 }], error: null });
  const res = await fetch(`${baseUrl}/api/loans/loan1`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ emi_amount: 9000 })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.emi_amount, 9000);
  assert.deepEqual(mockDb.__updates('loans'), [{ emi_amount: 9000 }]);
});

test('PATCH loans: a nonexistent or not-owned loan id is a generic 404', async () => {
  mockDb.__queue('loans', { data: [], error: null });
  const res = await fetch(`${baseUrl}/api/loans/not-mine`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ emi_amount: 9000 })
  });
  assert.equal(res.status, 404);
});

test('PATCH loans: a tenant token is rejected with 403', async () => {
  const res = await fetch(`${baseUrl}/api/loans/loan1`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${tenantToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ emi_amount: 9000 })
  });
  assert.equal(res.status, 403);
});
