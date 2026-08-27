// backupCore.js talks to Supabase directly (its own createClient() call,
// not server.js's shared instance), so it needs its own minimal fake client
// rather than the shared route-oriented supabaseMock.js -- backupCore's
// query shape (select().range()) and storage calls (createBucket, list,
// remove) don't overlap much with what that mock was built for.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

function makeFakeSupabase({ tableData = {}, uploadError = null, listResult = { data: [], error: null }, removeError = null } = {}) {
  const uploads = [];
  const removed = [];
  return {
    from(table) {
      return {
        select() { return this; },
        range: async (from, to) => {
          const rows = tableData[table] || [];
          return { data: rows.slice(from, to + 1), error: null };
        }
      };
    },
    storage: {
      createBucket: async () => ({ data: {}, error: null }),
      from() {
        return {
          upload: async (filename, buf) => {
            uploads.push({ filename, buf });
            return uploadError ? { data: null, error: uploadError } : { data: { path: filename }, error: null };
          },
          list: async () => listResult,
          remove: async (names) => {
            removed.push(...names);
            return removeError ? { data: null, error: removeError } : { data: names, error: null };
          }
        };
      }
    },
    __uploads: uploads,
    __removed: removed
  };
}

const supabasePath = require.resolve('@supabase/supabase-js');
let fakeClient;
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { createClient: () => fakeClient }
};

const { runBackup, TABLES } = require('../backupCore');

test('dry run: fetches every table, reports row counts, never uploads', async () => {
  const tableData = {};
  for (const t of TABLES) tableData[t] = [{ id: 1 }, { id: 2 }];
  fakeClient = makeFakeSupabase({ tableData });

  const result = await runBackup({ dryRun: true });

  assert.equal(result.total_rows, TABLES.length * 2);
  for (const t of TABLES) assert.equal(result.row_counts[t], 2);
  assert.equal(result.uploaded, null);
  assert.deepEqual(result.pruned, []);
  assert.equal(fakeClient.__uploads.length, 0);
});

test('paginates a table past the page-size boundary', async () => {
  const tableData = {};
  for (const t of TABLES) tableData[t] = [];
  tableData[TABLES[0]] = Array.from({ length: 1001 }, (_, i) => ({ id: i }));
  fakeClient = makeFakeSupabase({ tableData });

  const result = await runBackup({ dryRun: true });

  assert.equal(result.row_counts[TABLES[0]], 1001);
});

test('real run uploads a gzip blob that decompresses back to the source data', async () => {
  const tableData = {};
  for (const t of TABLES) tableData[t] = [];
  tableData.users = [{ id: 'u1', email: 'test@example.com' }];
  fakeClient = makeFakeSupabase({ tableData });

  const result = await runBackup({ dryRun: false });

  assert.ok(result.uploaded.startsWith('db-backup-'));
  assert.equal(fakeClient.__uploads.length, 1);
  const decompressed = JSON.parse(zlib.gunzipSync(fakeClient.__uploads[0].buf).toString());
  assert.deepEqual(decompressed.tables.users, tableData.users);
  assert.deepEqual(decompressed.tables.properties, []);
  assert.equal(decompressed.generated_at, result.generated_at);
});

test('upload failure surfaces as a thrown error, not a silent success', async () => {
  fakeClient = makeFakeSupabase({ tableData: {}, uploadError: { message: 'mock upload failure' } });

  await assert.rejects(() => runBackup({ dryRun: false }), /mock upload failure/);
});

test('prune removes only backups older than the retention window', async () => {
  const old = `db-backup-${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}.json.gz`;
  const recent = `db-backup-${new Date().toISOString()}.json.gz`;
  const unrelated = 'not-a-backup-file.txt';
  fakeClient = makeFakeSupabase({
    tableData: {},
    listResult: { data: [{ name: old }, { name: recent }, { name: unrelated }], error: null }
  });

  const result = await runBackup({ dryRun: false });

  assert.deepEqual(result.pruned, [old]);
  assert.deepEqual(fakeClient.__removed, [old]);
});

test('prune failure surfaces as a thrown error', async () => {
  const old = `db-backup-${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}.json.gz`;
  fakeClient = makeFakeSupabase({
    tableData: {},
    listResult: { data: [{ name: old }], error: null },
    removeError: { message: 'mock remove failure' }
  });

  await assert.rejects(() => runBackup({ dryRun: false }), /mock remove failure/);
});
