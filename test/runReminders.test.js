// Mocked tests for jobs/runReminders.js. Uses the in-memory table mock
// (test/inMemorySupabaseMock.js), not the FIFO canned-response mock -- the
// job's dedupe/invalidation behavior genuinely depends on persistent,
// filter-evaluated state across multiple calls within a single run and
// across repeated runs. No real Supabase/DB connection anywhere in this
// file. Run with: node --test test/runReminders.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createInMemorySupabase } = require('./inMemorySupabaseMock');
const job = require('../jobs/runReminders');

const TODAY = '2026-08-15';

function baseTables(overrides = {}) {
  return {
    appliances: [],
    properties: [],
    obligations: [],
    payments: [],
    tenants: [],
    maintenance_costs: [],
    rent_credits: [],
    notifications: [],
    reminder_job_runs: [],
    ...overrides
  };
}

// ---- fetchAll / buildDecisions plumbing ----

test('fetchAll: reads every source table and returns arrays even when empty', async () => {
  const supabase = createInMemorySupabase(baseTables());
  const source = await job.fetchAll(supabase);
  assert.deepEqual(source.appliances, []);
  assert.deepEqual(source.properties, []);
  assert.deepEqual(source.obligations, []);
});

test('buildDecisions: end-to-end wiring produces an insertable rent_due row', () => {
  const source = {
    appliances: [], properties: [],
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 12000, due_day: 20, paid_by: 'tenant', active: true }],
    // July already paid -- isolates this test to the upcoming August
    // rent_due row only, rather than also incidentally catching up a
    // (genuinely correct, but not this test's focus) rent_overdue row for
    // a never-paid prior period. See the "catch-up" tests below for that
    // cross-category interaction covered explicitly.
    payments: [{ obligation_id: 'ob1', period: '2026-07-01', status: 'paid' }],
    tenants: [{ id: 't1', property_id: 'p1', user_id: 'owner-1', login_user_id: 'tenant-user-1', is_active: true }],
    maintenanceCosts: [], rentCredits: []
  };
  const { toInsert } = job.buildDecisions(source, '2026-08-15'); // 5_days_before due_day=20
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].category, 'rent_due');
  assert.equal(toInsert[0].recipient_user_id, 'tenant-user-1');
});

// ---- reopenElapsedSnoozes ----

test('reopenElapsedSnoozes: flips only snoozed rows whose snoozed_until has arrived, clears snoozed_until', async () => {
  const supabase = createInMemorySupabase(baseTables({
    notifications: [
      { id: 'n1', status: 'snoozed', snoozed_until: '2026-08-14' }, // elapsed
      { id: 'n2', status: 'snoozed', snoozed_until: '2026-08-15' }, // elapsed (<=)
      { id: 'n3', status: 'snoozed', snoozed_until: '2026-08-16' }, // not yet
      { id: 'n4', status: 'read', snoozed_until: null }
    ]
  }));
  const reopened = await job.reopenElapsedSnoozes(supabase, TODAY);
  assert.equal(reopened, 2);
  const rows = supabase.__tables.notifications;
  assert.equal(rows.find(r => r.id === 'n1').status, 'unread');
  assert.equal(rows.find(r => r.id === 'n1').snoozed_until, null);
  assert.equal(rows.find(r => r.id === 'n2').status, 'unread');
  assert.equal(rows.find(r => r.id === 'n3').status, 'snoozed'); // untouched
});

// ---- applyInvalidation ----

test('applyInvalidation: excludeEventDate invalidates only stale-dated rows, keeps the current one', async () => {
  const supabase = createInMemorySupabase(baseTables({
    notifications: [
      { id: 'n1', source_type: 'appliance', source_id: 'a1', category: 'warranty_expiry', event_date: '2026-10-31', status: 'unread' }, // stale
      { id: 'n2', source_type: 'appliance', source_id: 'a1', category: 'warranty_expiry', event_date: '2026-11-30', status: 'unread' }  // current
    ]
  }));
  await job.applyInvalidation(supabase, { source_type: 'appliance', source_id: 'a1', category: 'warranty_expiry', reason: 'source_date_changed', excludeEventDate: '2026-11-30' });
  const rows = supabase.__tables.notifications;
  assert.equal(rows.find(r => r.id === 'n1').status, 'invalidated');
  assert.equal(rows.find(r => r.id === 'n1').invalidation_reason, 'source_date_changed');
  assert.ok(rows.find(r => r.id === 'n1').invalidated_at);
  assert.equal(rows.find(r => r.id === 'n2').status, 'unread'); // untouched
});

