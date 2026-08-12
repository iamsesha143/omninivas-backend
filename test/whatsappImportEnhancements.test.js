// Route-level tests for the association/timestamp/deposit-canonicalization
// fix: property-context inheritance at import time, retroactive backfill on
// attach, owner_name for the owner-suggestion feature, source message
// timestamp in apply-context, and the deposit provenance/discrepancy guard.
// Same mocked-Supabase harness as the other route test files; llm.js is
// ALSO mocked here (require.cache override, same technique) so the
// candidate-fact-building code path (normally skipped in every test/CI
// environment because no AI gateway key is configured) actually runs.
//
// Run with: node --test test/whatsappImportEnhancements.test.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createMockSupabase } = require('./supabaseMock');

const llmPath = require.resolve('../llm');
let mockFacts = [];
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true,
  exports: {
    extractWhatsAppFacts: async () => ({ skipped: false, facts: mockFacts }),
    WHATSAPP_CATEGORIES: ['person', 'property_reference', 'payment', 'deposit', 'date_milestone', 'maintenance', 'vendor', 'commitment', 'document_reference', 'utility_cost', 'guardian_contact'],
    WHATSAPP_FACT_TYPES: ['rent_payment', 'rent_due', 'deposit_paid', 'deposit_agreed', 'deposit_refund', 'deposit_basis', 'issue_reported', 'repair_completed', 'repair_rent_offset', 'electricity_cost', 'water_cost', 'other_utility_cost']
  }
};

const supabasePath = require.resolve('@supabase/supabase-js');
const mockDb = createMockSupabase();
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: { createClient: () => mockDb }
};

const app = require('../server');

let server;
let baseUrl;
let ownerToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  ownerToken = jwt.sign({ sub: 'owner-1', role: 'owner' }, process.env.JWT_SECRET);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockDb.__reset();
  mockFacts = [];
});

async function uploadImport({ propertyId, text } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([text || '01/07/2025, 10:00 AM - Shankar Abhinav: Deposit: 4 months'], { type: 'text/plain' }), 'chat.txt');
  if (propertyId) fd.append('property_id', propertyId);
  const res = await fetch(`${baseUrl}/api/whatsapp/import`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: fd });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// ---- Property-context inheritance at import time ----

test('POST /api/whatsapp/import: every extracted fact inherits the selected import property_id by default', async () => {
  mockFacts = [{ category: 'deposit', fact_type: null, value: '4 months', confidence: 0.9, evidence: 'Deposit: 4 months', message_seq: 0 }];
  mockDb.__queue('properties', { data: { id: 'prop-512' }, error: null }); // ownership check
  mockDb.__queue('whatsapp_imports', { data: { id: 'import-1', property_id: 'prop-512' }, error: null }); // insert
  mockDb.__queue('whatsapp_messages', { data: null, error: null }); // insert rows
  mockDb.__queue('whatsapp_imports', { data: null, error: null }); // status='parsed' update
  mockDb.__queue('whatsapp_imports', { data: [], error: null }); // prior-imports select (none)
  mockDb.__queue('whatsapp_extracted_facts', { data: null, error: null }); // insert candidateFacts
  mockDb.__queue('whatsapp_imports', { data: { id: 'import-1', status: 'extracted' }, error: null }); // final status update

  const res = await uploadImport({ propertyId: 'prop-512' });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('whatsapp_extracted_facts')[0];
  assert.equal(inserted[0].property_id, 'prop-512', 'the fact starts already linked to the import property, not unlinked');
});

test('POST /api/whatsapp/import: no property selected at upload -> facts stay unlinked (nothing to inherit, not a bug)', async () => {
  mockFacts = [{ category: 'deposit', fact_type: null, value: '4 months', confidence: 0.9, evidence: 'Deposit: 4 months', message_seq: 0 }];
  mockDb.__queue('whatsapp_imports', { data: { id: 'import-2', property_id: null }, error: null });
  mockDb.__queue('whatsapp_messages', { data: null, error: null });
  mockDb.__queue('whatsapp_imports', { data: null, error: null });
  mockDb.__queue('whatsapp_extracted_facts', { data: null, error: null });
  mockDb.__queue('whatsapp_imports', { data: { id: 'import-2', status: 'extracted' }, error: null });

  const res = await uploadImport({});
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('whatsapp_extracted_facts')[0];
  assert.equal(inserted[0].property_id, null);
});

