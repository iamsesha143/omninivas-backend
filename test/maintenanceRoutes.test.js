// Mocked route/integration tests for the migration-014 maintenance/equipment/
// vendor/rent-credit API slice. No real Supabase, Storage, or database is
// touched anywhere in this file -- @supabase/supabase-js is replaced in the
// require cache with a fake client (test/supabaseMock.js) before server.js
// is required, so every supabase.from(...) call in the routes resolves to a
// pre-queued response instead of hitting the network.
//
// Run with: node --test test/maintenanceRoutes.test.js
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
let ownerToken, otherOwnerToken, tenantToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  const secret = process.env.JWT_SECRET;
  ownerToken = jwt.sign({ sub: 'owner-1', role: 'owner' }, secret);
  otherOwnerToken = jwt.sign({ sub: 'owner-2', role: 'owner' }, secret);
  tenantToken = jwt.sign({ sub: 'tenant-user-1', role: 'tenant' }, secret);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockDb.__reset();
});

async function api(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const nowIso = () => new Date().toISOString();

// Real magic bytes so evidence-upload tests exercise the actual signature
// validation in maintenanceWorkflow.js, not just the claimed MIME type.
const JPEG_BYTES = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);

// ---- POST /api/properties/:propertyId/maintenance ----

test('POST property maintenance: happy path creates a resolved-by-default owner entry', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-1' }, error: null });
  mockDb.__queue('maintenance_costs', { data: [{ id: 'mc-1', description: 'Fixed tap', request_status: 'resolved' }], error: null });
  const res = await api('POST', '/api/properties/prop-1/maintenance', {
    token: ownerToken,
    body: { description: 'Fixed tap', amount: 500, paid_by: 'owner' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'mc-1');
});

test('POST property maintenance: missing description is a 400', async () => {
  const res = await api('POST', '/api/properties/prop-1/maintenance', {
    token: ownerToken,
    body: { amount: 500, paid_by: 'owner' }
  });
  assert.equal(res.status, 400);
});

test('POST property maintenance: property not owned by caller is a 404', async () => {
  mockDb.__queue('properties', { data: null, error: null });
  const res = await api('POST', '/api/properties/prop-1/maintenance', {
    token: ownerToken,
    body: { description: 'Fixed tap', paid_by: 'owner' }
  });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Not found' });
});

test('POST property maintenance: tenant role is forbidden', async () => {
  const res = await api('POST', '/api/properties/prop-1/maintenance', {
    token: tenantToken,
    body: { description: 'Fixed tap', paid_by: 'owner' }
  });
  assert.equal(res.status, 403);
});

// ---- GET /api/properties/:propertyId/maintenance ----

test('GET property maintenance: lists rows for the property', async () => {
  mockDb.__queue('maintenance_costs', { data: [{ id: 'mc-1' }, { id: 'mc-2' }], error: null });
  const res = await api('GET', '/api/properties/prop-1/maintenance', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

// ---- PATCH /api/properties/:propertyId/maintenance/:maintenanceId ----

test('PATCH property maintenance: legal transition reported -> approved succeeds', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', request_status: 'reported' }, error: null });
  mockDb.__queue('maintenance_costs', { data: [{ id: 'mc-1', request_status: 'approved' }], error: null });
  const res = await api('PATCH', '/api/properties/prop-1/maintenance/mc-1', {
    token: ownerToken,
    body: { request_status: 'approved' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.request_status, 'approved');
});

test('PATCH property maintenance: terminal record is fully locked', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', request_status: 'resolved' }, error: null });
  const res = await api('PATCH', '/api/properties/prop-1/maintenance/mc-1', {
    token: ownerToken,
    body: { amount: 999 }
  });
  assert.equal(res.status, 400);
});

test('PATCH property maintenance: illegal transition is rejected', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', request_status: 'reported' }, error: null });
  const res = await api('PATCH', '/api/properties/prop-1/maintenance/mc-1', {
    token: ownerToken,
    body: { request_status: 'resolved' }
  });
  assert.equal(res.status, 400);
});

test('PATCH property maintenance: stale concurrent update is a safe 409, not a silent overwrite', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', request_status: 'reported' }, error: null });
  // The conditional UPDATE (.eq('request_status', 'reported')) matched zero
  // rows -- another request already changed the status between our read and
  // our write.
  mockDb.__queue('maintenance_costs', { data: [], error: null });
  const res = await api('PATCH', '/api/properties/prop-1/maintenance/mc-1', {
    token: ownerToken,
    body: { request_status: 'approved' }
  });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'This maintenance request was already updated. Refresh and try again.' });
});

