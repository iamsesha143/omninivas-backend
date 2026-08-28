// Focused regression test for GET /api/payments/:id/receipt's HTML-escaping
// fix (2026-08-28) -- the same stored-XSS pattern flagged in the CA export
// route existed here first (this route predates it). No broader receipt-
// route test suite exists yet; this file exists specifically to lock in the
// security fix, not to be a general-purpose test of the route.
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

test('receipt: tenant name, property name/address, UTR, and owner name are all HTML-escaped, not rendered as markup', async () => {
  mockDb.__queue('payments', {
    data: { id: 'pay1', user_id: 'owner-1', property_id: 'p1', tenant_id: 't1', amount: 20000, payment_date: '2026-06-05', period: '2026-06-01', utr_number: '<script>alert(1)</script>' },
    error: null
  });
  mockDb.__queue('properties', { data: { property_name: '<b>Evil Flat</b>', street_address: '<img src=x onerror=alert(2)>', city: 'Blr', state: 'KA', pincode: '560001' }, error: null });
  mockDb.__queue('users', { data: { full_name: '<script>alert(3)</script>', email: 'o@test.com' }, error: null });
  mockDb.__queue('tenants', { data: { name: '<script>alert(4)</script>' }, error: null });

  const res = await fetch(`${baseUrl}/api/payments/pay1/receipt`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.doesNotMatch(html, /<b>Evil Flat<\/b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); // UTR
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/); // owner name
  assert.match(html, /&lt;script&gt;alert\(4\)&lt;\/script&gt;/); // tenant name
  assert.match(html, /&lt;b&gt;Evil Flat&lt;\/b&gt;/); // property name
});