test('applyInvalidation: dismissed/invalidated rows are never re-touched (only unread/read/snoozed are eligible)', async () => {
  const supabase = createInMemorySupabase(baseTables({
    notifications: [{ id: 'n1', source_type: 'rent_credit', source_id: 'rc1', category: 'settlement_pending', status: 'dismissed' }]
  }));
  await job.applyInvalidation(supabase, { source_type: 'rent_credit', source_id: 'rc1', category: 'settlement_pending', reason: 'settlement_applied' });
  assert.equal(supabase.__tables.notifications[0].status, 'dismissed'); // untouched
});

test('applyInvalidation: recipient_user_id scoping only invalidates that recipient\'s rows', async () => {
  const supabase = createInMemorySupabase(baseTables({
    notifications: [
      { id: 'n1', source_type: 'obligation', source_id: 'ob1', category: 'rent_due', recipient_user_id: 'tenant-1', status: 'unread' },
      { id: 'n2', source_type: 'obligation', source_id: 'ob1', category: 'rent_due', recipient_user_id: 'tenant-2', status: 'unread' }
    ]
  }));
  await job.applyInvalidation(supabase, { source_type: 'obligation', source_id: 'ob1', category: 'rent_due', reason: 'tenancy_inactive', recipient_user_id: 'tenant-1' });
  const rows = supabase.__tables.notifications;
  assert.equal(rows.find(r => r.id === 'n1').status, 'invalidated');
  assert.equal(rows.find(r => r.id === 'n2').status, 'unread');
});

test('applyInvalidation: clears snoozed_until when invalidating a snoozed row (constraint compliance)', async () => {
  const supabase = createInMemorySupabase(baseTables({
    notifications: [{ id: 'n1', source_type: 'maintenance_cost', source_id: 'mc1', category: 'maintenance_urgent', status: 'snoozed', snoozed_until: '2026-09-01' }]
  }));
  await job.applyInvalidation(supabase, { source_type: 'maintenance_cost', source_id: 'mc1', category: 'maintenance_urgent', reason: 'maintenance_resolved' });
  const row = supabase.__tables.notifications[0];
  assert.equal(row.status, 'invalidated');
  assert.equal(row.snoozed_until, null); // never left dangling on a non-snoozed row
});

// ---- insertNewNotifications / dedupe ----

test('insertNewNotifications: inserts new rows and reports an accurate created count', async () => {
  const supabase = createInMemorySupabase(baseTables());
  const toInsert = [
    { dedupe_key: 'k1', category: 'warranty_expiry', recipient_user_id: 'owner-1' },
    { dedupe_key: 'k2', category: 'warranty_expiry', recipient_user_id: 'owner-1' }
  ];
  const created = await job.insertNewNotifications(supabase, toInsert);
  assert.equal(created.length, 2);
  assert.equal(supabase.__tables.notifications.length, 2);
});

test('insertNewNotifications: a duplicate dedupe_key against an existing row creates nothing new', async () => {
  const supabase = createInMemorySupabase(baseTables({
    notifications: [{ id: 'existing', dedupe_key: 'k1', category: 'warranty_expiry', status: 'unread' }]
  }));
  const created = await job.insertNewNotifications(supabase, [{ dedupe_key: 'k1', category: 'warranty_expiry', recipient_user_id: 'owner-1' }]);
  assert.equal(created.length, 0);
  assert.equal(supabase.__tables.notifications.length, 1); // still just the one row
});

test('insertNewNotifications: empty input writes nothing and makes no query', async () => {
  const supabase = createInMemorySupabase(baseTables());
  const created = await job.insertNewNotifications(supabase, []);
  assert.equal(created.length, 0);
  assert.equal(supabase.__tables.notifications.length, 0);
});

