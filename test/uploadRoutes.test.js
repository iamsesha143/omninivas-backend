// Route-level tests for F1 (upload safety + honest failure handling) on the
// previously-unvalidated upload routes: documents/deed, tenant documents,
// payment proof (owner + tenant), appliance bill scan, handover photo.
// Same harness convention as test/maintenanceRoutes.test.js -- @supabase/
// supabase-js is replaced with test/supabaseMock.js before server.js loads,
// so no real Supabase/Storage/database is touched. Only synthetic in-memory
// buffers are used; nothing here uploads to production.
//
// Payment-proof and appliance-scan routes call real OCR (Tesseract.js /
// ImageMagick+Tesseract for PDFs) AFTER a successful upload -- that's
// pre-existing, unrelated behavior, out of scope for this slice, and not
// something a unit test should depend on (slow, environment-dependent).
// Their MIME-rejection and storage-failure paths are tested here because
// both return before OCR ever runs; their OCR-dependent happy path is
// deliberately not exercised -- see the final report for that gap.
//
// Run with: node --test test/uploadRoutes.test.js
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
let ownerToken, tenantToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  const secret = process.env.JWT_SECRET;
  ownerToken = jwt.sign({ sub: 'owner-1', role: 'owner' }, secret);
  tenantToken = jwt.sign({ sub: 'tenant-user-1', role: 'tenant' }, secret);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockDb.__reset();
});

async function api(method, path, { token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: form });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

// A genuinely valid, complete JPEG (not just matching magic bytes) --
// payment-proof and appliance-scan routes run real OCR (Tesseract.js) on the
// buffer after a successful upload. A merely magic-byte-shaped but truncated
// buffer crashes Tesseract's worker with an uncaught exception outside the
// route's own try/catch (confirmed while writing this file); a real decodable
// image completes OCR safely in well under a second. `canvas` is already a
// project dependency (used for PDF/image handling elsewhere), not new here.
const { createCanvas } = require('canvas');
const JPEG_BYTES = createCanvas(4, 4).toBuffer('image/jpeg');
const PDF_BYTES = Buffer.from('%PDF-1.4\n%mock pdf body for testing only\n');
const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'), Buffer.from('isom', 'ascii')]);

// ---- POST /api/properties/:propertyId/documents/deed ----

