// Route-level tests for the CA export: GET /api/reports/ca-export/print
// (printable HTML, browser Print/Save-as-PDF -- same convention as the
// existing rent-receipt route) and GET /api/reports/ca-export/csv. Same
// FIFO mocked-Supabase harness as the other route test files -- buildCaExportData's
// five parallel selects each hit a different table, so one queued response
// per table is enough regardless of call order.
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

function seedFyData({ obligations = [], payments = [], maintenance = [], tenants = [], properties = [{ id: 'p1', property_name: 'Flat 3B' }] } = {}) {
  mockDb.__queue('properties', { data: properties, error: null });
  mockDb.__queue('obligations', { data: obligations, error: null });
  mockDb.__queue('payments', { data: payments, error: null });
  mockDb.__queue('maintenance_costs', { data: maintenance, error: null });
  mockDb.__queue('tenants', { data: tenants, error: null });
}

test('print route: no token is a 401', async () => {
  const res = await fetch(`${baseUrl}/api/reports/ca-export/print?year=2026`);
  assert.equal(res.status, 401);
});

test('print route: a tenant token is rejected with 403 (owner-only)', async () => {
  const res = await fetch(`${baseUrl}/api/reports/ca-export/print?year=2026`, { headers: { Authorization: `Bearer ${tenantToken}` } });
  assert.equal(res.status, 403);
});

test('print route: renders the FY summary, property breakdown, and ledger with correct totals', async () => {
  seedFyData({
    obligations: [{ id: 'ob1', property_id: 'p1', paid_by: 'tenant', label: 'Rent', type: 'rent', amount: 20000 }],
    payments: [
      { id: 'pay1', property_id: 'p1', obligation_id: 'ob1', amount: 20000, payment_date: '2026-06-05', period: '2026-06-01', status: 'paid' },
      { id: 'pay2', property_id: 'p1', obligation_id: 'ob1', amount: 20000, payment_date: '2026-07-05', period: '2026-07-01', status: 'paid' }
    ],
    maintenance: [{ id: 'mc1', property_id: 'p1', amount: 3000, cost_date: '2026-06-15', status: 'paid', paid_by: 'owner', description: 'Plumbing' }]
  });
  mockDb.__queue('users', { data: { full_name: 'Asha Rao', email: 'asha@test.com' }, error: null });

  const res = await fetch(`${baseUrl}/api/reports/ca-export/print?year=2026`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /FY 2026-27/);
  assert.match(html, /Asha Rao/);
  assert.match(html, /40,000/); // total income (20000+20000)
  assert.match(html, /3,000/); // total expense
  assert.match(html, /Flat 3B/);
  assert.match(html, /Plumbing/);
});

test('print route: a monthly rent over ₹50,000 surfaces the 194-IB note; a lower rent does not', async () => {
  seedFyData({ obligations: [{ id: 'ob1', property_id: 'p1', paid_by: 'tenant', label: 'Rent', type: 'rent', amount: 75000 }] });
  mockDb.__queue('users', { data: { full_name: 'Owner', email: 'o@test.com' }, error: null });

  const res = await fetch(`${baseUrl}/api/reports/ca-export/print?year=2026`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const html = await res.text();
  assert.match(html, /194-IB/);
  assert.match(html, /75,000/);
});

test('print route: no TDS note appears when nothing exceeds the threshold', async () => {
  seedFyData({ obligations: [{ id: 'ob1', property_id: 'p1', paid_by: 'tenant', label: 'Rent', type: 'rent', amount: 20000 }] });
  mockDb.__queue('users', { data: { full_name: 'Owner', email: 'o@test.com' }, error: null });

  const res = await fetch(`${baseUrl}/api/reports/ca-export/print?year=2026`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const html = await res.text();
  assert.doesNotMatch(html, /194-IB/);
});

test('csv route: no token is a 401', async () => {
  const res = await fetch(`${baseUrl}/api/reports/ca-export/csv?year=2026`);
  assert.equal(res.status, 401);
});

test('csv route: a tenant token is rejected with 403', async () => {
  const res = await fetch(`${baseUrl}/api/reports/ca-export/csv?year=2026`, { headers: { Authorization: `Bearer ${tenantToken}` } });
  assert.equal(res.status, 403);
});

test('csv route: correct headers and content, including proper escaping of a comma in a label', async () => {
  seedFyData({
    obligations: [{ id: 'ob1', property_id: 'p1', paid_by: 'tenant', label: 'Rent, monthly', type: 'rent', amount: 20000 }],
    payments: [{ id: 'pay1', property_id: 'p1', obligation_id: 'ob1', amount: 20000, payment_date: '2026-06-05', period: '2026-06-01', status: 'paid' }]
  });

  const res = await fetch(`${baseUrl}/api/reports/ca-export/csv?year=2026`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const csv = await res.text();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="omninivas-ca-export-FY-2026-27\.csv"/);
  assert.match(csv, /"Income",20000/);
  assert.match(csv, /"Rent, monthly"/); // comma-containing label correctly quoted, not split into two fields
});

test('both routes: an empty year (no transactions at all) still returns 200 with a clean empty report', async () => {
  seedFyData();
  mockDb.__queue('users', { data: { full_name: 'Owner', email: 'o@test.com' }, error: null });

  const printRes = await fetch(`${baseUrl}/api/reports/ca-export/print?year=2026`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(printRes.status, 200);
  const html = await printRes.text();
  assert.match(html, /No transactions this year/);

  seedFyData();
  const csvRes = await fetch(`${baseUrl}/api/reports/ca-export/csv?year=2026`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(csvRes.status, 200);
});