test('PATCH property maintenance: cross-owner lookup is a hidden 404', async () => {
  mockDb.__queue('maintenance_costs', { data: null, error: null });
  const res = await api('PATCH', '/api/properties/prop-1/maintenance/mc-1', {
    token: otherOwnerToken,
    body: { request_status: 'approved' }
  });
  assert.equal(res.status, 404);
});

// ---- POST /api/maintenance/:id/settlement ----

test('POST settlement: happy path rent_credit', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', property_id: 'prop-1', tenant_id: 't-1', paid_by: 'tenant', amount: 800 }, error: null });
  mockDb.__queue('rent_credits', { data: [{ id: 'rc-1', type: 'rent_credit', status: 'pending' }], error: null });
  const res = await api('POST', '/api/maintenance/mc-1/settlement', {
    token: ownerToken,
    body: { type: 'rent_credit', amount: 800, applicable_period: '2026-08' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending');
});

test('POST settlement: only tenant-paid expenses can be settled', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', property_id: 'prop-1', tenant_id: 't-1', paid_by: 'owner', amount: 800 }, error: null });
  const res = await api('POST', '/api/maintenance/mc-1/settlement', {
    token: ownerToken,
    body: { type: 'reimbursement', amount: 800 }
  });
  assert.equal(res.status, 400);
});

test('POST settlement: rent_credit requires applicable_period', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', property_id: 'prop-1', tenant_id: 't-1', paid_by: 'tenant', amount: 800 }, error: null });
  const res = await api('POST', '/api/maintenance/mc-1/settlement', {
    token: ownerToken,
    body: { type: 'rent_credit', amount: 800 }
  });
  assert.equal(res.status, 400);
});

test('POST settlement: active-settlement conflict maps 23505 to a friendly 409', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', property_id: 'prop-1', tenant_id: 't-1', paid_by: 'tenant', amount: 800 }, error: null });
  mockDb.__queue('rent_credits', { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_rent_credits_active_per_maintenance"' } });
  const res = await api('POST', '/api/maintenance/mc-1/settlement', {
    token: ownerToken,
    body: { type: 'reimbursement', amount: 800 }
  });
  assert.equal(res.status, 409);
  assert.doesNotMatch(res.body.error, /constraint|uq_rent_credits/i);
});

test('POST settlement: nonexistent maintenance record is a 404', async () => {
  mockDb.__queue('maintenance_costs', { data: null, error: null });
  const res = await api('POST', '/api/maintenance/mc-404/settlement', {
    token: ownerToken,
    body: { type: 'reimbursement', amount: 800 }
  });
  assert.equal(res.status, 404);
});

test('POST settlement: rent_credit on a maintenance record with no linked tenant is rejected before any insert', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', property_id: 'prop-1', tenant_id: null, paid_by: 'tenant', amount: 800 }, error: null });
  const res = await api('POST', '/api/maintenance/mc-1/settlement', {
    token: ownerToken,
    body: { type: 'rent_credit', amount: 800, applicable_period: '2026-08' }
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'A rent credit requires a maintenance record linked to a tenant.' });
  assert.equal(mockDb.__inserts('rent_credits').length, 0);
});

test('POST settlement: reimbursement on a maintenance record with no linked tenant is unaffected', async () => {
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', property_id: 'prop-1', tenant_id: null, paid_by: 'tenant', amount: 800 }, error: null });
  mockDb.__queue('rent_credits', { data: [{ id: 'rc-1', type: 'reimbursement', status: 'pending' }], error: null });
  const res = await api('POST', '/api/maintenance/mc-1/settlement', {
    token: ownerToken,
    body: { type: 'reimbursement', amount: 800 }
  });
  assert.equal(res.status, 201);
});

