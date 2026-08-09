// Unit tests for reminders.js (pure logic only, no I/O). Run with:
// node --test test/reminders.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const r = require('../reminders');

// ---- Dedupe key ----

test('buildDedupeKey: deterministic and includes every identity field', () => {
  const args = { category: 'warranty_expiry', source_type: 'appliance', source_id: 'app-1', offset_label: '2_months', event_date: '2026-10-31', recipient_user_id: 'owner-1' };
  assert.equal(r.buildDedupeKey(args), 'warranty_expiry:appliance:app-1:2_months:2026-10-31:owner-1');
  assert.equal(r.buildDedupeKey(args), r.buildDedupeKey({ ...args })); // stable across calls
});

test('buildDedupeKey: changing event_date changes the key (new-date eligibility)', () => {
  const base = { category: 'warranty_expiry', source_type: 'appliance', source_id: 'app-1', offset_label: '2_months', recipient_user_id: 'owner-1' };
  const k1 = r.buildDedupeKey({ ...base, event_date: '2026-10-31' });
  const k2 = r.buildDedupeKey({ ...base, event_date: '2026-11-30' });
  assert.notEqual(k1, k2);
});

test('buildDedupeKey: different recipients produce different keys (fan-out)', () => {
  const base = { category: 'rent_due', source_type: 'obligation', source_id: 'ob-1', offset_label: '5_days_before', event_date: '2026-08-15' };
  const k1 = r.buildDedupeKey({ ...base, recipient_user_id: 'tenant-1' });
  const k2 = r.buildDedupeKey({ ...base, recipient_user_id: 'tenant-2' });
  assert.notEqual(k1, k2);
});

// ---- Offset ladders ----

test('computeMonthOrDayLadder: warranty/agreement ladder matches the approved four offsets', () => {
  const offsets = r.computeMonthOrDayLadder('2026-10-31', r.WARRANTY_AGREEMENT_LADDER);
  assert.deepEqual(offsets.map(o => o.offset_label), ['2_months', '1_month', '15_days', '7_days']);
  assert.equal(offsets[0].scheduled_for, '2026-08-31');
  assert.equal(offsets[1].scheduled_for, '2026-09-30'); // Sept has 30 days -- clamped
  assert.equal(offsets[2].scheduled_for, '2026-10-16');
  assert.equal(offsets[3].scheduled_for, '2026-10-24');
  // trigger_offset_days is always negative here (before the event) and is
  // the RESULT of the calendar computation, not a fixed constant.
  for (const o of offsets) assert.ok(o.trigger_offset_days < 0);
});

test('computeDayLadder: rent_due (before) and rent_overdue (after) signed correctly', () => {
  const due = r.computeDayLadder('2026-08-15', r.RENT_DUE_LADDER, -1);
  assert.deepEqual(due.map(o => o.offset_label), ['5_days_before', '2_days_before', 'due_date']);
  assert.deepEqual(due.map(o => o.trigger_offset_days), [-5, -2, 0]);
  assert.equal(due[0].scheduled_for, '2026-08-10');
  assert.equal(due[2].scheduled_for, '2026-08-15');

  const overdue = r.computeDayLadder('2026-08-15', r.RENT_OVERDUE_LADDER, 1);
  assert.deepEqual(overdue.map(o => o.trigger_offset_days), [1, 3, 7, 15]);
  assert.equal(overdue[0].scheduled_for, '2026-08-16');
  assert.equal(overdue[3].scheduled_for, '2026-08-30');
});

// ---- computeDueStatus: must match the pre-existing /dues logic exactly ----

test('computeDueStatus: paid, pending_confirmation, due, overdue -- same four states as before', () => {
  const today = '2026-08-15';
  assert.equal(r.computeDueStatus({ obligationId: 'o1', payments: [{ obligation_id: 'o1', status: 'paid' }], dueDate: '2026-08-10', today }).status, 'paid');
  assert.equal(r.computeDueStatus({ obligationId: 'o1', payments: [{ obligation_id: 'o1', status: 'pending' }], dueDate: '2026-08-10', today }).status, 'pending_confirmation');
  assert.equal(r.computeDueStatus({ obligationId: 'o1', payments: [], dueDate: '2026-08-20', today }).status, 'due');
  assert.equal(r.computeDueStatus({ obligationId: 'o1', payments: [], dueDate: '2026-08-10', today }).status, 'overdue');
});

