// Tests for the WhatsApp Resolution Foundation slice:
//   - whatsappFactResolution.js: deposit-first / repair-offset safety nets,
//     effective-value resolution (direct unit tests, no DB/AI gateway needed).
//   - PATCH /api/whatsapp/facts/:id: new correction fields, validation, the
//     already-applied lock.
//   - GET /api/whatsapp/facts/:id/apply-context: effective property
//     resolution (fact-level override vs. import-level fallback).
// Same mocked-Supabase harness as the other route test files -- no real
// database or AI gateway touched (the gateway is never configured in this
// test environment, which is exactly why the safety-net functions are
// tested directly below rather than only through the full import route).
//
// Run with: node --test test/whatsappResolutionRoutes.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createMockSupabase } = require('./supabaseMock');
const {
  applyDepositFirstSafetyNet, applyRepairOffsetSafetyNet, effectiveFactCategory, effectiveFactType, withEffectiveFields
} = require('../whatsappFactResolution');

// ---- Direct unit tests: no server, no mock DB ----

test('applyDepositFirstSafetyNet: explicit "deposit" wording in a payment-category fact is flagged, original untouched', () => {
  const fact = { category: 'payment', fact_type: 'rent_payment', value: 'Rs. 1.52 Lacs deposit', evidence: 'Rs. 1.52 Lacs deposit sent' };
  const result = applyDepositFirstSafetyNet(fact);
  assert.equal(result.category, 'payment', 'original category is never rewritten');
  assert.equal(result.fact_type, 'rent_payment', 'original fact_type is never rewritten');
  assert.equal(result.owner_corrected_category, 'deposit');
  assert.equal(result.owner_corrected_fact_type, 'deposit_paid');
});

test('applyDepositFirstSafetyNet: "deposit refund" wording maps to deposit_refund', () => {
  const result = applyDepositFirstSafetyNet({ category: 'payment', value: 'deposit refund of 50000 sent back', evidence: '' });
  assert.equal(result.owner_corrected_fact_type, 'deposit_refund');
});

test('applyDepositFirstSafetyNet: "deposit agreed" wording maps to deposit_agreed', () => {
  const result = applyDepositFirstSafetyNet({ category: 'payment', value: 'we agree deposit will be 150000', evidence: '' });
  assert.equal(result.owner_corrected_fact_type, 'deposit_agreed');
});

test('applyDepositFirstSafetyNet: no "deposit" wording -> untouched, no correction added', () => {
  const fact = { category: 'payment', fact_type: 'rent_payment', value: 'Rent 41000 paid', evidence: 'Rent 41000 paid' };
  const result = applyDepositFirstSafetyNet(fact);
  assert.equal(result.owner_corrected_category, undefined);
  assert.equal(result.owner_corrected_fact_type, undefined);
});

test('applyDepositFirstSafetyNet: non-payment category is never touched, even if it mentions "deposit"', () => {
  const fact = { category: 'maintenance', value: 'deposit box lock is broken', evidence: '' };
  const result = applyDepositFirstSafetyNet(fact);
  assert.equal(result.owner_corrected_category, undefined);
});

test('applyRepairOffsetSafetyNet: "deduct from rent" repair wording gets the distinct fact_type', () => {
  const fact = { category: 'maintenance', fact_type: 'issue_reported', value: 'plumber cost 5000, deduct from rent', evidence: 'please deduct from rent' };
  const result = applyRepairOffsetSafetyNet(fact);
  assert.equal(result.fact_type, 'issue_reported', 'original fact_type is never rewritten');
  assert.equal(result.owner_corrected_fact_type, 'repair_rent_offset');
});

test('applyRepairOffsetSafetyNet: "adjust against rent" wording also triggers', () => {
  const result = applyRepairOffsetSafetyNet({ category: 'maintenance', value: 'adjust against rent please', evidence: '' });
  assert.equal(result.owner_corrected_fact_type, 'repair_rent_offset');
});

test('applyRepairOffsetSafetyNet: ordinary repair mention without offset wording is untouched', () => {
  const result = applyRepairOffsetSafetyNet({ category: 'maintenance', value: 'geyser is leaking', evidence: '' });
  assert.equal(result.owner_corrected_fact_type, undefined);
});

test('applyRepairOffsetSafetyNet: non-maintenance category is never touched', () => {
  const result = applyRepairOffsetSafetyNet({ category: 'payment', value: 'deduct from rent', evidence: '' });
  assert.equal(result.owner_corrected_fact_type, undefined);
});

