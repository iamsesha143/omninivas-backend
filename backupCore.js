const { createClient } = require('@supabase/supabase-js');
const zlib = require('zlib');

// Every table server.js writes to (kept in sync manually -- there's no
// migration-driven schema introspection in this codebase). Schema itself is
// already versioned in supabase/migrations/*.sql; this backs up the data,
// not the schema.
const TABLES = [
  'appliances', 'co_occupants', 'feedback_submissions',
  'handover_items', 'handovers', 'maintenance_costs', 'notifications',
  'obligations', 'payment_history', 'payments', 'properties', 'rent_credits',
  'tenants', 'users', 'vendors', 'whatsapp_extracted_facts',
  'whatsapp_imports', 'whatsapp_messages'
];

const BUCKET = 'backups';
const PAGE_SIZE = 1000;
const RETENTION_DAYS = 14;

function getClient() {
  return createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');
}

async function fetchAllRows(supabase, table) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function pruneOldBackups(supabase) {
  const { data, error } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
  if (error) throw new Error(`list backups: ${error.message}`);
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const stale = (data || []).filter(f => {
    const m = f.name.match(/^db-backup-(.+)\.json\.gz$/);
    if (!m) return false;
    const t = Date.parse(m[1]);
    return Number.isFinite(t) ? t < cutoff : false;
  });
  if (stale.length) {
    const { error: delErr } = await supabase.storage.from(BUCKET).remove(stale.map(f => f.name));
    if (delErr) throw new Error(`prune backups: ${delErr.message}`);
  }
  return stale.map(f => f.name);
}

async function runBackup({ dryRun = false } = {}) {
  const supabase = getClient();
  const summary = { generated_at: new Date().toISOString(), tables: {}, row_counts: {} };

  for (const table of TABLES) {
    const rows = await fetchAllRows(supabase, table);
    summary.tables[table] = rows;
    summary.row_counts[table] = rows.length;
  }

  const totalRows = Object.values(summary.row_counts).reduce((a, b) => a + b, 0);
  const json = JSON.stringify({ generated_at: summary.generated_at, tables: summary.tables });
  const gz = zlib.gzipSync(json);

  const result = {
    generated_at: summary.generated_at,
    row_counts: summary.row_counts,
    total_rows: totalRows,
    raw_bytes: json.length,
    gzip_bytes: gz.length
  };

  if (dryRun) {
    result.uploaded = null;
    result.pruned = [];
    return result;
  }

  const { error: bucketErr } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (bucketErr && !/already exists/i.test(bucketErr.message || '')) {
    throw new Error(`create backups bucket: ${bucketErr.message}`);
  }

  const filename = `db-backup-${summary.generated_at}.json.gz`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(filename, gz, {
    contentType: 'application/gzip'
  });
  if (upErr && !/already exists/i.test(upErr.message || '')) {
    throw new Error(`upload backup: ${upErr.message}`);
  }

  result.uploaded = filename;
  result.pruned = await pruneOldBackups(supabase);
  return result;
}

module.exports = { runBackup, TABLES, BUCKET };
