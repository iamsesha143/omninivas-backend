// Route-level tests for POST /api/admin/backup. backupCore.js's own logic
// (pagination, upload, pruning) is covered separately in backupCore.test.js
// -- this file only exercises the route's auth gate and error handling, so
// backupCore is mocked wholesale here (same require.cache-substitution
// technique as aiGatewayStatusRoute.test.js's aiGateway mock).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMockSupabase } = require('./supabaseMock');

const supabasePath = require.resolve('@supabase/supabase-js');
const mockDb = createMockSupabase();
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { createClient: () => mockDb }
};

const backupCorePath = require.resolve('../backupCore');
const mockBackupCore = {
  __result: { generated_at: 'x', row_counts: {}, total_rows: 0, uploaded: 'db-backup-x.json.gz', pruned: [] },
  __shouldThrow: false,
  runBackup: async () => {
    if (mockBackupCore.__shouldThrow) throw new Error('mock backup failure');
    return mockBackupCore.__result;
  }
};
require.cache[backupCorePath] = {
  id: backupCorePath,
  filename: backupCorePath,
  loaded: true,
  exports: mockBackupCore
};

process.env.BACKUP_SECRET = 'test-backup-secret-value';

const app = require('../server');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('POST /api/admin/backup: correct secret runs the backup and returns its summary', async () => {
  mockBackupCore.__shouldThrow = false;
  const res = await fetch(`${baseUrl}/api/admin/backup`, {
    method: 'POST',
    headers: { 'x-backup-secret': 'test-backup-secret-value' }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.uploaded, 'db-backup-x.json.gz');
});

test('POST /api/admin/backup: wrong secret is rejected before the backup runs', async () => {
  const res = await fetch(`${baseUrl}/api/admin/backup`, {
    method: 'POST',
    headers: { 'x-backup-secret': 'wrong' }
  });
  assert.equal(res.status, 401);
});

test('POST /api/admin/backup: missing secret header is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/admin/backup`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('POST /api/admin/backup: a backup failure surfaces as 500, not a silent 200', async () => {
  mockBackupCore.__shouldThrow = true;
  const res = await fetch(`${baseUrl}/api/admin/backup`, {
    method: 'POST',
    headers: { 'x-backup-secret': 'test-backup-secret-value' }
  });
  assert.equal(res.status, 500);
  mockBackupCore.__shouldThrow = false;
});