test('documents/deed: video MIME is rejected before any storage call', async () => {
  const form = new FormData();
  form.append('file', new Blob([MP4_BYTES], { type: 'video/mp4' }), 'video.mp4');
  const res = await api('POST', '/api/properties/prop-1/documents/deed', { token: ownerToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('documents/deed: valid PDF is accepted and stored', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-1' }, error: null });
  const form = new FormData();
  form.append('file', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'deed.pdf');
  const res = await api('POST', '/api/properties/prop-1/documents/deed', { token: ownerToken, form });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(mockDb.__storage.uploaded.length, 1);
});

test('documents/deed: valid JPEG is accepted', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-1' }, error: null });
  const form = new FormData();
  form.append('file', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'deed.jpg');
  const res = await api('POST', '/api/properties/prop-1/documents/deed', { token: ownerToken, form });
  assert.equal(res.status, 200);
});

test('documents/deed: a storage failure returns an honest error, not a false success', async () => {
  mockDb.__queue('properties', { data: { id: 'prop-1' }, error: null });
  mockDb.__storage.uploadFailAt = 1;
  const form = new FormData();
  form.append('file', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'deed.pdf');
  const res = await api('POST', '/api/properties/prop-1/documents/deed', { token: ownerToken, form });
  assert.notEqual(res.status, 200);
  assert.notEqual(res.body?.success, true);
});

test('documents/deed: a propertyId not owned by the caller (or nonexistent) is a generic 404, no upload attempted', async () => {
  mockDb.__queue('properties', { data: null, error: null });
  const form = new FormData();
  form.append('file', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'deed.pdf');
  const res = await api('POST', '/api/properties/not-mine/documents/deed', { token: ownerToken, form });
  assert.equal(res.status, 404);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('documents/deed: an invalid docType is rejected with 400, ownership never checked', async () => {
  const form = new FormData();
  form.append('file', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'deed.pdf');
  const res = await api('POST', '/api/properties/prop-1/documents/not_a_real_type', { token: ownerToken, form });
  assert.equal(res.status, 400);
});

// ---- POST /api/properties/:propertyId/tenants/:tenantId/documents/:docType ----

test('tenant documents: video MIME is rejected', async () => {
  const form = new FormData();
  form.append('file', new Blob([MP4_BYTES], { type: 'video/mp4' }), 'video.mp4');
  const res = await api('POST', '/api/properties/prop-1/tenants/t-1/documents/aadhar', { token: ownerToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('tenant documents: valid PDF is accepted', async () => {
  const form = new FormData();
  form.append('file', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'aadhar.pdf');
  const res = await api('POST', '/api/properties/prop-1/tenants/t-1/documents/aadhar', { token: ownerToken, form });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('tenant documents: a storage failure returns an honest error', async () => {
  mockDb.__storage.uploadFailAt = 1;
  const form = new FormData();
  form.append('file', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'aadhar.pdf');
  const res = await api('POST', '/api/properties/prop-1/tenants/t-1/documents/aadhar', { token: ownerToken, form });
  assert.notEqual(res.status, 200);
});

// ---- POST /api/properties/:propertyId/obligations/:obligationId/proof (owner) ----

test('payment proof (owner): video MIME is rejected before the obligation lookup', async () => {
  const form = new FormData();
  form.append('file', new Blob([MP4_BYTES], { type: 'video/mp4' }), 'video.mp4');
  const res = await api('POST', '/api/properties/prop-1/obligations/ob-1/proof', { token: ownerToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('payment proof (owner): a storage failure returns an honest error and never creates a payment row', async () => {
  mockDb.__queue('obligations', { data: { id: 'ob-1', amount: 5000 }, error: null });
  mockDb.__storage.uploadFailAt = 1;
  const form = new FormData();
  form.append('file', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'proof.jpg');
  const res = await api('POST', '/api/properties/prop-1/obligations/ob-1/proof', { token: ownerToken, form });
  assert.notEqual(res.status, 201);
  assert.equal(mockDb.__inserts('payments').length, 0, 'no payment row implying a proof exists when the upload failed');
});

test('payment proof (owner): a successful upload followed by a DB failure rolls back the uploaded file', async () => {
  mockDb.__queue('obligations', { data: { id: 'ob-1', amount: 5000 }, error: null });
  mockDb.__queue('payments', { data: null, error: { message: 'mock DB insert failure' } });
  const form = new FormData();
  form.append('file', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'proof.jpg');
  const res = await api('POST', '/api/properties/prop-1/obligations/ob-1/proof', { token: ownerToken, form });
  assert.notEqual(res.status, 201);
  assert.equal(mockDb.__storage.uploaded.length, 1, 'the file was uploaded before the DB insert was attempted');
  assert.equal(mockDb.__storage.removed.length, 1, 'the uploaded file was rolled back after the DB insert failed');
});

// ---- POST /api/tenant/obligations/:obligationId/proof ----

test('payment proof (tenant): video MIME is rejected before any tenant/obligation lookup', async () => {
  const form = new FormData();
  form.append('file', new Blob([MP4_BYTES], { type: 'video/mp4' }), 'video.mp4');
  const res = await api('POST', '/api/tenant/obligations/ob-1/proof', { token: tenantToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('payment proof (tenant): a storage failure returns an honest error and never creates a payment row', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('obligations', { data: { id: 'ob-1', amount: 5000 }, error: null });
  mockDb.__storage.uploadFailAt = 1;
  const form = new FormData();
  form.append('file', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'proof.jpg');
  const res = await api('POST', '/api/tenant/obligations/ob-1/proof', { token: tenantToken, form });
  assert.notEqual(res.status, 201);
  assert.equal(mockDb.__inserts('payments').length, 0);
});

test('payment proof (tenant): a successful upload followed by a DB failure rolls back the uploaded file', async () => {
  mockDb.__queue('tenants', { data: { id: 't-1', property_id: 'prop-1', user_id: 'owner-1' }, error: null });
  mockDb.__queue('obligations', { data: { id: 'ob-1', amount: 5000 }, error: null });
  mockDb.__queue('payments', { data: null, error: { message: 'mock DB insert failure' } });
  const form = new FormData();
  form.append('file', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'proof.jpg');
  const res = await api('POST', '/api/tenant/obligations/ob-1/proof', { token: tenantToken, form });
  assert.notEqual(res.status, 201);
  assert.equal(mockDb.__storage.uploaded.length, 1, 'the file was uploaded before the DB insert was attempted');
  assert.equal(mockDb.__storage.removed.length, 1, 'the uploaded file was rolled back after the DB insert failed');
});

// ---- POST /api/properties/:propertyId/appliances/scan ----

test('appliance scan: video MIME is rejected', async () => {
  const form = new FormData();
  form.append('file', new Blob([MP4_BYTES], { type: 'video/mp4' }), 'video.mp4');
  const res = await api('POST', '/api/properties/prop-1/appliances/scan', { token: ownerToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('appliance scan: a storage failure returns an honest error, never a bill_url for a file that was never saved', async () => {
  mockDb.__storage.uploadFailAt = 1;
  const form = new FormData();
  form.append('file', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'bill.jpg');
  const res = await api('POST', '/api/properties/prop-1/appliances/scan', { token: ownerToken, form });
  assert.notEqual(res.status, 200);
  assert.equal(res.body?.bill_url, undefined, 'never returns a bill_url pointing at a file that was never stored');
});

// ---- POST /api/handover/:id/items ----

test('handover item: PDF is rejected for the photo field -- handover photo is images only', async () => {
  mockDb.__queue('handovers', { data: { id: 'h-1', property_id: 'prop-1' }, error: null });
  const form = new FormData();
  form.append('item_name', 'Geyser');
  form.append('photo', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'doc.pdf');
  const res = await api('POST', '/api/handover/h-1/items', { token: ownerToken, form });
  assert.equal(res.status, 400);
  assert.equal(mockDb.__storage.uploaded.length, 0);
  assert.equal(mockDb.__inserts('handover_items').length, 0, 'no item row created when the photo fails validation');
});

test('handover item: valid JPEG photo is accepted', async () => {
  mockDb.__queue('handovers', { data: { id: 'h-1', property_id: 'prop-1' }, error: null });
  mockDb.__queue('handover_items', { data: [{ id: 'item-1', item_name: 'Geyser', condition: 'good', photo_url: 'handover/prop-1/h-1/123' }], error: null });
  const form = new FormData();
  form.append('item_name', 'Geyser');
  form.append('photo', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'geyser.jpg');
  const res = await api('POST', '/api/handover/h-1/items', { token: ownerToken, form });
  assert.equal(res.status, 201);
  assert.equal(mockDb.__storage.uploaded.length, 1);
});

test('handover item: no photo provided still creates the item normally (unaffected existing behavior)', async () => {
  mockDb.__queue('handovers', { data: { id: 'h-1', property_id: 'prop-1' }, error: null });
  mockDb.__queue('handover_items', { data: [{ id: 'item-1', item_name: 'Geyser', condition: 'good', photo_url: null }], error: null });
  const form = new FormData();
  form.append('item_name', 'Geyser');
  const res = await api('POST', '/api/handover/h-1/items', { token: ownerToken, form });
  assert.equal(res.status, 201);
  assert.equal(mockDb.__storage.uploaded.length, 0);
});

test('handover item: a photo storage failure returns an honest error and never creates an item row with a dangling photo_url', async () => {
  mockDb.__queue('handovers', { data: { id: 'h-1', property_id: 'prop-1' }, error: null });
  mockDb.__storage.uploadFailAt = 1;
  const form = new FormData();
  form.append('item_name', 'Geyser');
  form.append('photo', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'geyser.jpg');
  const res = await api('POST', '/api/handover/h-1/items', { token: ownerToken, form });
  assert.notEqual(res.status, 201);
  assert.equal(mockDb.__inserts('handover_items').length, 0, 'no handover_items row implying a photo exists when the upload failed');
});

test('handover item: a successful photo upload followed by a DB failure rolls back the uploaded photo', async () => {
  mockDb.__queue('handovers', { data: { id: 'h-1', property_id: 'prop-1' }, error: null });
  mockDb.__queue('handover_items', { data: null, error: { message: 'mock DB insert failure' } });
  const form = new FormData();
  form.append('item_name', 'Geyser');
  form.append('photo', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'geyser.jpg');
  const res = await api('POST', '/api/handover/h-1/items', { token: ownerToken, form });
  assert.notEqual(res.status, 201);
  assert.equal(mockDb.__storage.uploaded.length, 1, 'the photo was uploaded before the DB insert was attempted');
  assert.equal(mockDb.__storage.removed.length, 1, 'the uploaded photo was rolled back after the DB insert failed');
});