test('computeDueStatus: a rejected payment is ignored, same as /dues', () => {
  const today = '2026-08-15';
  const status = r.computeDueStatus({ obligationId: 'o1', payments: [{ obligation_id: 'o1', status: 'rejected' }], dueDate: '2026-08-10', today }).status;
  assert.equal(status, 'overdue'); // falls through to the overdue check, exactly like /dues
});

test('dueStatusWarrantsReminder: only due/overdue warrant a reminder', () => {
  assert.equal(r.dueStatusWarrantsReminder('due'), true);
  assert.equal(r.dueStatusWarrantsReminder('overdue'), true);
  assert.equal(r.dueStatusWarrantsReminder('paid'), false);
  assert.equal(r.dueStatusWarrantsReminder('pending_confirmation'), false);
});

// ---- Single-period resolution (replaces the old 3-candidate-month scan) ----

test('currentOrUpcomingDueDate: rolls forward to next month once this month\'s date has passed', () => {
  assert.deepEqual(r.currentOrUpcomingDueDate(3, '2026-08-20'), { event_date: '2026-09-03', period: '2026-09-01' });
});

test('currentOrUpcomingDueDate: stays in the current month while its date is still ahead', () => {
  assert.deepEqual(r.currentOrUpcomingDueDate(20, '2026-08-15'), { event_date: '2026-08-20', period: '2026-08-01' });
});

test('currentOrUpcomingDueDate: the due date itself counts as "not yet passed"', () => {
  assert.deepEqual(r.currentOrUpcomingDueDate(20, '2026-08-20'), { event_date: '2026-08-20', period: '2026-08-01' });
});

test('mostRecentPastDueDate: falls back to last month while this month\'s date is still ahead', () => {
  assert.deepEqual(r.mostRecentPastDueDate(20, '2026-08-05'), { event_date: '2026-07-20', period: '2026-07-01' });
});

test('mostRecentPastDueDate: stays in the current month once its date has passed', () => {
  assert.deepEqual(r.mostRecentPastDueDate(5, '2026-08-08'), { event_date: '2026-08-05', period: '2026-08-01' });
});

// ---- Eligibility predicates ----

test('isApplianceWarrantyEligible', () => {
  assert.equal(r.isApplianceWarrantyEligible({ warranty_end: '2026-10-31', condition_status: 'working' }), true);
  assert.equal(r.isApplianceWarrantyEligible({ warranty_end: '2026-10-31', condition_status: 'replaced' }), false);
  assert.equal(r.isApplianceWarrantyEligible({ warranty_end: '2026-10-31', condition_status: 'removed' }), false);
  assert.equal(r.isApplianceWarrantyEligible({ warranty_end: null, condition_status: 'working' }), false);
});

test('isPropertyAgreementEligible', () => {
  assert.equal(r.isPropertyAgreementEligible({ deleted_at: null, agreement_start_date: '2026-01-01' }), true);
  assert.equal(r.isPropertyAgreementEligible({ deleted_at: '2026-05-01T00:00:00Z', agreement_start_date: '2026-01-01' }), false);
  assert.equal(r.isPropertyAgreementEligible({ deleted_at: null, agreement_start_date: null }), false);
});

test('computeAgreementEndDate: defaults to 11 months when agreement_months is null', () => {
  assert.equal(r.computeAgreementEndDate({ agreement_start_date: '2026-01-15', agreement_months: null }), '2026-12-15');
  assert.equal(r.computeAgreementEndDate({ agreement_start_date: '2026-01-15', agreement_months: 6 }), '2026-07-15');
});

test('isMaintenanceUrgentEligible: high urgency AND non-terminal only', () => {
  assert.equal(r.isMaintenanceUrgentEligible({ urgency: 'high', request_status: 'reported' }), true);
  assert.equal(r.isMaintenanceUrgentEligible({ urgency: 'high', request_status: 'in_progress' }), true);
  assert.equal(r.isMaintenanceUrgentEligible({ urgency: 'high', request_status: 'resolved' }), false);
  assert.equal(r.isMaintenanceUrgentEligible({ urgency: 'high', request_status: 'rejected' }), false);
  assert.equal(r.isMaintenanceUrgentEligible({ urgency: 'normal', request_status: 'reported' }), false);
});

