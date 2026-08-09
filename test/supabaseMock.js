// Minimal fake Supabase client for route-level tests. This is NOT a
// reimplementation of the real query builder -- each test pre-queues the
// exact {data, error} result it wants the next supabase.from(table)...
// chain to resolve to, in call order, per table. That's sufficient because
// every route in server.js is written with a known, fixed sequence of
// supabase.from(...) calls; the mock just needs to hand back what the real
// client would have resolved to at each step.
function createMockSupabase() {
  const queues = {};
  const inserts = {};
  const storage = { uploaded: [], removed: [], uploadFailAt: null, uploadCallCount: 0 };

  function dequeue(table) {
    const q = queues[table];
    if (!q || q.length === 0) {
      throw new Error(`[mock supabase] no response queued for table "${table}"`);
    }
    return q.shift();
  }

  function makeBuilder(table) {
    const builder = {};
    const chainMethods = ['select', 'eq', 'is', 'ilike', 'order', 'update', 'delete', 'maybeSingle', 'single', 'in', 'neq', 'lte', 'gte'];
    for (const method of chainMethods) {
      builder[method] = () => builder;
    }
    // Records exactly what a route passed to .insert(...) so tests can
    // assert on the actual row shape (e.g. a server-generated id) rather
    // than only on the canned response we hand back.
    builder.insert = (payload) => {
      inserts[table] = inserts[table] || [];
      inserts[table].push(payload);
      return builder;
    };
    // Real supabase-js query builders are thenable -- awaiting the chain at
    // any point executes the built query. The mock only needs to resolve.
    builder.then = (resolve, reject) => {
      try { resolve(dequeue(table)); } catch (e) { reject(e); }
    };
    return builder;
  }

  const client = {
    from(table) { return makeBuilder(table); },
    storage: {
      from() {
        return {
          upload: async (path) => {
            storage.uploadCallCount += 1;
            if (storage.uploadFailAt && storage.uploadCallCount === storage.uploadFailAt) {
              return { data: null, error: { message: 'mock upload failure' } };
            }
            storage.uploaded.push(path);
            return { data: { path }, error: null };
          },
          remove: async (paths) => {
            storage.removed.push(...paths);
            return { data: paths, error: null };
          }
        };
      }
    },
    __queue(table, response) {
      queues[table] = queues[table] || [];
      queues[table].push(response);
      return client;
    },
    __inserts(table) {
      return inserts[table] || [];
    },
    __reset() {
      for (const k of Object.keys(queues)) delete queues[k];
      for (const k of Object.keys(inserts)) delete inserts[k];
      storage.uploaded = [];
      storage.removed = [];
      storage.uploadFailAt = null;
      storage.uploadCallCount = 0;
    },
    __storage: storage
  };
  return client;
}

module.exports = { createMockSupabase };