test('POST /api/whatsapp/import: the deposit-basis safety net fires through the real route (not just in isolation)', async () => {
  mockFacts = [{ category: 'deposit', fact_type: null, value: '4 months', confidence: 0.9, evidence: 'Deposit: 4 months', message_seq: 0 }];
  mockDb.__queue('properties', { data: { id: 'prop-512' }, error: null });
  mockDb.__queue('whatsapp_imports', { data: { id: 'import-3', property_id: 'prop-512' }, error: null });
  mockDb.__queue('whatsapp_messages', { data: null, error: null });
  mockDb.__queue('whatsapp_imports', { data: null, error: null });
  mockDb.__queue('whatsapp_imports', { data: [], error: null });
  mockDb.__queue('whatsapp_extracted_facts', { data: null, error: null });
  mockDb.__queue('whatsapp_imports', { data: { id: 'import-3', status: 'extracted' }, error: null });

  const res = await uploadImport({ propertyId: 'prop-512' });
  assert.equal(res.status, 201);
  const inserted = mockDb.__inserts('whatsapp_extracted_facts')[0][0];
  assert.equal(inserted.owner_corrected_fact_type, 'deposit_basis');
  assert.equal(inserted.basis_value, 4);
  assert.equal(inserted.basis_unit, 'months');
});

// ---- Retroactive backfill on attach ----

test('PATCH /api/whatsapp/imports/:id: attaching a property backfills it onto facts that have no property_id yet', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-512' }, error: null }); // ownership check
  mockDb.__queue('whatsapp_imports', { data: [{ id: 'import-4', property_id: 'prop-512' }], error: null }); // update().select()
  mockDb.__queue('whatsapp_extracted_facts', { data: null, error: null }); // backfill update

  const res = await fetch(`${baseUrl}/api/whatsapp/imports/import-4`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: 'prop-512' })
  });
  assert.equal(res.status, 200);
  const update = mockDb.__updates('whatsapp_extracted_facts')[0];
  assert.equal(update.property_id, 'prop-512', 'the backfill update was issued against still-null facts on this import');
});

test('PATCH /api/whatsapp/imports/:id: detaching a property (null) does not attempt a backfill', async () => {
  mockDb.__queue('whatsapp_imports', { data: [{ id: 'import-5', property_id: null }], error: null });
  const res = await fetch(`${baseUrl}/api/whatsapp/imports/import-5`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: null })
  });
  assert.equal(res.status, 200);
  assert.equal(mockDb.__updates('whatsapp_extracted_facts').length, 0);
});

// ---- owner_name for the owner-suggestion feature ----

test('GET /api/whatsapp/imports/:id: response includes owner_name from the logged-in owner\'s own profile', async () => {
  mockDb.__queue('whatsapp_imports', { data: { id: 'import-6', property_id: 'prop-512' }, error: null });
  mockDb.__queue('whatsapp_messages', { data: [], error: null });
  mockDb.__queue('whatsapp_extracted_facts', { data: [], error: null });
  mockDb.__queue('users', { data: { full_name: 'Sesha Bhojanapalli' }, error: null });

  const res = await fetch(`${baseUrl}/api/whatsapp/imports/import-6`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.owner_name, 'Sesha Bhojanapalli');
});

// ---- source message timestamp in apply-context ----

test('GET /api/whatsapp/facts/:id/apply-context: includes message_ts resolved from the fact\'s own source message, not import/row time', async () => {
  mockDb.__queue('whatsapp_extracted_facts', {
    data: { id: 'fact-1', import_id: 'import-7', message_seq: 3, property_id: null, whatsapp_imports: { user_id: 'owner-1', property_id: null } },
    error: null
  });
  mockDb.__queue('whatsapp_messages', { data: { ts: '01/07/2025, 10:00 AM' }, error: null });

  const res = await fetch(`${baseUrl}/api/whatsapp/facts/fact-1/apply-context`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.message_ts, '01/07/2025, 10:00 AM');
});

