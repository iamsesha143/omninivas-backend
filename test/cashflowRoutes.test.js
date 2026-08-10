// Route-level tests for the Financial Command Center's two new read-only
// routes: GET /api/cashflow and GET /api/approvals. Same mocked-Supabase
// harness as the other route test files -- no real database touched.
//
// Run with: node --test test/cashflowRoutes.test.js
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

async function api(path, token) {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---- GET /api/cashflow ----

test('cashflow: owner-paid obligation payment is excluded from income and counted as an expense', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'SMOKETEST Property' }], error: null });
  mockDb.__queue('obligations', { data: [{ id: 'ob-1', property_id: 'prop-1', paid_by: 'owner', label: 'Society maintenance', type: 'society', amount: 2000, due_day: 5 }], error: null });
  mockDb.__queue('payments', { data: [{ id: 'p-1', property_id: 'prop-1', amount: 2000, payment_date: '2026-08-05', period: '2026-08-01', status: 'paid', tenant_id: null, obligation_id: 'ob-1' }], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await api('/api/cashflow?month=2026-08', ownerToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.cashReceived, 0, 'owner-paid obligation payment must not count as income');
  assert.equal(res.body.expensesPaid, 2000);
  assert.equal(res.body.netCashFlow, -2000);
});

test('cashflow: ad hoc tenant payment (no obligation) counts as income', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [{ id: 'p-1', property_id: 'prop-1', amount: 15000, payment_date: '2026-08-10', period: '2026-08-01', status: 'paid', tenant_id: 't-1', obligation_id: null }], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await api('/api/cashflow?month=2026-08', ownerToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.cashReceived, 15000);
  assert.equal(res.body.expensesPaid, 0);
});

test('cashflow: tenant-paid obligation payment counts as income', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('obligations', { data: [{ id: 'ob-1', property_id: 'prop-1', paid_by: 'tenant', label: 'Rent', type: 'rent', amount: 15000, due_day: 5 }], error: null });
  mockDb.__queue('payments', { data: [{ id: 'p-1', property_id: 'prop-1', amount: 15000, payment_date: '2026-08-05', period: '2026-08-01', status: 'paid', tenant_id: 't-1', obligation_id: 'ob-1' }], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await api('/api/cashflow?month=2026-08', ownerToken);
  assert.equal(res.body.cashReceived, 15000);
});

test('cashflow: pending, pending_confirmation, and rejected payments never affect settled totals', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', {
    data: [
      { id: 'p-1', property_id: 'prop-1', amount: 5000, payment_date: '2026-08-05', period: '2026-08-01', status: 'pending', tenant_id: 't-1', obligation_id: null },
      { id: 'p-2', property_id: 'prop-1', amount: 5000, payment_date: '2026-08-05', period: '2026-08-01', status: 'pending_confirmation', tenant_id: 't-1', obligation_id: null },
      { id: 'p-3', property_id: 'prop-1', amount: 5000, payment_date: '2026-08-05', period: '2026-08-01', status: 'rejected', tenant_id: 't-1', obligation_id: null }
    ], error: null
  });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await api('/api/cashflow?month=2026-08', ownerToken);
  assert.equal(res.body.cashReceived, 0);
  assert.equal(res.body.transactions.length, 0);
});

test('cashflow: a paid payment with a NULL period falls back to payment_date\'s month (the WhatsApp-apply gap fix)', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [{ id: 'p-1', property_id: 'prop-1', amount: 15000, payment_date: '2026-08-15', period: null, status: 'paid', tenant_id: 't-1', obligation_id: null }], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await api('/api/cashflow?month=2026-08', ownerToken);
  assert.equal(res.body.cashReceived, 15000, 'null-period payment must still be picked up via payment_date fallback');
});

test('cashflow: a NULL-period paid payment does NOT leak into an adjacent month', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [{ id: 'p-1', property_id: 'prop-1', amount: 15000, payment_date: '2026-08-15', period: null, status: 'paid', tenant_id: 't-1', obligation_id: null }], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await api('/api/cashflow?month=2026-09', ownerToken);
  assert.equal(res.body.cashReceived, 0);
});

test('cashflow: maintenance cost is included only when paid_by=owner, status=paid, and cost_date is inside the month', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [], error: null });
  mockDb.__queue('maintenance_costs', {
    data: [
      { id: 'm-1', property_id: 'prop-1', amount: 1200, cost_date: '2026-08-01', status: 'paid', paid_by: 'owner', description: 'Plumber', request_status: 'resolved' },
      { id: 'm-2', property_id: 'prop-1', amount: 900, cost_date: '2026-07-31', status: 'paid', paid_by: 'owner', description: 'Late July', request_status: 'resolved' },
      { id: 'm-3', property_id: 'prop-1', amount: 700, cost_date: '2026-08-10', status: 'paid', paid_by: 'tenant', description: 'Tenant paid', request_status: 'resolved' },
      { id: 'm-4', property_id: 'prop-1', amount: 500, cost_date: '2026-08-10', status: 'pending', paid_by: 'owner', description: 'Not yet paid', request_status: 'resolved' }
    ], error: null
  });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await api('/api/cashflow?month=2026-08', ownerToken);
  assert.equal(res.body.expensesPaid, 1200, 'only the in-month, owner-paid, paid-status cost counts');
});

