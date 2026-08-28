// Pure-logic tests for cashflow.js -- classifySettled/paymentInRange are
// already exercised indirectly via test/cashflowRoutes.test.js's route
// tests (the extraction from server.js's local closure didn't change
// behavior, confirmed by that suite still passing byte-for-byte). This file
// covers the pieces new to the CA export: computeDeposits, tdsFlags, and
// the fiscal-year helpers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cashflow = require('../cashflow');

const propertyName = (map) => (id) => map.get(id) || '';

test('computeDeposits: status progression -- awaiting_confirmation, received, partially_refunded, refunded', () => {
  const names = propertyName(new Map([['p1', 'Flat 3B']]));
  const deposits = cashflow.computeDeposits({
    tenants: [
      { id: 't1', property_id: 'p1', name: 'A', deposit_amount: 50000, deposit_paid_date: null },
      { id: 't2', property_id: 'p1', name: 'B', deposit_amount: 50000, deposit_paid_date: '2026-01-01' },
      { id: 't3', property_id: 'p1', name: 'C', deposit_amount: 50000, deposit_paid_date: '2026-01-01', deposit_refunded_amount: 20000 },
      { id: 't4', property_id: 'p1', name: 'D', deposit_amount: 50000, deposit_paid_date: '2026-01-01', deposit_refunded_amount: 50000 }
    ],
    propertyName: names
  });
  assert.equal(deposits.find(d => d.tenant_id === 't1').status, 'awaiting_confirmation');
  assert.equal(deposits.find(d => d.tenant_id === 't2').status, 'received');
  assert.equal(deposits.find(d => d.tenant_id === 't3').status, 'partially_refunded');
  assert.equal(deposits.find(d => d.tenant_id === 't4').status, 'refunded');
});

test('computeDeposits: a tenant with no deposit_amount at all is excluded entirely', () => {
  const deposits = cashflow.computeDeposits({ tenants: [{ id: 't1', deposit_amount: null }], propertyName: () => '' });
  assert.equal(deposits.length, 0);
});

test('tdsFlags: a tenant-paid rent obligation over ₹50,000/month is flagged', () => {
  const names = propertyName(new Map([['p1', 'Flat 3B']]));
  const flags = cashflow.tdsFlags({
    obligations: [{ property_id: 'p1', type: 'rent', paid_by: 'tenant', amount: 60000 }],
    propertyName: names
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].property_name, 'Flat 3B');
  assert.equal(flags[0].monthly_rent, 60000);
  assert.match(flags[0].note, /194-IB/);
});

test('tdsFlags: exactly at the threshold is NOT flagged (strictly greater than)', () => {
  const flags = cashflow.tdsFlags({
    obligations: [{ property_id: 'p1', type: 'rent', paid_by: 'tenant', amount: 50000 }],
    propertyName: () => 'x'
  });
  assert.equal(flags.length, 0);
});

test('tdsFlags: an owner-paid obligation is never flagged regardless of amount (194-IB is about the TENANT deducting)', () => {
  const flags = cashflow.tdsFlags({
    obligations: [{ property_id: 'p1', type: 'rent', paid_by: 'owner', amount: 90000 }],
    propertyName: () => 'x'
  });
  assert.equal(flags.length, 0);
});

test('tdsFlags: a non-rent obligation is never flagged even if it exceeds the threshold', () => {
  const flags = cashflow.tdsFlags({
    obligations: [{ property_id: 'p1', type: 'electricity', paid_by: 'tenant', amount: 90000 }],
    propertyName: () => 'x'
  });
  assert.equal(flags.length, 0);
});

test('fiscalYearRange: April 1 through March 31 of the following year, correct label', () => {
  const fy = cashflow.fiscalYearRange(2026);
  assert.equal(fy.start, '2026-04-01');
  assert.equal(fy.end, '2027-03-31');
  assert.equal(fy.label, 'FY 2026-27');
});

test('currentFiscalYearStart: a date in April-December falls in the FY starting that same calendar year', () => {
  assert.equal(cashflow.currentFiscalYearStart('2026-08-28'), 2026);
  assert.equal(cashflow.currentFiscalYearStart('2026-04-01'), 2026);
  assert.equal(cashflow.currentFiscalYearStart('2026-12-31'), 2026);
});

test('currentFiscalYearStart: a date in January-March falls in the FY that started the PREVIOUS calendar year', () => {
  assert.equal(cashflow.currentFiscalYearStart('2026-01-01'), 2025);
  assert.equal(cashflow.currentFiscalYearStart('2026-03-31'), 2025);
});