test('effective value resolution: correction wins when present', () => {
  const fact = { category: 'payment', fact_type: 'rent_payment', owner_corrected_category: 'deposit', owner_corrected_fact_type: 'deposit_paid' };
  assert.equal(effectiveFactCategory(fact), 'deposit');
  assert.equal(effectiveFactType(fact), 'deposit_paid');
});

test('effective value resolution: falls back to original when no correction exists (legacy row, pre-migration shape)', () => {
  // Simulates an existing row from before this migration -- no
  // owner_corrected_* columns present at all, not even as null.
  const legacyFact = { category: 'payment', fact_type: 'rent_payment' };
  assert.equal(effectiveFactCategory(legacyFact), 'payment');
  assert.equal(effectiveFactType(legacyFact), 'rent_payment');
  const withEffective = withEffectiveFields(legacyFact);
  assert.equal(withEffective.effective_category, 'payment');
  assert.equal(withEffective.effective_fact_type, 'rent_payment');
});

// ---- Route-level tests ----

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
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// PATCH /api/whatsapp/facts/:id

test('PATCH fact: valid owner_corrected_category/fact_type/participant_role are accepted and effective_* reflects them', async () => {
  mockDb.__queue('whatsapp_extracted_facts', { data: { id: 'f-1', applied_at: null }, error: null }); // ownership+applied_at check
  mockDb.__queue('whatsapp_extracted_facts', { data: [{ id: 'f-1', category: 'payment', fact_type: 'rent_payment', owner_corrected_category: 'deposit', owner_corrected_fact_type: 'deposit_paid', participant_role: 'tenant' }], error: null }); // update

  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { owner_corrected_category: 'deposit', owner_corrected_fact_type: 'deposit_paid', participant_role: 'tenant' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.effective_category, 'deposit');
  assert.equal(res.body.effective_fact_type, 'deposit_paid');
});

test('PATCH fact: invalid owner_corrected_category is rejected', async () => {
  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { owner_corrected_category: 'not_a_real_category' } });
  assert.equal(res.status, 400);
});

test('PATCH fact: invalid owner_corrected_fact_type is rejected', async () => {
  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { owner_corrected_fact_type: 'made_up_type' } });
  assert.equal(res.status, 400);
});

test('PATCH fact: invalid participant_role is rejected', async () => {
  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { participant_role: 'landlord_assistant' } });
  assert.equal(res.status, 400);
});

test('PATCH fact: a valid participant_role from the fixed enum is accepted for each value', async () => {
  for (const role of ['tenant', 'owner', 'vendor', 'broker', 'other', 'unknown']) {
    mockDb.__queue('whatsapp_extracted_facts', { data: { id: 'f-1', applied_at: null }, error: null });
    mockDb.__queue('whatsapp_extracted_facts', { data: [{ id: 'f-1', category: 'person', fact_type: null, participant_role: role }], error: null });
    const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { participant_role: role } });
    assert.equal(res.status, 200, `role ${role} should be accepted`);
  }
});

test('PATCH fact: a property_id belonging to the owner is accepted', async () => {
  mockDb.__queue('whatsapp_extracted_facts', { data: { id: 'f-1', applied_at: null }, error: null });
  mockDb.__queue('properties', { data: { id: 'prop-mine' }, error: null }); // property ownership check
  mockDb.__queue('whatsapp_extracted_facts', { data: [{ id: 'f-1', category: 'property_reference', property_id: 'prop-mine' }], error: null });

  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { property_id: 'prop-mine' } });
  assert.equal(res.status, 200);
});

test('PATCH fact: a property_id NOT belonging to the owner (or nonexistent) is rejected before any write', async () => {
  mockDb.__queue('whatsapp_extracted_facts', { data: { id: 'f-1', applied_at: null }, error: null });
  mockDb.__queue('properties', { data: null, error: null }); // not found / not owned -> maybeSingle returns null

  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { property_id: 'not-mine' } });
  assert.equal(res.status, 400);
});

test('PATCH fact: property_id can be explicitly cleared with null', async () => {
  mockDb.__queue('whatsapp_extracted_facts', { data: { id: 'f-1', applied_at: null }, error: null });
  mockDb.__queue('whatsapp_extracted_facts', { data: [{ id: 'f-1', category: 'property_reference', property_id: null }], error: null });

  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { property_id: null } });
  assert.equal(res.status, 200);
  assert.equal(res.body.property_id, null);
});

