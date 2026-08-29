// GET /api/properties/:propertyId/documents -- the docType-generalization
// pass (2026-08-29): a document's type is recovered from its storage-key
// prefix, and the route now checks property ownership (previously missing
// entirely -- see server.js's comment on this fix). Storage listing itself
// is mocked directly since this route talks to supabase.storage, not a
// table the FIFO mock's __queue tracks the same way.
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

test('GET documents: a propertyId not owned by the caller (or nonexistent) is a generic 404', async () => {
  mockDb.__queue('properties', { data: null, error: null });
  const res = await fetch(`${baseUrl}/api/properties/not-mine/documents`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(res.status, 404);
});

test('GET documents: recognizes every current category prefix and recovers the original filename', async () => {
  mockDb.__queue('properties', { data: { id: 'p1' }, error: null });
  mockDb.__storage.listResult = {
    data: [
      { name: 'sale_deed_1700000000000_Sale Deed.pdf', created_at: '2026-01-01', metadata: { size: 100 } },
      { name: 'agreement_1700000000001_Rental Agreement.pdf', created_at: '2026-01-02', metadata: { size: 200 } },
      { name: 'deed_1700000000002_Old Upload.pdf', created_at: '2026-01-03', metadata: { size: 300 } },
      { name: '1700000000003_pre_typing_raw_timestamp_key.pdf', created_at: '2026-01-04', metadata: { size: 50 } }
    ],
    error: null
  };

  const res = await fetch(`${baseUrl}/api/properties/p1/documents`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.length, 4);
  assert.equal(body[0].type, 'sale_deed');
  assert.equal(body[0].title, 'Sale Deed.pdf');
  assert.equal(body[1].type, 'agreement');
  assert.equal(body[1].title, 'Rental Agreement.pdf');
  assert.equal(body[2].type, 'deed'); // legacy prefix still recognized
  assert.equal(body[2].title, 'Old Upload.pdf');
  assert.equal(body[3].type, 'other'); // no recognized prefix at all -> honest fallback, never guessed
  assert.equal(body[3].title, 'Property document');
});