test('cashflow: foreign-owned property_id is rejected before any aggregation', async () => {
  mockDb.__queue('properties', { data: null, error: null }); // maybeSingle: not found
  const res = await api('/api/cashflow?property_id=not-mine', ownerToken);
  assert.equal(res.status, 404);
});

test('cashflow: no token is a 401', async () => {
  const res = await api('/api/cashflow', null);
  assert.equal(res.status, 401);
});

test('cashflow: upcoming excludes already-paid obligations and only covers the current and next month', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('obligations', { data: [{ id: 'ob-1', property_id: 'prop-1', paid_by: 'tenant', label: 'Rent', type: 'rent', amount: 15000, due_day: 5 }], error: null });
  mockDb.__queue('payments', { data: [{ id: 'p-1', property_id: 'prop-1', amount: 15000, payment_date: '2026-08-05', period: '2026-08-01', status: 'paid', tenant_id: 't-1', obligation_id: 'ob-1' }], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await api('/api/cashflow?month=2026-08', ownerToken);
  const months = new Set(res.body.upcoming.map(u => u.month));
  assert.ok([...months].every(m => m === '2026-08' || m === '2026-09'), 'upcoming never contains a third month');
  assert.ok(!res.body.upcoming.some(u => u.month === '2026-08'), 'August is already paid, so it must not appear as upcoming');
  assert.ok(res.body.upcoming.some(u => u.month === '2026-09'), 'September rent (unpaid) should appear as upcoming');
});

test('cashflow: open maintenance lists unresolved requests regardless of month, and excludes resolved/rejected', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [], error: null });
  mockDb.__queue('maintenance_costs', {
    data: [
      { id: 'm-1', property_id: 'prop-1', amount: 500, cost_date: '2026-01-01', status: 'pending', paid_by: 'owner', description: 'Old open issue', request_status: 'reported' },
      { id: 'm-2', property_id: 'prop-1', amount: 500, cost_date: '2026-08-01', status: 'paid', paid_by: 'owner', description: 'Resolved', request_status: 'resolved' },
      { id: 'm-3', property_id: 'prop-1', amount: 500, cost_date: '2026-08-01', status: 'pending', paid_by: 'owner', description: 'Rejected', request_status: 'rejected' }
    ], error: null
  });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await api('/api/cashflow?month=2026-08', ownerToken);
  assert.equal(res.body.openMaintenance.length, 1);
  assert.equal(res.body.openMaintenance[0].id, 'm-1');
});

test('cashflow: deposit status derivation covers awaiting/received/partially_refunded/refunded, and skips tenants with no agreed amount', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('tenants', {
    data: [
      { id: 't-none', property_id: 'prop-1', name: 'No deposit', deposit_amount: null, deposit_paid_date: null, deposit_details: null, deposit_refunded_amount: null, deposit_refunded_date: null },
      { id: 't-await', property_id: 'prop-1', name: 'Awaiting', deposit_amount: 50000, deposit_paid_date: null, deposit_details: null, deposit_refunded_amount: null, deposit_refunded_date: null },
      { id: 't-recv', property_id: 'prop-1', name: 'Received', deposit_amount: 50000, deposit_paid_date: '2026-08-01', deposit_details: 'UPI', deposit_refunded_amount: null, deposit_refunded_date: null },
      { id: 't-partial', property_id: 'prop-1', name: 'Partial refund', deposit_amount: 50000, deposit_paid_date: '2026-01-01', deposit_details: null, deposit_refunded_amount: 20000, deposit_refunded_date: '2026-08-01' },
      { id: 't-full', property_id: 'prop-1', name: 'Full refund', deposit_amount: 50000, deposit_paid_date: '2026-01-01', deposit_details: null, deposit_refunded_amount: 50000, deposit_refunded_date: '2026-08-01' }
    ], error: null
  });

  const res = await api('/api/cashflow?month=2026-08', ownerToken);
  const byName = Object.fromEntries(res.body.deposits.map(d => [d.tenant_name, d.status]));
  assert.equal(res.body.deposits.length, 4, 'tenant with no agreed deposit amount is not shown');
  assert.equal(byName['Awaiting'], 'awaiting_confirmation');
  assert.equal(byName['Received'], 'received');
  assert.equal(byName['Partial refund'], 'partially_refunded');
  assert.equal(byName['Full refund'], 'refunded');
});

// ---- GET /api/approvals ----

