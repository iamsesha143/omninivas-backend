// A tiny in-memory Postgres-like table simulator, purpose-built for
// jobs/runReminders.js's tests. supabaseMock.js (the FIFO canned-response
// mock used for the route tests) intentionally doesn't model real filter
// evaluation or persistent state -- but the job's dedupe/invalidation
// behavior genuinely depends on both (e.g. "does a second upsert with an
// overlapping dedupe_key actually get skipped"), so this mock actually
// evaluates .eq/.neq/.lte/.gte/.in/.is filters against a real in-memory
// array and supports insert/upsert-with-onConflict/update/select, closely
// enough to exercise the job's real logic end to end without a database.
// options.errorTriggers: optional array of { table, mode, message } --
// the first operation matching both table and mode (mode omitted matches
// any) returns { data: null, error: { message } } instead of running,
// consumed once. Lets a test deterministically simulate a specific I/O
// failure (e.g. one particular UPDATE erroring) without needing a real
// database to actually reject a query.
function createInMemorySupabase(initialTables = {}, options = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(initialTables)) {
    tables[name] = rows.map(r => ({ ...r }));
  }
  const errorTriggers = (options.errorTriggers || []).map(t => ({ ...t, consumed: false }));
  let idCounter = 1;
  const nextId = () => `mock-id-${idCounter++}`;

  function matches(row, filters) {
    return filters.every(([op, col, val]) => {
      const rowVal = row[col];
      switch (op) {
        case 'eq': return rowVal === val;
        case 'neq': return rowVal !== val;
        case 'lte': return rowVal <= val;
        case 'gte': return rowVal >= val;
        case 'in': return val.includes(rowVal);
        case 'is': return val === null ? (rowVal === null || rowVal === undefined) : rowVal === val;
        default: return true;
      }
    });
  }

  function makeBuilder(table) {
    tables[table] = tables[table] || [];
    const filters = [];
    let mode = null;
    let updatePatch = null;
    let insertRows = null;
    let upsertOptions = null;
    let singleMode = null;
    let countMode = false;

    function execute() {
      const trigger = errorTriggers.find(t => !t.consumed && t.table === table && (!t.mode || t.mode === mode));
      if (trigger) {
        trigger.consumed = true;
        return { data: null, error: { message: trigger.message || 'mock injected error' } };
      }
      const rows = tables[table];
      if (mode === 'insert') {
        const created = insertRows.map(r => ({ id: r.id || nextId(), created_at: r.created_at || new Date().toISOString(), ...r }));
        rows.push(...created);
        return finish(created);
      }
      if (mode === 'upsert') {
        const conflictCol = upsertOptions.onConflict;
        const ignoreDuplicates = !!upsertOptions.ignoreDuplicates;
        const createdRows = [];
        for (const r of insertRows) {
          const existing = conflictCol ? rows.find((row) => row[conflictCol] === r[conflictCol]) : undefined;
          if (existing) {
            if (!ignoreDuplicates) Object.assign(existing, r);
            continue; // ignoreDuplicates: true => ON CONFLICT DO NOTHING
          }
          const created = { id: r.id || nextId(), created_at: r.created_at || new Date().toISOString(), ...r };
          rows.push(created);
          createdRows.push(created);
        }
        return finish(createdRows);
      }
      const matched = rows.filter((r) => matches(r, filters));
      if (mode === 'update') {
        for (const r of matched) Object.assign(r, updatePatch);
        return finish(matched);
      }
      if (mode === 'delete') {
        for (const r of matched) { const idx = rows.indexOf(r); if (idx >= 0) rows.splice(idx, 1); }
        return finish(matched);
      }
      return finish(matched); // select
    }

    function finish(resultRows) {
      if (singleMode === 'single') {
        if (resultRows.length !== 1) return { data: null, error: { message: resultRows.length === 0 ? 'No rows found' : 'Multiple rows found' } };
        return { data: resultRows[0], error: null };
      }
      if (singleMode === 'maybeSingle') return { data: resultRows[0] || null, error: null };
      if (countMode) return { data: resultRows, error: null, count: resultRows.length };
      return { data: resultRows, error: null };
    }

    const builder = {
      select(cols, opts) {
        if (mode === null) mode = 'select';
        if (opts && opts.count) countMode = true;
        return builder;
      },
      eq(col, val) { filters.push(['eq', col, val]); return builder; },
      neq(col, val) { filters.push(['neq', col, val]); return builder; },
      lte(col, val) { filters.push(['lte', col, val]); return builder; },
      gte(col, val) { filters.push(['gte', col, val]); return builder; },
      in(col, vals) { filters.push(['in', col, vals]); return builder; },
      is(col, val) { filters.push(['is', col, val]); return builder; },
      order() { return builder; },
      update(patch) { mode = 'update'; updatePatch = patch; return builder; },
      insert(rows) { mode = 'insert'; insertRows = Array.isArray(rows) ? rows : [rows]; return builder; },
      upsert(rows, options) { mode = 'upsert'; insertRows = Array.isArray(rows) ? rows : [rows]; upsertOptions = options || {}; return builder; },
      delete() { mode = 'delete'; return builder; },
      maybeSingle() { singleMode = 'maybeSingle'; return builder; },
      single() { singleMode = 'single'; return builder; },
      then(resolve, reject) {
        try { resolve(execute()); } catch (e) { reject(e); }
      }
    };
    return builder;
  }

  return { from: makeBuilder, __tables: tables };
}

module.exports = { createInMemorySupabase };