// ---- GET /api/properties/:propertyId/rent-credits ----

test('GET rent-credits: lists settlements for the property', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-1' }, error: null });
  mockDb.__queue('rent_credits', { data: [{ id: 'rc-1' }], error: null });
  const res = await api('GET', '/api/properties/prop-1/rent-credits', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

// ---- PATCH /api/rent-credits/:id ----

test('PATCH rent-credits: pending -> cancelled succeeds with no extra fields', async () => {
  mockDb.__queue('rent_credits', { data: { id: 'rc-1', status: 'pending', type: 'reimbursement' }, error: null });
  mockDb.__queue('rent_credits', { data: [{ id: 'rc-1', status: 'cancelled' }], error: null });
  const res = await api('PATCH', '/api/rent-credits/rc-1', { token: ownerToken, body: { status: 'cancelled' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');
});

test('PATCH rent-credits: pending -> applied (reimbursement) succeeds with method+reference', async () => {
  mockDb.__queue('rent_credits', { data: { id: 'rc-1', status: 'pending', type: 'reimbursement', property_id: 'prop-1', tenant_id: 't-1' }, error: null });
  mockDb.__queue('rent_credits', { data: [{ id: 'rc-1', status: 'applied' }], error: null });
  const res = await api('PATCH', '/api/rent-credits/rc-1', {
    token: ownerToken,
    body: { status: 'applied', settlement_method: 'upi', settlement_reference: 'UTR123' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'applied');
});

test('PATCH rent-credits: applying without settlement_method is a 400', async () => {
  mockDb.__queue('rent_credits', { data: { id: 'rc-1', status: 'pending', type: 'reimbursement' }, error: null });
  const res = await api('PATCH', '/api/rent-credits/rc-1', {
    token: ownerToken,
    body: { status: 'applied', settlement_reference: 'UTR123' }
  });
  assert.equal(res.status, 400);
});

test('PATCH rent-credits: applying a rent_credit with an unreconciled payment is a 400', async () => {
  mockDb.__queue('rent_credits', {
    data: { id: 'rc-1', status: 'pending', type: 'rent_credit', property_id: 'prop-1', tenant_id: 't-1', applicable_period: '2026-08-01' },
    error: null
  });
  mockDb.__queue('payments', { data: null, error: null });
  const res = await api('PATCH', '/api/rent-credits/rc-1', {
    token: ownerToken,
    body: { status: 'applied', settlement_method: 'upi', settlement_reference: 'UTR123', applied_payment_id: 'pay-404' }
  });
  assert.equal(res.status, 400);
});

test('PATCH rent-credits: stale concurrent cancel is a safe 409, not a silent overwrite', async () => {
  mockDb.__queue('rent_credits', { data: { id: 'rc-1', status: 'pending', type: 'reimbursement' }, error: null });
  // The conditional UPDATE (.eq('status', 'pending')) matched zero rows --
  // another request already applied/cancelled this credit between our read
  // and our write.
  mockDb.__queue('rent_credits', { data: [], error: null });
  const res = await api('PATCH', '/api/rent-credits/rc-1', { token: ownerToken, body: { status: 'cancelled' } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'This settlement was already updated. Refresh and try again.' });
});

test('PATCH rent-credits: stale concurrent apply is a safe 409, not a silent overwrite', async () => {
  mockDb.__queue('rent_credits', { data: { id: 'rc-1', status: 'pending', type: 'reimbursement' }, error: null });
  mockDb.__queue('rent_credits', { data: [], error: null });
  const res = await api('PATCH', '/api/rent-credits/rc-1', {
    token: ownerToken,
    body: { status: 'applied', settlement_method: 'upi', settlement_reference: 'UTR123' }
  });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'This settlement was already updated. Refresh and try again.' });
});

test('PATCH rent-credits: re-applying an already-applied record is rejected', async () => {
  mockDb.__queue('rent_credits', { data: { id: 'rc-1', status: 'applied', type: 'reimbursement' }, error: null });
  const res = await api('PATCH', '/api/rent-credits/rc-1', {
    token: ownerToken,
    body: { status: 'applied', settlement_method: 'upi', settlement_reference: 'UTR999' }
  });
  assert.equal(res.status, 400);
});

test('PATCH rent-credits: cross-owner lookup is a hidden 404', async () => {
  mockDb.__queue('rent_credits', { data: null, error: null });
  const res = await api('PATCH', '/api/rent-credits/rc-1', { token: otherOwnerToken, body: { status: 'cancelled' } });
  assert.equal(res.status, 404);
});

// ---- GET /api/properties/:propertyId/maintenance/summary ----

test('GET maintenance summary: aggregates spend, open count, and pending credits', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-1' }, error: null });
  mockDb.__queue('maintenance_costs', {
    data: [
      { amount: 500, category: 'plumbing', paid_by: 'owner', request_status: 'resolved', cost_date: '2026-05-01' },
      { amount: 300, category: 'electrical', paid_by: 'tenant', request_status: 'approved', cost_date: '2026-08-01' }
    ],
    error: null
  });
  mockDb.__queue('rent_credits', { data: [{ amount: 300, type: 'reimbursement', status: 'pending' }], error: null });
  const res = await api('GET', '/api/properties/prop-1/maintenance/summary', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.totalSpend, 800);
  assert.equal(res.body.tenantPaid, 300);
  assert.equal(res.body.ownerPaid, 500);
  assert.equal(res.body.openIssueCount, 1);
  assert.equal(res.body.pendingCreditsTotal, 300);
});

// ---- POST /api/tenant/maintenance ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('POST tenant maintenance: happy path with no files -- id is generated before the single insert', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('maintenance_costs', { data: [{ id: 'mc-1', request_status: 'reported' }], error: null });
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, body: { description: 'Geyser not working' } });
  assert.equal(res.status, 201);
  const insertedRow = mockDb.__inserts('maintenance_costs')[0][0];
  assert.match(insertedRow.id, UUID_RE);
  assert.deepEqual(insertedRow.evidence_urls, []);
});