test('GET /api/whatsapp/facts/:id/apply-context: message_ts is null (not fabricated) when message_seq is absent', async () => {
  mockDb.__queue('whatsapp_extracted_facts', {
    data: { id: 'fact-2', import_id: 'import-7', message_seq: null, property_id: null, whatsapp_imports: { user_id: 'owner-1', property_id: null } },
    error: null
  });
  const res = await fetch(`${baseUrl}/api/whatsapp/facts/fact-2/apply-context`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.message_ts, null, 'never substituted with fact.created_at or any other import/workflow timestamp');
});

// ---- Deposit provenance / discrepancy guard ----

test('PATCH /api/properties/:id/deposit: a WhatsApp-sourced figure differing from an existing agreement-sourced total is blocked as a discrepancy, not silently applied', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-512', deposit_suggested_total: null, deposit_total: 152000, deposit_source: 'agreement' }, error: null });

  const res = await fetch(`${baseUrl}/api/properties/prop-512/deposit`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deposit_total: 160000, source: 'whatsapp' })
  });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error, 'discrepancy');
  assert.equal(body.current_total, 152000);
  assert.equal(body.current_source, 'agreement');
  assert.equal(body.incoming_total, 160000);
});

test('PATCH /api/properties/:id/deposit: confirm_override lets the owner explicitly proceed anyway', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-512', deposit_suggested_total: null, deposit_total: 152000, deposit_source: 'agreement' }, error: null });
  mockDb.__queue('properties', { data: { id: 'prop-512', deposit_total: 160000, deposit_source: 'whatsapp' }, error: null }); // the actual update
  mockDb.__queue('tenants', { data: [], error: null }); // legacy fallback split (no tenant_ids sent)

  const res = await fetch(`${baseUrl}/api/properties/prop-512/deposit`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deposit_total: 160000, source: 'whatsapp', confirm_override: true })
  });
  assert.equal(res.status, 200);
});

test('PATCH /api/properties/:id/deposit: a WhatsApp figure matching the existing agreement total is not a discrepancy (nothing actually conflicts)', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-512', deposit_suggested_total: null, deposit_total: 152000, deposit_source: 'agreement' }, error: null });
  mockDb.__queue('properties', { data: { id: 'prop-512', deposit_total: 152000, deposit_source: 'whatsapp' }, error: null });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await fetch(`${baseUrl}/api/properties/prop-512/deposit`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deposit_total: 152000, source: 'whatsapp' })
  });
  assert.equal(res.status, 200);
});

test('PATCH /api/properties/:id/deposit: a WhatsApp figure is not blocked when the existing source is manual (only agreement is protected)', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-512', deposit_suggested_total: null, deposit_total: 100000, deposit_source: 'manual' }, error: null });
  mockDb.__queue('properties', { data: { id: 'prop-512', deposit_total: 160000, deposit_source: 'whatsapp' }, error: null });
  mockDb.__queue('tenants', { data: [], error: null });

  const res = await fetch(`${baseUrl}/api/properties/prop-512/deposit`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deposit_total: 160000, source: 'whatsapp' })
  });
  assert.equal(res.status, 200);
});

// ---- tenants deposit sanity check (the previously-unvalidated passthrough) ----

test('PATCH /api/tenants/:id: an implausible deposit_amount (e.g. a misread "4") is rejected, never silently saved', async () => {
  const res = await fetch(`${baseUrl}/api/tenants/tenant-1`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deposit_amount: 4 })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /deposit_amount/);
});

test('PATCH /api/tenants/:id: a plausible deposit_amount is accepted', async () => {
  mockDb.__queue('tenants', { data: [{ id: 'tenant-1', deposit_amount: 38000 }], error: null });
  const res = await fetch(`${baseUrl}/api/tenants/tenant-1`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deposit_amount: 38000 })
  });
  assert.equal(res.status, 200);
});

test('PATCH /api/tenants/:id: clearing deposit_amount (blank) still works, unaffected by the new sanity check', async () => {
  mockDb.__queue('tenants', { data: [{ id: 'tenant-1', deposit_amount: null }], error: null });
  const res = await fetch(`${baseUrl}/api/tenants/tenant-1`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deposit_amount: null })
  });
  assert.equal(res.status, 200);
});