test('isSettlementPendingEligible', () => {
  assert.equal(r.isSettlementPendingEligible({ status: 'pending' }), true);
  assert.equal(r.isSettlementPendingEligible({ status: 'applied' }), false);
  assert.equal(r.isSettlementPendingEligible({ status: 'cancelled' }), false);
});

// ---- Generators: warranty_expiry ----

test('generateWarrantyExpiry: on-schedule day fires exactly the one offset whose slot arrived, skips replaced/removed and soft-deleted properties', () => {
  const appliances = [
    // warranty_end=2026-10-16 -> 2_months=Aug16, 1_month=Sep16, 15_days=Oct1, 7_days=Oct9.
    // today=Aug16 is exactly the earliest (2_months) slot -- none of the
    // later slots have arrived yet, so exactly one offset fires.
    { id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-10-16', condition_status: 'working' },
    { id: 'a2', property_id: 'p1', user_id: 'owner-1', name: 'AC', warranty_end: '2026-12-01', condition_status: 'replaced' },
    { id: 'a3', property_id: 'p2', user_id: 'owner-1', name: 'Fridge', warranty_end: '2026-10-16', condition_status: 'working' } // property p2 soft-deleted
  ];
  const activePropertyIds = new Set(['p1']);
  const todayISO = '2026-08-16';
  const { toInsert, toInvalidate } = r.generateWarrantyExpiry({ appliances, activePropertyIds, todayISO });
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].source_id, 'a1');
  assert.equal(toInsert[0].offset_label, '2_months');
  assert.equal(toInsert[0].recipient_role, 'owner');
  assert.equal(toInsert[0].recipient_user_id, 'owner-1');
  // a2 (replaced) generates an invalidate-all instruction, not an insert.
  assert.ok(toInvalidate.some(i => i.source_id === 'a2' && !i.excludeEventDate));
  // a3 (soft-deleted property) is skipped entirely -- no insert, no invalidate instruction.
  assert.equal(toInvalidate.some(i => i.source_id === 'a3'), false);
});

