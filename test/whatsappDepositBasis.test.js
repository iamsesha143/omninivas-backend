// Unit tests for applyDepositBasisSafetyNet (whatsappFactResolution.js) --
// the fix for a WhatsApp deposit clause stated as a multiple of rent
// ("Deposit: 4 months") being misread downstream as a ₹4 deposit. Pure
// function, no mocking needed.
//
// Run with: node --test test/whatsappDepositBasis.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyDepositBasisSafetyNet, applyDepositFirstSafetyNet, applyRepairOffsetSafetyNet } = require('../whatsappFactResolution');

test('applyDepositBasisSafetyNet: "Deposit: 4 months" (category already deposit) structures as basis_value/basis_unit, never a rupee amount', () => {
  const fact = { category: 'deposit', fact_type: null, value: '4 months', evidence: 'Deposit: 4 months' };
  const out = applyDepositBasisSafetyNet(fact);
  assert.equal(out.owner_corrected_category, 'deposit');
  assert.equal(out.owner_corrected_fact_type, 'deposit_basis');
  assert.equal(out.basis_value, 4);
  assert.equal(out.basis_unit, 'months');
  assert.equal(out.value, '4 months', 'original free-text value is preserved, never collapsed to a bare number');
});

test('applyDepositBasisSafetyNet: months-basis phrasing wins even when the AI mis-categorized it as "payment"', () => {
  const raw = { category: 'payment', fact_type: null, value: 'Deposit: 4 months', evidence: 'Deposit: 4 months' };
  // Simulates the real safety-net chain order used in server.js: basis runs
  // last, so it overrides applyDepositFirstSafetyNet's generic 'deposit_paid'
  // default for the same message.
  const afterFirst = applyDepositFirstSafetyNet(raw);
  assert.equal(afterFirst.owner_corrected_fact_type, 'deposit_paid', 'sanity: the generic net alone would have wrongly defaulted to deposit_paid');
  const out = applyDepositBasisSafetyNet(afterFirst);
  assert.equal(out.owner_corrected_category, 'deposit');
  assert.equal(out.owner_corrected_fact_type, 'deposit_basis', 'basis phrasing overrides the generic deposit_paid default');
  assert.equal(out.basis_value, 4);
});

test('applyDepositBasisSafetyNet: a genuine rupee deposit amount is left untouched (no "months" phrasing present)', () => {
  const fact = { category: 'deposit', fact_type: null, value: '₹1,52,000', evidence: 'Deposit: Rs 1,52,000 by transfer' };
  const out = applyDepositBasisSafetyNet(fact);
  assert.equal(out, fact, 'no months phrasing -> fact returned unchanged, no basis fields added');
  assert.equal(out.basis_value, undefined);
});

test('applyDepositBasisSafetyNet: a "months" mention with no "deposit" wording at all is never touched (e.g. a lease-term clause)', () => {
  const fact = { category: 'date_milestone', fact_type: null, value: '11 months', evidence: 'Tenure of agreement: 11 months' };
  const out = applyDepositBasisSafetyNet(fact);
  assert.equal(out, fact);
});

test('applyDepositBasisSafetyNet: non-payment/non-deposit categories are never touched even if they happen to mention both words', () => {
  const fact = { category: 'maintenance', fact_type: null, value: 'deposit 4 months worth of paint charges', evidence: 'x' };
  const out = applyDepositBasisSafetyNet(fact);
  assert.equal(out, fact);
});

test('applyDepositBasisSafetyNet: does not interfere with applyRepairOffsetSafetyNet for an unrelated maintenance fact', () => {
  const fact = { category: 'maintenance', fact_type: null, value: 'deduct from rent', evidence: 'deduct from rent for the repair' };
  const afterRepair = applyRepairOffsetSafetyNet(fact);
  const out = applyDepositBasisSafetyNet(afterRepair);
  assert.equal(out.owner_corrected_fact_type, 'repair_rent_offset', 'basis net is a no-op here -- category is maintenance, not deposit/payment');
});