test('PATCH fact: unauthorized / cross-owner fact access is a 404 before any validation runs', async () => {
  mockDb.__queue('whatsapp_extracted_facts', { data: null, error: null }); // ownership check finds nothing for this user
  const res = await api('PATCH', '/api/whatsapp/facts/not-mine', { token: ownerToken, body: { participant_role: 'tenant' } });
  assert.equal(res.status, 404);
});

test('PATCH fact: correcting an already-applied fact is rejected', async () => {
  mockDb.__queue('whatsapp_extracted_facts', { data: { id: 'f-1', applied_at: '2026-08-01T00:00:00Z' }, error: null });
  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { participant_role: 'tenant' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already been applied/);
});

test('PATCH fact: status/owner_edited_value on an already-applied fact are unaffected by the new correction lock (unchanged pre-existing behavior)', async () => {
  mockDb.__queue('whatsapp_extracted_facts', { data: { id: 'f-1', applied_at: '2026-08-01T00:00:00Z' }, error: null });
  mockDb.__queue('whatsapp_extracted_facts', { data: [{ id: 'f-1', category: 'payment', fact_type: 'rent_payment', status: 'edited' }], error: null });
  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { token: ownerToken, body: { status: 'edited' } });
  assert.equal(res.status, 200, 'status changes alone are not blocked by the applied-fact correction lock');
});

test('PATCH fact: no token is a 401', async () => {
  const res = await api('PATCH', '/api/whatsapp/facts/f-1', { body: { participant_role: 'tenant' } });
  assert.equal(res.status, 401);
});

// GET /api/whatsapp/facts/:id/apply-context

test('apply-context: fact-level property_id (when present) overrides the import-level property', async () => {
  mockDb.__queue('whatsapp_extracted_facts', {
    data: { id: 'f-1', property_id: 'prop-fact-level', whatsapp_imports: { user_id: 'owner-1', property_id: 'prop-import-level' } },
    error: null
  });
  mockDb.__queue('properties', { data: { id: 'prop-fact-level', property_name: 'Fact-level property' }, error: null });
  mockDb.__queue('tenants', { data: [], error: null });
  mockDb.__queue('obligations', { data: [], error: null });

  const res = await api('GET', '/api/whatsapp/facts/f-1/apply-context', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.property.id, 'prop-fact-level', 'the fact-level override was used, not the import-level property');
});

test('apply-context: import-level property is used when fact-level property_id is absent (unchanged fallback behavior)', async () => {
  mockDb.__queue('whatsapp_extracted_facts', {
    data: { id: 'f-1', property_id: null, whatsapp_imports: { user_id: 'owner-1', property_id: 'prop-import-level' } },
    error: null
  });
  mockDb.__queue('properties', { data: { id: 'prop-import-level', property_name: 'Import-level property' }, error: null });
  mockDb.__queue('tenants', { data: [], error: null });
  mockDb.__queue('obligations', { data: [], error: null });

  const res = await api('GET', '/api/whatsapp/facts/f-1/apply-context', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.property.id, 'prop-import-level');
});

test('apply-context: neither fact-level nor import-level property -> stays unlinked (property null, no tenants/obligations queried)', async () => {
  mockDb.__queue('whatsapp_extracted_facts', {
    data: { id: 'f-1', property_id: null, whatsapp_imports: { user_id: 'owner-1', property_id: null } },
    error: null
  });
  const res = await api('GET', '/api/whatsapp/facts/f-1/apply-context', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.property, null);
  assert.deepEqual(res.body.tenants, []);
});

test('apply-context: response includes effective_category/effective_fact_type for the frontend to route on', async () => {
  mockDb.__queue('whatsapp_extracted_facts', {
    data: { id: 'f-1', category: 'payment', fact_type: 'rent_payment', owner_corrected_category: 'deposit', owner_corrected_fact_type: 'deposit_paid', property_id: null, whatsapp_imports: { user_id: 'owner-1', property_id: null } },
    error: null
  });
  const res = await api('GET', '/api/whatsapp/facts/f-1/apply-context', { token: ownerToken });
  assert.equal(res.body.fact.effective_category, 'deposit');
  assert.equal(res.body.fact.effective_fact_type, 'deposit_paid');
  assert.equal(res.body.fact.category, 'payment', 'original extraction is still visible on the returned fact');
});

test('apply-context: unauthorized fact access is a 404', async () => {
  mockDb.__queue('whatsapp_extracted_facts', { data: null, error: null });
  const res = await api('GET', '/api/whatsapp/facts/not-mine/apply-context', { token: ownerToken });
  assert.equal(res.status, 404);
});