test('POST tenant maintenance: no linked tenancy is a 403', async () => {
  mockDb.__queue('tenants', { data: null, error: null });
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, body: { description: 'Geyser not working' } });
  assert.equal(res.status, 403);
});

test('POST tenant maintenance: missing description is a 400', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, body: {} });
  assert.equal(res.status, 400);
});

test('POST tenant maintenance: uploads evidence BEFORE the single insert, using the generated id in both', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('maintenance_costs', { data: [{ id: 'echoed-back-id', request_status: 'reported' }], error: null });
  const form = new FormData();
  form.append('description', 'Geyser not working');
  form.append('files', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'photo.jpg');
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, form });
  assert.equal(res.status, 201);
  assert.equal(mockDb.__storage.uploaded.length, 1);

  const insertedRow = mockDb.__inserts('maintenance_costs')[0][0];
  assert.match(insertedRow.id, UUID_RE, 'a UUID id is generated before any Storage call');
  assert.equal(insertedRow.evidence_urls.length, 1, 'server-generated evidence metadata goes into the same insert, not a follow-up update');
  assert.equal(insertedRow.evidence_urls[0].mimetype, 'image/jpeg');
  assert.equal(mockDb.__inserts('maintenance_costs').length, 1, 'exactly one insert -- no separate evidence_urls update call');

  // The generated path must use that exact same row id as its directory
  // component, plus a random (UUID-shaped) filename prefix -- not a
  // predictable timestamp.
  assert.match(
    mockDb.__storage.uploaded[0],
    new RegExp(`^maintenance-evidence/prop-1/${insertedRow.id}/[0-9a-f-]{36}_photo\\.jpg$`)
  );
});