test('generateWarrantyExpiry: catch-up -- a run days after the first slot arrives creates every slot whose moment has passed', () => {
  // Same appliance as above, but today is now Sep20 -- 2_months(Aug16) AND
  // 1_month(Sep16) have both already arrived; 15_days/7_days have not.
  const appliances = [{ id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-10-16', condition_status: 'working' }];
  const { toInsert } = r.generateWarrantyExpiry({ appliances, activePropertyIds: new Set(['p1']), todayISO: '2026-09-20' });
  assert.deepEqual(toInsert.map(n => n.offset_label).sort(), ['1_month', '2_months']);
});

test('generateWarrantyExpiry: no insert when no slot has arrived yet', () => {
  const appliances = [{ id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-10-16', condition_status: 'working' }];
  const { toInsert } = r.generateWarrantyExpiry({ appliances, activePropertyIds: new Set(['p1']), todayISO: '2026-08-01' });
  assert.equal(toInsert.length, 0);
});

test('generateWarrantyExpiry: no reminder slots at all once already expired (no stale post-expiry catch-up)', () => {
  const appliances = [{ id: 'a1', property_id: 'p1', user_id: 'owner-1', name: 'Geyser', warranty_end: '2026-10-16', condition_status: 'working' }];
  // A run resuming well after the warranty already lapsed -- every offset's
  // scheduled_for is in the past, but none should fire retroactively.
  const { toInsert, toInvalidate } = r.generateWarrantyExpiry({ appliances, activePropertyIds: new Set(['p1']), todayISO: '2026-11-01' });
  assert.equal(toInsert.length, 0);
  // The standard "invalidate a stale event_date" instruction is still
  // emitted (unconditional for every eligible appliance, guards against a
  // warranty_end edit) -- it's the LADDER loop, not this instruction, that
  // stops producing anything once expired.
  assert.equal(toInvalidate.length, 1);
  assert.equal(toInvalidate[0].excludeEventDate, '2026-10-16');
});

// ---- Generators: agreement_renewal ----

test('generateAgreementRenewal: computes end date and matches the earliest ladder slot on its exact day', () => {
  const properties = [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', agreement_start_date: '2026-01-15', agreement_months: 11, deleted_at: null }];
  // end date = 2026-12-15; 2_months before = 2026-10-15 (the earliest slot,
  // so it's the only one eligible on that exact day).
  const { toInsert } = r.generateAgreementRenewal({ properties, todayISO: '2026-10-15' });
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].offset_label, '2_months');
  assert.equal(toInsert[0].event_date, '2026-12-15');
  assert.equal(toInsert[0].recipient_role, 'owner');
});

test('generateAgreementRenewal: catch-up creates every slot whose moment has passed, none after expiry', () => {
  const properties = [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', agreement_start_date: '2026-01-15', agreement_months: 11, deleted_at: null }];
  // end date = 2026-12-15. Resuming on 2026-11-15: 2_months(Oct15) and
  // 1_month(Nov15) have both arrived; 15_days/7_days have not.
  const { toInsert } = r.generateAgreementRenewal({ properties, todayISO: '2026-11-15' });
  assert.deepEqual(toInsert.map(n => n.offset_label).sort(), ['1_month', '2_months']);

  // Resuming well after expiry: nothing fires retroactively.
  const afterExpiry = r.generateAgreementRenewal({ properties, todayISO: '2027-01-10' });
  assert.equal(afterExpiry.toInsert.length, 0);
});

test('generateAgreementRenewal: skips soft-deleted properties and invalidates ineligible ones', () => {
  const properties = [{ id: 'p1', user_id: 'owner-1', property_name: 'Flat 3B', agreement_start_date: '2026-01-15', agreement_months: 11, deleted_at: '2026-06-01T00:00:00Z' }];
  const { toInsert, toInvalidate } = r.generateAgreementRenewal({ properties, todayISO: '2026-11-15' });
  assert.equal(toInsert.length, 0);
  assert.ok(toInvalidate.some(i => i.source_id === 'p1' && i.reason === 'source_date_changed'));
});

// ---- Generators: rent_due (fan-out + suppression) ----

test('generateRentDue: fans out one notification per active, logged-in tenant', () => {
  const obligations = [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 15000, due_day: 20, paid_by: 'tenant' }];
  const tenantsByPropertyId = new Map([['p1', [
    { id: 't1', property_id: 'p1', login_user_id: 'tenant-user-1', is_active: true },
    { id: 't2', property_id: 'p1', login_user_id: 'tenant-user-2', is_active: true }
  ]]]);
  const paymentsByObligationId = new Map(); // no payments -- unpaid
  const todayISO = '2026-08-15'; // 5_days_before due_day=20
  const { toInsert } = r.generateRentDue({ obligations, tenantsByPropertyId, paymentsByObligationId, todayISO });
  assert.equal(toInsert.length, 2);
  const recipients = toInsert.map(n => n.recipient_user_id).sort();
  assert.deepEqual(recipients, ['tenant-user-1', 'tenant-user-2']);
  for (const n of toInsert) {
    assert.equal(n.recipient_role, 'tenant');
    assert.equal(n.offset_label, '5_days_before');
  }
});

test('generateRentDue: suppressed entirely when already paid, invalidation instruction emitted', () => {
  const obligations = [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 15000, due_day: 20, paid_by: 'tenant' }];
  const tenantsByPropertyId = new Map([['p1', [{ id: 't1', property_id: 'p1', login_user_id: 'tenant-user-1', is_active: true }]]]);
  const paymentsByObligationId = new Map([['ob1', [{ obligation_id: 'ob1', period: '2026-08-01', status: 'paid' }]]]);
  const todayISO = '2026-08-15';
  const { toInsert, toInvalidate } = r.generateRentDue({ obligations, tenantsByPropertyId, paymentsByObligationId, todayISO });
  assert.equal(toInsert.length, 0);
  assert.ok(toInvalidate.some(i => i.source_id === 'ob1' && i.category === 'rent_due' && i.event_date === '2026-08-20' && i.reason === 'obligation_paid'));
});

test('generateRentDue: pending_confirmation also suppresses (tenant already acted)', () => {
  const obligations = [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 15000, due_day: 20, paid_by: 'tenant' }];
  const tenantsByPropertyId = new Map([['p1', [{ id: 't1', property_id: 'p1', login_user_id: 'tenant-user-1', is_active: true }]]]);
  const paymentsByObligationId = new Map([['ob1', [{ obligation_id: 'ob1', period: '2026-08-01', status: 'pending' }]]]);
  const { toInsert } = r.generateRentDue({ obligations, tenantsByPropertyId, paymentsByObligationId, todayISO: '2026-08-15' });
  assert.equal(toInsert.length, 0);
});

test('generateRentDue: catch-up creates every missed advance offset in one run when unpaid', () => {
  const obligations = [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 15000, due_day: 20, paid_by: 'tenant' }];
  const tenantsByPropertyId = new Map([['p1', [{ id: 't1', property_id: 'p1', login_user_id: 'tenant-user-1', is_active: true }]]]);
  const paymentsByObligationId = new Map();
  // Resuming on the due date itself: 5_days_before(Aug15), 2_days_before(Aug18), due_date(Aug20) all eligible.
  const { toInsert } = r.generateRentDue({ obligations, tenantsByPropertyId, paymentsByObligationId, todayISO: '2026-08-20' });
  assert.deepEqual(toInsert.map(n => n.offset_label).sort(), ['2_days_before', '5_days_before', 'due_date']);
});