// ---- runOnce: full pass, dry-run, and duplicate-run idempotency ----

test('runOnce: dry-run computes candidates but writes nothing at all', async () => {
  const tables = baseTables({
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 10000, due_day: 20, paid_by: 'tenant', active: true }],
    payments: [{ obligation_id: 'ob1', period: '2026-07-01', status: 'paid' }], // isolates this to the rent_due row only, see the comment above
    tenants: [{ id: 't1', property_id: 'p1', user_id: 'owner-1', login_user_id: 'tenant-user-1', is_active: true }]
  });
  const supabase = createInMemorySupabase(tables);
  const wouldCreate = await job.runOnce(supabase, '2026-08-15', true);
  assert.ok(wouldCreate.created >= 1);
  assert.equal(supabase.__tables.notifications.length, 0); // nothing written
  assert.equal(supabase.__tables.reminder_job_runs.length, 0); // no job-run row in dry-run either
});

test('runOnce: a real run creates the expected row(s)', async () => {
  const tables = baseTables({
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 10000, due_day: 20, paid_by: 'tenant', active: true }],
    payments: [{ obligation_id: 'ob1', period: '2026-07-01', status: 'paid' }],
    tenants: [{ id: 't1', property_id: 'p1', user_id: 'owner-1', login_user_id: 'tenant-user-1', is_active: true }]
  });
  const supabase = createInMemorySupabase(tables);
  const created = await job.runOnce(supabase, '2026-08-15', false);
  assert.equal(created.created, 1);
  assert.equal(supabase.__tables.notifications.length, 1);
  assert.equal(supabase.__tables.notifications[0].category, 'rent_due');
});

test('runOnce: running twice on the same day creates no duplicate notifications', async () => {
  const tables = baseTables({
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 10000, due_day: 20, paid_by: 'tenant', active: true }],
    payments: [{ obligation_id: 'ob1', period: '2026-07-01', status: 'paid' }],
    tenants: [{ id: 't1', property_id: 'p1', user_id: 'owner-1', login_user_id: 'tenant-user-1', is_active: true }]
  });
  const supabase = createInMemorySupabase(tables);
  const firstRun = await job.runOnce(supabase, '2026-08-15', false);
  const secondRun = await job.runOnce(supabase, '2026-08-15', false);
  assert.equal(firstRun.created, 1);
  assert.equal(secondRun.created, 0); // second run: everything already exists, dedupe blocks it
  assert.equal(supabase.__tables.notifications.length, 1); // still exactly one row total
});

test('runOnce: a payment recorded between two runs suppresses the second run and invalidates the first row', async () => {
  const tables = baseTables({
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 10000, due_day: 20, paid_by: 'tenant', active: true }],
    payments: [{ obligation_id: 'ob1', period: '2026-07-01', status: 'paid' }],
    tenants: [{ id: 't1', property_id: 'p1', user_id: 'owner-1', login_user_id: 'tenant-user-1', is_active: true }]
  });
  const supabase = createInMemorySupabase(tables);
  await job.runOnce(supabase, '2026-08-15', false); // generates the -5-day reminder
  assert.equal(supabase.__tables.notifications.filter(n => n.status !== 'invalidated').length, 1);

  // Tenant pays before the next offset's run.
  supabase.__tables.payments.push({ id: 'pay1', obligation_id: 'ob1', period: '2026-08-01', status: 'paid' });

  const secondRun = await job.runOnce(supabase, '2026-08-18', false); // would be the -2-day reminder
  assert.equal(secondRun.created, 0); // no new reminder generated once paid
  const rows = supabase.__tables.notifications;
  assert.equal(rows.filter(n => n.status === 'invalidated').length, 1); // the earlier one is invalidated
  assert.equal(rows.find(n => n.status === 'invalidated').invalidation_reason, 'obligation_paid');
});

