const { test } = require('node:test');
const assert = require('node:assert/strict');
const { monthsElapsed, projectOutstandingBalance } = require('../loanMath');

test('monthsElapsed: same month is 0', () => {
  assert.equal(monthsElapsed('2026-06-15', '2026-06-28'), 0);
});

test('monthsElapsed: crosses months within a year', () => {
  assert.equal(monthsElapsed('2026-01-01', '2026-08-01'), 7);
});

test('monthsElapsed: crosses a calendar year boundary', () => {
  assert.equal(monthsElapsed('2025-10-01', '2026-08-01'), 10);
});

test('monthsElapsed: never negative, even if start_date is in the future', () => {
  assert.equal(monthsElapsed('2027-01-01', '2026-08-01'), 0);
});

test('projectOutstandingBalance: zero months elapsed returns the full principal untouched', () => {
  const result = projectOutstandingBalance({ principal: 1000000, annualRatePercent: 8.5, emiAmount: 30000, monthsElapsed: 0, tenureMonths: 60 });
  assert.equal(result.outstandingBalance, 1000000);
  assert.equal(result.monthsRemaining, 60);
  assert.equal(result.emiCoversInterest, true);
});

test('projectOutstandingBalance: an EMI too small to cover interest is flagged, principal unchanged', () => {
  // 1,000,000 at 12%/yr -> 1%/mo -> min viable EMI is 10,000/mo. 5,000 can never amortize this.
  const result = projectOutstandingBalance({ principal: 1000000, annualRatePercent: 12, emiAmount: 5000, monthsElapsed: 24, tenureMonths: 60 });
  assert.equal(result.emiCoversInterest, false);
  assert.equal(result.outstandingBalance, 1000000);
  assert.equal(result.monthsRemaining, null);
});

test('projectOutstandingBalance: a correctly-computed EMI fully amortizes the loan by the end of its tenure', () => {
  // Standard EMI formula for P=1,000,000, 12%/yr (1%/mo), n=12: EMI ≈ 88,849.
  const principal = 1000000;
  const annualRatePercent = 12;
  const monthlyRate = 0.01;
  const n = 12;
  const emi = principal * monthlyRate * Math.pow(1 + monthlyRate, n) / (Math.pow(1 + monthlyRate, n) - 1);

  const result = projectOutstandingBalance({ principal, annualRatePercent, emiAmount: emi, monthsElapsed: n, tenureMonths: n });
  assert.equal(result.monthsRemaining, 0);
  assert.ok(result.outstandingBalance <= 5, `expected near-zero balance, got ${result.outstandingBalance}`);
});

test('projectOutstandingBalance: halfway through a correctly-computed loan, roughly half the balance remains reduced but not linearly (front-loaded interest)', () => {
  const principal = 1000000;
  const annualRatePercent = 12;
  const monthlyRate = 0.01;
  const n = 12;
  const emi = principal * monthlyRate * Math.pow(1 + monthlyRate, n) / (Math.pow(1 + monthlyRate, n) - 1);

  const result = projectOutstandingBalance({ principal, annualRatePercent, emiAmount: emi, monthsElapsed: 6, tenureMonths: n });
  // Reducing-balance amortization is front-loaded on interest, so after
  // exactly half the tenure, MORE than half the principal should remain --
  // never less (that would indicate a linear-amortization bug).
  assert.ok(result.outstandingBalance > principal / 2, `expected >50% remaining at halfway, got ${result.outstandingBalance}`);
  assert.equal(result.monthsRemaining, 6);
});

test('projectOutstandingBalance: elapsed months beyond the tenure caps the amortization run at tenureMonths, not longer', () => {
  const principal = 1000000;
  const annualRatePercent = 12;
  const monthlyRate = 0.01;
  const n = 12;
  const emi = principal * monthlyRate * Math.pow(1 + monthlyRate, n) / (Math.pow(1 + monthlyRate, n) - 1);

  const result = projectOutstandingBalance({ principal, annualRatePercent, emiAmount: emi, monthsElapsed: 36, tenureMonths: n });
  assert.equal(result.monthsRemaining, 0);
  assert.ok(result.outstandingBalance <= 5);
});