test('generateRentDue: paid suppresses catch-up entirely -- zero rows even though every offset would otherwise be eligible', () => {
  const obligations = [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 15000, due_day: 20, paid_by: 'tenant' }];
  const tenantsByPropertyId = new Map([['p1', [{ id: 't1', property_id: 'p1', login_user_id: 'tenant-user-1', is_active: true }]]]);
  const paymentsByObligationId = new Map([['ob1', [{ obligation_id: 'ob1', period: '2026-08-01', status: 'paid' }]]]);
  const { toInsert } = r.generateRentDue({ obligations, tenantsByPropertyId, paymentsByObligationId, todayISO: '2026-08-20' });
  assert.equal(toInsert.length, 0);
});

test('generateRentDue: due date near a month boundary is correctly evaluated against an adjacent month', () => {
  // due_day=3, today=2026-08-30 -> the RELEVANT upcoming due date is
  // September 3rd (the "next month" candidate), 5-days-before = Aug 29...
  // pick a today that lines up exactly with that candidate's ladder.
  const obligations = [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 10000, due_day: 3, paid_by: 'tenant' }];
  const tenantsByPropertyId = new Map([['p1', [{ id: 't1', property_id: 'p1', login_user_id: 'tenant-user-1', is_active: true }]]]);
  const paymentsByObligationId = new Map();
  const { toInsert } = r.generateRentDue({ obligations, tenantsByPropertyId, paymentsByObligationId, todayISO: '2026-08-29' });
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].event_date, '2026-09-03');
  assert.equal(toInsert[0].offset_label, '5_days_before');
});

// ---- Generators: rent_overdue ----

test('generateRentOverdue: owner recipient, correct signed offsets', () => {
  const obligations = [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 15000, due_day: 5, paid_by: 'tenant' }];
  const propertiesById = new Map([['p1', { property_name: 'Flat 3B' }]]);
  const paymentsByObligationId = new Map();
  const todayISO = '2026-08-08'; // 3_days_overdue for due_day=5
  const { toInsert } = r.generateRentOverdue({ obligations, propertiesById, paymentsByObligationId, todayISO });
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].recipient_role, 'owner');
  assert.equal(toInsert[0].recipient_user_id, 'owner-1');
  assert.equal(toInsert[0].offset_label, '3_days_overdue');
  assert.equal(toInsert[0].trigger_offset_days, 3);
});

test('generateRentOverdue: multi-day catch-up creates only the single highest-severity eligible checkpoint, not a stack of every passed threshold', () => {
  const obligations = [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 15000, due_day: 5, paid_by: 'tenant' }];
  const propertiesById = new Map([['p1', { property_name: 'Flat 3B' }]]);
  const paymentsByObligationId = new Map();
  // due_day=5 -> 1d=Aug6, 3d=Aug8, 7d=Aug12, 15d=Aug20. Resuming on Aug14
  // (well past 1d/3d/7d, not yet at 15d) should create exactly ONE row --
  // the 7-day checkpoint -- never 1d/3d as well.
  const { toInsert } = r.generateRentOverdue({ obligations, propertiesById, paymentsByObligationId, todayISO: '2026-08-14' });
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].offset_label, '7_days_overdue');
});

test('generateRentOverdue: suppressed once paid', () => {
  const obligations = [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 15000, due_day: 5, paid_by: 'tenant' }];
  const propertiesById = new Map([['p1', { property_name: 'Flat 3B' }]]);
  const paymentsByObligationId = new Map([['ob1', [{ obligation_id: 'ob1', period: '2026-08-01', status: 'paid' }]]]);
  const { toInsert, toInvalidate } = r.generateRentOverdue({ obligations, propertiesById, paymentsByObligationId, todayISO: '2026-08-08' });
  assert.equal(toInsert.length, 0);
  assert.ok(toInvalidate.some(i => i.category === 'rent_overdue' && i.reason === 'obligation_paid'));
});