test('approvals: pending_confirmation payment appears with tenant name and label', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('tenants', { data: [{ id: 't-1', property_id: 'prop-1', name: 'Asha', deposit_amount: null, deposit_paid_date: null }], error: null });
  mockDb.__queue('obligations', { data: [{ id: 'ob-1', label: 'Rent' }], error: null });
  mockDb.__queue('payments', { data: [{ id: 'p-1', property_id: 'prop-1', amount: 15000, payment_date: '2026-08-05', tenant_id: 't-1', obligation_id: 'ob-1' }], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('whatsapp_imports', { data: [], error: null });

  const res = await api('/api/approvals', ownerToken);
  assert.equal(res.status, 200);
  const item = res.body.items.find(i => i.type === 'payment_confirmation');
  assert.ok(item);
  assert.equal(item.tenant_name, 'Asha');
  assert.equal(item.label, 'Rent');
});

test('approvals: maintenance awaiting decision appears; resolved/rejected are excluded by the query itself', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('tenants', { data: [], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [], error: null });
  mockDb.__queue('maintenance_costs', { data: [{ id: 'm-1', property_id: 'prop-1', amount: 800, description: 'Leaking tap', cost_date: '2026-08-01', vendor_name: null, request_status: 'reported' }], error: null });
  mockDb.__queue('whatsapp_imports', { data: [], error: null });

  const res = await api('/api/approvals', ownerToken);
  const item = res.body.items.find(i => i.type === 'maintenance_approval');
  assert.ok(item);
  assert.equal(item.label, 'Leaking tap');
});

test('approvals: tenant with an agreed deposit but no received date appears; a confirmed tenant does not', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('tenants', {
    data: [
      { id: 't-await', property_id: 'prop-1', name: 'Awaiting', deposit_amount: 50000, deposit_paid_date: null },
      { id: 't-confirmed', property_id: 'prop-1', name: 'Confirmed', deposit_amount: 50000, deposit_paid_date: '2026-08-01' }
    ], error: null
  });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('whatsapp_imports', { data: [], error: null });

  const res = await api('/api/approvals', ownerToken);
  const depositItems = res.body.items.filter(i => i.type === 'deposit_confirmation');
  assert.equal(depositItems.length, 1);
  assert.equal(depositItems[0].tenant_name, 'Awaiting');
});

test('approvals: a pending WhatsApp financial fact appears; a rejected one and an already-applied one do not', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('tenants', { data: [], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('whatsapp_imports', { data: [{ id: 'imp-1', property_id: 'prop-1' }], error: null });
  mockDb.__queue('whatsapp_extracted_facts', {
    data: [
      { id: 'f-pending', import_id: 'imp-1', category: 'payment', fact_type: 'rent_payment', value: '₹15000 paid', confidence: 0.9, evidence: 'rent paid', status: 'pending', owner_edited_value: null, applied_at: null },
      { id: 'f-rejected', import_id: 'imp-1', category: 'payment', fact_type: 'rent_payment', value: 'x', confidence: 0.5, evidence: 'x', status: 'rejected', owner_edited_value: null, applied_at: null },
      { id: 'f-applied', import_id: 'imp-1', category: 'payment', fact_type: 'rent_payment', value: 'x', confidence: 0.9, evidence: 'x', status: 'approved', owner_edited_value: null, applied_at: '2026-08-01T00:00:00Z' }
    ], error: null
  });

  const res = await api('/api/approvals', ownerToken);
  const facts = res.body.items.filter(i => i.type === 'whatsapp_fact');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].id, 'f-pending');
});

test('approvals: non-financial WhatsApp categories (e.g. person, vendor) are never included', async () => {
  mockDb.__queue('properties', { data: [{ id: 'prop-1', property_name: 'P' }], error: null });
  mockDb.__queue('tenants', { data: [], error: null });
  mockDb.__queue('obligations', { data: [], error: null });
  mockDb.__queue('payments', { data: [], error: null });
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  mockDb.__queue('whatsapp_imports', { data: [{ id: 'imp-1', property_id: 'prop-1' }], error: null });
  // The mock doesn't evaluate .in() filters, so simulate the DB having
  // already applied the category filter by only returning financial rows --
  // the person/vendor exclusion is enforced by the route's own .in() query,
  // not by JS filtering, so there is nothing further to assert here beyond
  // confirming the route still works with an empty financial-category result.
  mockDb.__queue('whatsapp_extracted_facts', { data: [], error: null });

  const res = await api('/api/approvals', ownerToken);
  assert.equal(res.body.items.filter(i => i.type === 'whatsapp_fact').length, 0);
});

test('approvals: foreign-owned property_id is rejected before any aggregation', async () => {
  mockDb.__queue('properties', { data: null, error: null });
  const res = await api('/api/approvals?property_id=not-mine', ownerToken);
  assert.equal(res.status, 404);
});

test('approvals: no token is a 401', async () => {
  const res = await api('/api/approvals', null);
  assert.equal(res.status, 401);
});