test('POST tenant maintenance: two files in the same batch get different random path components', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('maintenance_costs', { data: [{ id: 'mc-1', request_status: 'reported' }], error: null });
  const form = new FormData();
  form.append('description', 'Two photos');
  // Identical filename for both -- the only thing that can distinguish the
  // two generated paths is the random per-file component.
  form.append('files', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'a.jpg');
  form.append('files', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.jpg');
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, form });
  assert.equal(res.status, 201);
  assert.equal(mockDb.__storage.uploaded.length, 2);
  assert.notEqual(mockDb.__storage.uploaded[0], mockDb.__storage.uploaded[1]);
});

test('POST tenant maintenance: a database failure after successful uploads cleans up storage and returns a safe 500', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('maintenance_costs', { data: null, error: { message: 'insert failed for some internal reason', code: '23502' } });
  const form = new FormData();
  form.append('description', 'Geyser not working');
  form.append('files', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'photo.jpg');
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, form });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Unable to complete the request.' }, 'never leaks the raw DB error');
  assert.equal(mockDb.__storage.uploaded.length, 1, 'the file was uploaded before the insert was attempted');
  assert.equal(mockDb.__storage.removed.length, 1, 'the uploaded file was cleaned up after the insert failed');
});

test('POST tenant maintenance: disallowed MIME type is rejected before any upload', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  const form = new FormData();
  form.append('description', 'Geyser not working');
  form.append('files', new Blob([Buffer.from('bad')], { type: 'application/zip' }), 'malware.zip');
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('POST tenant maintenance: disallowed claimed MIME is rejected even with a valid recognizable signature', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  const form = new FormData();
  form.append('description', 'Geyser not working');
  // Real JPEG magic bytes, but declared under a type that's not on the allowlist.
  form.append('files', new Blob([JPEG_BYTES], { type: 'application/octet-stream' }), 'photo.bin');
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('POST tenant maintenance: allowed claimed MIME but unrecognizable signature is rejected before any upload', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  const form = new FormData();
  form.append('description', 'Geyser not working');
  // Claims an allowed image type, but the bytes are not a real JPEG.
  form.append('files', new Blob([Buffer.from('this is plain text, not a jpeg')], { type: 'image/jpeg' }), 'fake.jpg');
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('POST tenant maintenance: more than 5 files is rejected by Multer before the handler runs', async () => {
  const form = new FormData();
  form.append('description', 'Geyser not working');
  for (let i = 0; i < 6; i++) {
    form.append('files', new Blob([Buffer.from('x')], { type: 'image/jpeg' }), `photo${i}.jpg`);
  }
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, form });
  assert.equal(res.status, 400);
  // Multer's .array(field, maxCount) throws LIMIT_UNEXPECTED_FILE (not
  // LIMIT_FILE_COUNT) once maxCount is exceeded -- handleUploadErrors maps
  // that to this message. Still a clean 400, never a raw 500.
  assert.match(res.body.error, /Unexpected file field/);
});

test('POST tenant maintenance: a failed upload mid-batch cleans up the earlier successful ones and never inserts', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  // No maintenance_costs response queued -- upload happens before insert now,
  // so under the corrected flow the insert must never be attempted at all.
  mockDb.__storage.uploadFailAt = 2; // second file in the batch fails
  const form = new FormData();
  form.append('description', 'Geyser not working');
  form.append('files', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'a.jpg');
  form.append('files', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'b.jpg');
  const res = await api('POST', '/api/tenant/maintenance', { token: tenantToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 1, 'only the first file was ever persisted');
  assert.equal(mockDb.__storage.removed.length, 1, 'the one successfully-uploaded file was cleaned up');
  assert.equal(mockDb.__inserts('maintenance_costs').length, 0, 'no maintenance_costs row is ever created for a failed batch');
});

// ---- GET /api/tenant/maintenance ----

test('GET tenant maintenance: lists the caller\'s own reports', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('maintenance_costs', { data: [{ id: 'mc-1' }], error: null });
  const res = await api('GET', '/api/tenant/maintenance', { token: tenantToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('GET tenant maintenance: no linked tenancy is a 403', async () => {
  mockDb.__queue('tenants', { data: null, error: null });
  const res = await api('GET', '/api/tenant/maintenance', { token: tenantToken });
  assert.equal(res.status, 403);
});

// ---- PATCH /api/tenant/maintenance/:id ----

test('PATCH tenant maintenance: edits description while still reported', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', tenant_id: 't-1', request_status: 'reported', property_id: 'prop-1', evidence_urls: [] }, error: null });
  mockDb.__queue('maintenance_costs', { data: [{ id: 'mc-1', description: 'Updated' }], error: null });
  const form = new FormData();
  form.append('description', 'Updated');
  const res = await api('PATCH', '/api/tenant/maintenance/mc-1', { token: tenantToken, form });
  assert.equal(res.status, 200);
});

test('PATCH tenant maintenance: already-reviewed request is locked from tenant edits', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('maintenance_costs', { data: { id: 'mc-1', tenant_id: 't-1', request_status: 'approved', property_id: 'prop-1', evidence_urls: [] }, error: null });
  const form = new FormData();
  form.append('description', 'Updated');
  const res = await api('PATCH', '/api/tenant/maintenance/mc-1', { token: tenantToken, form });
  assert.equal(res.status, 400);
});

test('PATCH tenant maintenance: report not owned by caller is a hidden 404', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('maintenance_costs', { data: null, error: null });
  const form = new FormData();
  form.append('description', 'Updated');
  const res = await api('PATCH', '/api/tenant/maintenance/mc-1', { token: tenantToken, form });
  assert.equal(res.status, 404);
});

test('PATCH tenant maintenance: new evidence is appended, not overwritten', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('maintenance_costs', {
    data: { id: 'mc-1', tenant_id: 't-1', request_status: 'reported', property_id: 'prop-1', evidence_urls: [{ path: 'old.jpg' }] },
    error: null
  });
  mockDb.__queue('maintenance_costs', { data: [{ id: 'mc-1', evidence_urls: [{ path: 'old.jpg' }, { path: 'new.jpg' }] }], error: null });
  const form = new FormData();
  form.append('files', new Blob([PNG_BYTES], { type: 'image/png' }), 'new.png');
  const res = await api('PATCH', '/api/tenant/maintenance/mc-1', { token: tenantToken, form });
  assert.equal(res.status, 200);
  assert.equal(res.body.evidence_urls.length, 2);
});

