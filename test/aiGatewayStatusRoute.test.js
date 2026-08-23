// Focused route-level tests for GET /api/settings/ai-status -- the
// owner-gated diagnostic for the (currently dormant-in-production) AI
// gateway. Same mocked-Supabase harness as the other route test files, plus
// a mocked aiGateway.js module (same require.cache-substitution technique)
// so `configured`/probe outcomes are fully controllable without a real
// gateway key or network call.
//
// Run with: node --test test/aiGatewayStatusRoute.test.js
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

const aiGatewayPath = require.resolve('../aiGateway');
const SENTINEL_RAW_RESPONSE = 'do-not-leak-this-raw-gateway-text';
const mockAiGateway = {
  __configured: false,
  __runResult: { ok: true, text: SENTINEL_RAW_RESPONSE },
  isConfigured: () => mockAiGateway.__configured,
  run: async () => mockAiGateway.__runResult
};
require.cache[aiGatewayPath] = {
  id: aiGatewayPath,
  filename: aiGatewayPath,
  loaded: true,
  exports: mockAiGateway
};

const app = require('../server');

let server;
let baseUrl;
let ownerToken;
let tenantToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  ownerToken = jwt.sign({ sub: 'owner-1', role: 'owner' }, process.env.JWT_SECRET);
  tenantToken = jwt.sign({ sub: 'tenant-1', role: 'tenant' }, process.env.JWT_SECRET);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockDb.__reset();
  mockAiGateway.__configured = false;
  mockAiGateway.__runResult = { ok: true, text: SENTINEL_RAW_RESPONSE };
});

async function api(path, { token } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

test('GET /api/settings/ai-status: no token is rejected (401)', async () => {
  const res = await api('/api/settings/ai-status');
  assert.equal(res.status, 401);
});

test('GET /api/settings/ai-status: a tenant token is rejected (403), matching requireOwner convention', async () => {
  const res = await api('/api/settings/ai-status', { token: tenantToken });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Owner access only');
});

test('GET /api/settings/ai-status: owner, gateway unavailable -> configured:false, no provider/model leaked', async () => {
  mockAiGateway.__configured = false;
  const res = await api('/api/settings/ai-status', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, false);
  assert.equal('provider' in res.body, false);
  assert.equal('model' in res.body, false);
});

test('GET /api/settings/ai-status: owner, gateway configured -> safe provider/model identifiers only', async () => {
  mockAiGateway.__configured = true;
  const res = await api('/api/settings/ai-status', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, true);
  assert.equal(typeof res.body.provider, 'string');
  assert.equal(typeof res.body.model, 'string');
});

test('GET /api/settings/ai-status: response never contains a key, URL, headers, or raw gateway response', async () => {
  mockAiGateway.__configured = true;
  const res = await api('/api/settings/ai-status', { token: ownerToken });
  const serialized = JSON.stringify(res.body).toLowerCase();
  assert.equal(serialized.includes(SENTINEL_RAW_RESPONSE.toLowerCase()), false);
  for (const forbidden of ['key', 'url', 'header', 'authorization', 'prompt']) {
    assert.equal(Object.keys(res.body).some(k => k.toLowerCase().includes(forbidden)), false);
  }
});

test('GET /api/settings/ai-status: no probe query param -> no probe field at all', async () => {
  mockAiGateway.__configured = true;
  const res = await api('/api/settings/ai-status', { token: ownerToken });
  assert.equal('probe' in res.body, false);
});

test('GET /api/settings/ai-status?probe=true: mocked gateway success -> probe:"ok", raw text never leaked', async () => {
  mockAiGateway.__configured = true;
  mockAiGateway.__runResult = { ok: true, text: SENTINEL_RAW_RESPONSE };
  const res = await api('/api/settings/ai-status?probe=true', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.probe, 'ok');
  assert.equal(JSON.stringify(res.body).includes(SENTINEL_RAW_RESPONSE), false);
});

test('GET /api/settings/ai-status?probe=true: mocked gateway failure -> probe:"failed", no error detail leaked', async () => {
  mockAiGateway.__configured = true;
  mockAiGateway.__runResult = { ok: false };
  const res = await api('/api/settings/ai-status?probe=true', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.probe, 'failed');
  assert.equal('error' in res.body, false);
});