// ---- Generators: maintenance_urgent / settlement_pending ("open" categories) ----

test('generateMaintenanceUrgent: stable event_date (cost_date) keeps the same dedupe_key across days', () => {
  const costs = [{ id: 'mc1', property_id: 'p1', user_id: 'owner-1', description: 'Water leak in bathroom ceiling causing damage', urgency: 'high', request_status: 'reported', cost_date: '2026-08-01' }];
  const propertiesById = new Map([['p1', { property_name: 'Flat 3B' }]]);
  const day1 = r.generateMaintenanceUrgent({ costs, propertiesById, todayISO: '2026-08-02' });
  const day2 = r.generateMaintenanceUrgent({ costs, propertiesById, todayISO: '2026-08-05' });
  assert.equal(day1.toInsert[0].dedupe_key, day2.toInsert[0].dedupe_key);
  assert.equal(day1.toInsert[0].event_date, '2026-08-01');
  assert.equal(day1.toInsert[0].offset_label, 'open');
});

test('generateMaintenanceUrgent: resolved/rejected invalidates with the matching reason, never inserts', () => {
  const propertiesById = new Map([['p1', { property_name: 'Flat 3B' }]]);
  const resolved = r.generateMaintenanceUrgent({ costs: [{ id: 'mc1', property_id: 'p1', user_id: 'owner-1', description: 'x', urgency: 'high', request_status: 'resolved', cost_date: '2026-08-01' }], propertiesById, todayISO: '2026-08-05' });
  assert.equal(resolved.toInsert.length, 0);
  assert.ok(resolved.toInvalidate.some(i => i.reason === 'maintenance_resolved'));

  const rejected = r.generateMaintenanceUrgent({ costs: [{ id: 'mc2', property_id: 'p1', user_id: 'owner-1', description: 'x', urgency: 'high', request_status: 'rejected', cost_date: '2026-08-01' }], propertiesById, todayISO: '2026-08-05' });
  assert.equal(rejected.toInsert.length, 0);
  assert.ok(rejected.toInvalidate.some(i => i.reason === 'maintenance_rejected'));
});

test('generateSettlementPending: pending inserts, applied/cancelled invalidate with the matching reason', () => {
  const propertiesById = new Map([['p1', { property_name: 'Flat 3B' }]]);
  const pending = r.generateSettlementPending({ rentCredits: [{ id: 'rc1', property_id: 'p1', user_id: 'owner-1', type: 'reimbursement', amount: 500, status: 'pending', created_at: '2026-08-01T10:00:00Z' }], propertiesById, todayISO: '2026-08-05' });
  assert.equal(pending.toInsert.length, 1);
  assert.equal(pending.toInsert[0].event_date, '2026-08-01');

  const applied = r.generateSettlementPending({ rentCredits: [{ id: 'rc2', property_id: 'p1', user_id: 'owner-1', type: 'reimbursement', amount: 500, status: 'applied', created_at: '2026-08-01T10:00:00Z' }], propertiesById, todayISO: '2026-08-05' });
  assert.ok(applied.toInvalidate.some(i => i.reason === 'settlement_applied'));

  const cancelled = r.generateSettlementPending({ rentCredits: [{ id: 'rc3', property_id: 'p1', user_id: 'owner-1', type: 'rent_credit', amount: 500, status: 'cancelled', created_at: '2026-08-01T10:00:00Z' }], propertiesById, todayISO: '2026-08-05' });
  assert.ok(cancelled.toInvalidate.some(i => i.reason === 'settlement_cancelled'));
});

// ---- Inactive-tenant invalidation ----

test('invalidateInactiveTenantRentDue: one instruction per (obligation, inactive recipient) pair', () => {
  const instructions = r.invalidateInactiveTenantRentDue({ obligationIds: ['ob1', 'ob2'], inactiveOrUnlinkedTenantUserIds: ['tenant-user-1'] });
  assert.equal(instructions.length, 2);
  assert.ok(instructions.every(i => i.category === 'rent_due' && i.reason === 'tenancy_inactive' && i.recipient_user_id === 'tenant-user-1'));
});