test('runOnce: an inactive tenant stops receiving rent_due and their existing row is invalidated', async () => {
  const tables = baseTables({
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 10000, due_day: 20, paid_by: 'tenant', active: true }],
    payments: [{ obligation_id: 'ob1', period: '2026-07-01', status: 'paid' }],
    tenants: [{ id: 't1', property_id: 'p1', user_id: 'owner-1', login_user_id: 'tenant-user-1', is_active: true }]
  });
  const supabase = createInMemorySupabase(tables);
  await job.runOnce(supabase, '2026-08-15', false);
  assert.equal(supabase.__tables.notifications.filter(n => n.status === 'unread').length, 1);

  // Tenant moves out / becomes inactive.
  supabase.__tables.tenants[0].is_active = false;

  await job.runOnce(supabase, '2026-08-18', false);
  const rows = supabase.__tables.notifications;
  assert.equal(rows.find(n => n.status === 'invalidated').invalidation_reason, 'tenancy_inactive');
  // And no new rent_due row was created for this now-inactive tenant.
  assert.equal(rows.filter(n => n.category === 'rent_due' && n.status === 'unread').length, 0);
});

test('runOnce: a warranty_end edit invalidates the old-dated reminder and makes the new date eligible', async () => {
  const tables = baseTables({
    appliances: [{ id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-08-22', condition_status: 'working' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }]
  });
  const supabase = createInMemorySupabase(tables);
  // today aligned with the EARLIEST ladder slot (2_months before 2026-08-22
  // = 2026-06-22) so exactly one row is created here, keeping this test
  // focused on the date-change/invalidation behavior rather than catch-up
  // (catch-up itself is covered separately in reminders.test.js/runOnce
  // catch-up tests below).
  await job.runOnce(supabase, '2026-06-22', false);
  assert.equal(supabase.__tables.notifications.filter(n => n.status === 'unread').length, 1);
  assert.equal(supabase.__tables.notifications[0].event_date, '2026-08-22');

  // Owner edits the warranty date.
  supabase.__tables.appliances[0].warranty_end = '2026-09-10';

  // Same day, re-run: old-dated row invalidated, no new insert yet (2_months
  // before the NEW date, 2026-07-10, is still in the future relative to today).
  await job.runOnce(supabase, '2026-06-22', false);
  const rows = supabase.__tables.notifications;
  assert.equal(rows.find(n => n.event_date === '2026-08-22').status, 'invalidated');
  assert.equal(rows.find(n => n.event_date === '2026-08-22').invalidation_reason, 'source_date_changed');

  // 2_months before the NEW date -> fresh eligible row, exactly one.
  const created = await job.runOnce(supabase, '2026-07-10', false);
  assert.equal(created.created, 1);
  assert.ok(supabase.__tables.notifications.some(n => n.event_date === '2026-09-10' && n.status === 'unread'));
});

test('runOnce: urgent maintenance resolving invalidates its open reminder', async () => {
  const tables = baseTables({
    maintenance_costs: [{ id: 'mc1', property_id: 'p1', user_id: 'owner-1', description: 'Leak', urgency: 'high', request_status: 'reported', cost_date: '2026-08-10' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }]
  });
  const supabase = createInMemorySupabase(tables);
  await job.runOnce(supabase, '2026-08-15', false);
  assert.equal(supabase.__tables.notifications.filter(n => n.status === 'unread').length, 1);

  supabase.__tables.maintenance_costs[0].request_status = 'resolved';
  await job.runOnce(supabase, '2026-08-16', false);
  const rows = supabase.__tables.notifications;
  assert.equal(rows.find(n => n.category === 'maintenance_urgent').status, 'invalidated');
  assert.equal(rows.find(n => n.category === 'maintenance_urgent').invalidation_reason, 'maintenance_resolved');
});

test('runOnce: applying a pending settlement invalidates its reminder', async () => {
  const tables = baseTables({
    rent_credits: [{ id: 'rc1', property_id: 'p1', user_id: 'owner-1', type: 'reimbursement', amount: 500, status: 'pending', created_at: '2026-08-10T00:00:00Z' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }]
  });
  const supabase = createInMemorySupabase(tables);
  await job.runOnce(supabase, '2026-08-15', false);
  assert.equal(supabase.__tables.notifications.filter(n => n.status === 'unread').length, 1);

  supabase.__tables.rent_credits[0].status = 'applied';
  await job.runOnce(supabase, '2026-08-16', false);
  const rows = supabase.__tables.notifications;
  assert.equal(rows.find(n => n.category === 'settlement_pending').status, 'invalidated');
  assert.equal(rows.find(n => n.category === 'settlement_pending').invalidation_reason, 'settlement_applied');
});

test('runOnce: an elapsed snooze is reopened at the start of the run, then re-invalidated if its source resolved meanwhile', async () => {
  const tables = baseTables({
    maintenance_costs: [{ id: 'mc1', property_id: 'p1', user_id: 'owner-1', description: 'Leak', urgency: 'high', request_status: 'resolved', cost_date: '2026-08-10' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }],
    notifications: [{
      id: 'n1', recipient_user_id: 'owner-1', recipient_role: 'owner', property_id: 'p1',
      category: 'maintenance_urgent', source_type: 'maintenance_cost', source_id: 'mc1',
      event_date: '2026-08-10', offset_label: 'open', trigger_offset_days: 0, scheduled_for: '2026-08-10',
      dedupe_key: 'maintenance_urgent:maintenance_cost:mc1:open:2026-08-10:owner-1',
      title: 'x', body: 'x', status: 'snoozed', snoozed_until: '2026-08-14'
    }]
  });
  const supabase = createInMemorySupabase(tables);
  await job.runOnce(supabase, '2026-08-15', false); // snoozed_until has elapsed
  const row = supabase.__tables.notifications.find(n => n.id === 'n1');
  // Reopened to unread first, then immediately invalidated in the same run
  // because the maintenance record is already resolved.
  assert.equal(row.status, 'invalidated');
  assert.equal(row.invalidation_reason, 'maintenance_resolved');
  assert.equal(row.snoozed_until, null);
});

// ---- Missed-run catch-up (job level, explicitly required) ----

test('catch-up: a one-day missed run still creates the reminder the next day, without re-creating earlier slots', async () => {
  const tables = baseTables({
    appliances: [{ id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-10-16', condition_status: 'working' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }],
    // Simulates a job that ran normally every day up through the 15_days
    // slot -- those three rows already exist -- then missed exactly one
    // day: 2026-10-09, the 7_days slot's exact date.
    notifications: ['2_months', '1_month', '15_days'].map((label, i) => ({
      id: `existing-${i}`, recipient_user_id: 'owner-1', recipient_role: 'owner', property_id: 'p1',
      category: 'warranty_expiry', source_type: 'appliance', source_id: 'a1',
      event_date: '2026-10-16', offset_label: label, trigger_offset_days: -1, scheduled_for: '2026-10-01',
      dedupe_key: `warranty_expiry:appliance:a1:${label}:2026-10-16:owner-1`,
      title: 'x', body: 'x', status: 'unread'
    }))
  });
  const supabase = createInMemorySupabase(tables);
  // The job resumes one day late, on 2026-10-10 (missed running on 10-09,
  // the 7_days slot's exact date).
  const created = await job.runOnce(supabase, '2026-10-10', false);
  assert.equal(created.created, 1);
  assert.equal(supabase.__tables.notifications.length, 4); // 3 pre-existing + exactly 1 new
  const newRow = supabase.__tables.notifications.find(n => n.id !== undefined && !n.id.startsWith('existing-'));
  assert.equal(newRow.offset_label, '7_days');
  assert.equal(newRow.status, 'unread');
});

test('catch-up: a multi-day missed run creates every missed warranty/agreement slot in one pass', async () => {
  const tables = baseTables({
    appliances: [{ id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-10-16', condition_status: 'working' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }]
  });
  const supabase = createInMemorySupabase(tables);
  // The job was down from before 2_months(Aug16) all the way through
  // 15_days(Oct1) and only resumes on 1_month's slot... resuming even
  // later, on 2026-10-05: 2_months(Aug16), 1_month(Sep16), and
  // 15_days(Oct1) have all elapsed; 7_days(Oct9) has not yet.
  const created = await job.runOnce(supabase, '2026-10-05', false);
  assert.equal(created.created, 3);
  const labels = supabase.__tables.notifications.map(n => n.offset_label).sort();
  assert.deepEqual(labels, ['15_days', '1_month', '2_months']);
});

test('catch-up: running again the same day after catch-up creates no duplicate rows', async () => {
  const tables = baseTables({
    appliances: [{ id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-10-16', condition_status: 'working' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }]
  });
  const supabase = createInMemorySupabase(tables);
  const firstRun = await job.runOnce(supabase, '2026-10-05', false);
  const secondRun = await job.runOnce(supabase, '2026-10-05', false);
  assert.equal(firstRun.created, 3);
  assert.equal(secondRun.created, 0);
  assert.equal(supabase.__tables.notifications.length, 3); // still exactly three rows total
});

test('catch-up: a retry after partial success completes only the missing rows, never duplicates the one that already succeeded', async () => {
  const tables = baseTables({
    appliances: [{ id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-10-16', condition_status: 'working' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }],
    // Simulates a prior run that inserted the 2_months row and then crashed
    // (e.g. process killed) before reaching 1_month/15_days -- exactly the
    // dedupe_key a real prior partial insert would have produced.
    notifications: [{
      id: 'existing', recipient_user_id: 'owner-1', recipient_role: 'owner', property_id: 'p1',
      category: 'warranty_expiry', source_type: 'appliance', source_id: 'a1',
      event_date: '2026-10-16', offset_label: '2_months', trigger_offset_days: -61, scheduled_for: '2026-08-16',
      dedupe_key: 'warranty_expiry:appliance:a1:2_months:2026-10-16:owner-1',
      title: 'x', body: 'x', status: 'unread'
    }]
  });
  const supabase = createInMemorySupabase(tables);
  const created = await job.runOnce(supabase, '2026-10-05', false);
  assert.equal(created.created, 2); // only 1_month + 15_days -- 2_months already existed
  assert.equal(supabase.__tables.notifications.length, 3); // 1 pre-existing + 2 new, never 4
  assert.equal(supabase.__tables.notifications.filter(n => n.offset_label === '2_months').length, 1); // never duplicated
});

test('catch-up: no stale warranty reminder is created once already expired, even resuming long after', async () => {
  const tables = baseTables({
    appliances: [{ id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-10-16', condition_status: 'working' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }]
  });
  const supabase = createInMemorySupabase(tables);
  const created = await job.runOnce(supabase, '2027-01-01', false); // months after expiry
  assert.equal(created.created, 0);
  assert.equal(supabase.__tables.notifications.length, 0);
});

test('catch-up: a paid rent obligation suppresses every missed advance reminder, not just the current one', async () => {
  const tables = baseTables({
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 10000, due_day: 20, paid_by: 'tenant', active: true }],
    payments: [
      { obligation_id: 'ob1', period: '2026-07-01', status: 'paid' },
      { obligation_id: 'ob1', period: '2026-08-01', status: 'paid' } // August already paid before the job ever caught up
    ],
    tenants: [{ id: 't1', property_id: 'p1', user_id: 'owner-1', login_user_id: 'tenant-user-1', is_active: true }]
  });
  const supabase = createInMemorySupabase(tables);
  // Resuming right on the due date, where 5d/2d/due-date would all
  // otherwise be eligible for catch-up.
  const created = await job.runOnce(supabase, '2026-08-20', false);
  assert.equal(created.created, 0);
  assert.equal(supabase.__tables.notifications.length, 0);
});

// ---- main(): full lifecycle, driven via the injectedSupabase test seam --
// no real Supabase client is ever constructed in any test below (main()
// only calls createClient when no argument is passed; every test here
// passes an in-memory mock instead). exitCode is saved/restored around each
// call since main() sets a real process.exitCode as a side effect. ----

async function withSavedExitCode(fn) {
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
    return process.exitCode;
  } finally {
    process.exitCode = saved;
  }
}

test('main: full success lifecycle -- running -> success with finished_at/notifications_created, exit code 0', async () => {
  // maintenance_urgent is an "open" category (not scheduled_for-gated), so
  // this deterministically creates exactly one notification regardless of
  // whatever the real current date happens to be when this test runs.
  const tables = baseTables({
    maintenance_costs: [{ id: 'mc1', property_id: 'p1', user_id: 'owner-1', description: 'Leak', urgency: 'high', request_status: 'reported', cost_date: '2026-08-01' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }]
  });
  const supabase = createInMemorySupabase(tables);

  const exitCode = await withSavedExitCode(() => job.main(supabase));
  assert.equal(exitCode, 0);

  const runs = supabase.__tables.reminder_job_runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'success');
  assert.ok(runs[0].finished_at);
  assert.equal(runs[0].notifications_created, 1);
  assert.equal(supabase.__tables.notifications.length, 1);
});

test('main: generation failure -- running -> failed with finished_at/bounded error_message, exit code 1', async () => {
  const tables = baseTables({});
  // reopenElapsedSnoozes (the very first write runOnce makes) is an UPDATE
  // on notifications -- failing it deterministically fails generation
  // itself, before any insert/invalidate logic runs.
  const supabase = createInMemorySupabase(tables, {
    errorTriggers: [{ table: 'notifications', mode: 'update', message: 'simulated generation failure' }]
  });

  const exitCode = await withSavedExitCode(() => job.main(supabase));
  assert.equal(exitCode, 1);

  const runs = supabase.__tables.reminder_job_runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.ok(runs[0].finished_at);
  assert.match(runs[0].error_message, /simulated generation failure/);
  assert.ok(runs[0].error_message.length <= 2000);
});

test('main: initial reminder_job_runs insert failure -- generation never runs, exit code 1', async () => {
  const tables = baseTables({
    maintenance_costs: [{ id: 'mc1', property_id: 'p1', user_id: 'owner-1', description: 'Leak', urgency: 'high', request_status: 'reported', cost_date: '2026-08-01' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }]
  });
  const supabase = createInMemorySupabase(tables, {
    errorTriggers: [{ table: 'reminder_job_runs', mode: 'insert', message: 'simulated insert failure' }]
  });

  const exitCode = await withSavedExitCode(() => job.main(supabase));
  assert.equal(exitCode, 1);

  // Generation never ran at all -- runOnce is never reached.
  assert.equal(supabase.__tables.notifications.length, 0);
  // The failed insert attempt leaves no row (an erroring INSERT creates nothing).
  assert.equal(supabase.__tables.reminder_job_runs.length, 0);
});

test('main: final success-log update failure -- exit code 1 even though generation itself completed, job-run row stays at running (never falsely marked success)', async () => {
  const tables = baseTables({
    maintenance_costs: [{ id: 'mc1', property_id: 'p1', user_id: 'owner-1', description: 'Leak', urgency: 'high', request_status: 'reported', cost_date: '2026-08-01' }],
    properties: [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', deleted_at: null }]
  });
  // Only the reminder_job_runs UPDATE fails (the final success-log write) --
  // the earlier reminder_job_runs INSERT and all notifications-table writes
  // succeed normally.
  const supabase = createInMemorySupabase(tables, {
    errorTriggers: [{ table: 'reminder_job_runs', mode: 'update', message: 'simulated final-log failure' }]
  });

  const exitCode = await withSavedExitCode(() => job.main(supabase));
  assert.equal(exitCode, 1);

  const runs = supabase.__tables.reminder_job_runs;
  assert.equal(runs.length, 1);
  // The audit update failed, so the row is stuck at its original 'running'
  // state -- never flipped to 'success', even though generation itself
  // completed (proven by the notification actually existing below). This is
  // the exact "do not report success when the audit write failed" case.
  assert.equal(runs[0].status, 'running');
  assert.equal(supabase.__tables.notifications.length, 1);
});

// ---- main(): credential handling ----

test('main: refuses to run and sets a failing exit code when SUPABASE_SERVICE_ROLE_KEY is absent', async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedExitCode = process.exitCode;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.exitCode = undefined;
  try {
    await job.main();
    assert.equal(process.exitCode, 1);
  } finally {
    if (savedUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    process.exitCode = savedExitCode;
  }
});