// ---- PATCH /api/appliances/:id ----

test('PATCH appliances: owner sets condition_status explicitly', async () => {
  mockDb.__queue('appliances', { data: [{ id: 'app-1', condition_status: 'under_repair' }], error: null });
  const res = await api('PATCH', '/api/appliances/app-1', { token: ownerToken, body: { condition_status: 'under_repair' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.condition_status, 'under_repair');
});

test('PATCH appliances: invalid condition_status is a 400', async () => {
  const res = await api('PATCH', '/api/appliances/app-1', { token: ownerToken, body: { condition_status: 'broken_beyond_repair' } });
  assert.equal(res.status, 400);
});

test('PATCH appliances: cross-owner update affects 0 rows and is a 404', async () => {
  mockDb.__queue('appliances', { data: [], error: null });
  const res = await api('PATCH', '/api/appliances/app-1', { token: otherOwnerToken, body: { condition_status: 'working' } });
  assert.equal(res.status, 404);
});

// ---- PATCH /api/vendors/:id ----

test('PATCH vendors: owner approves a vendor and approved_at is stamped', async () => {
  mockDb.__queue('vendors', { data: [{ id: 'v-1', approved: true, approved_at: nowIso() }], error: null });
  const res = await api('PATCH', '/api/vendors/v-1', { token: ownerToken, body: { approved: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.approved, true);
  assert.ok(res.body.approved_at);
});

test('PATCH vendors: un-approving clears approved_at', async () => {
  mockDb.__queue('vendors', { data: [{ id: 'v-1', approved: false, approved_at: null }], error: null });
  const res = await api('PATCH', '/api/vendors/v-1', { token: ownerToken, body: { approved: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.approved_at, null);
});

test('PATCH vendors: nonexistent vendor is a 404', async () => {
  mockDb.__queue('vendors', { data: [], error: null });
  const res = await api('PATCH', '/api/vendors/v-404', { token: ownerToken, body: { approved: true } });
  assert.equal(res.status, 404);
});
