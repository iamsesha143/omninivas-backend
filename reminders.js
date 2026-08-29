// Pure reminder-generation logic (Phase 1B). No I/O, no Supabase, no
// Express -- jobs/runReminders.js fetches source rows and calls the
// functions here with plain JS data; this module only decides WHAT to
// insert/invalidate, never performs a write itself. Mirrors the existing
// maintenanceWorkflow.js separation-of-concerns convention in this repo.
const {
  addDaysISO, diffDaysISO, monthsBeforeISO, shiftMonthsISO,
  dueDateForMonth, periodForISO
} = require('./dateUtils');
const mw = require('./maintenanceWorkflow');

const CATEGORIES = [
  'warranty_expiry', 'agreement_renewal', 'rent_due', 'rent_overdue',
  'maintenance_urgent', 'settlement_pending', 'property_tax_due'
];

// ---- Dedupe identity ----
// Approved formula. property_id/title/body/deep_link deliberately excluded
// -- they can be re-derived/reworded without that counting as "a new
// reminder," only the identity fields below define uniqueness.
function buildDedupeKey({ category, source_type, source_id, offset_label, event_date, recipient_user_id }) {
  return `${category}:${source_type}:${source_id}:${offset_label}:${event_date}:${recipient_user_id}`;
}

// ---- Offset ladders ----
// warranty_expiry / agreement_renewal share this ladder: 2mo/1mo are
// calendar-month-based (monthsBeforeISO, end-of-month clamped), 15d/7d are
// direct day-based -- matching the approved spec's mixed ladder exactly.
const WARRANTY_AGREEMENT_LADDER = [
  { offset_label: '2_months', kind: 'months', amount: 2 },
  { offset_label: '1_month', kind: 'months', amount: 1 },
  { offset_label: '15_days', kind: 'days', amount: 15 },
  { offset_label: '7_days', kind: 'days', amount: 7 }
];
const RENT_DUE_LADDER = [
  { offset_label: '5_days_before', amount: 5 },
  { offset_label: '2_days_before', amount: 2 },
  { offset_label: 'due_date', amount: 0 }
];
const RENT_OVERDUE_LADDER = [
  { offset_label: '1_day_overdue', amount: 1 },
  { offset_label: '3_days_overdue', amount: 3 },
  { offset_label: '7_days_overdue', amount: 7 },
  { offset_label: '15_days_overdue', amount: 15 }
];

// trigger_offset_days is always the RESULT of the calendar computation
// (diffDaysISO(scheduled_for, event_date)), never a hardcoded constant --
// see dateUtils.monthsBeforeISO for why month-based offsets don't have a
// fixed day-count.
function computeMonthOrDayLadder(eventDate, ladder) {
  return ladder.map(({ offset_label, kind, amount }) => {
    const scheduled_for = kind === 'months' ? monthsBeforeISO(eventDate, amount) : addDaysISO(eventDate, -amount);
    return { offset_label, scheduled_for, trigger_offset_days: diffDaysISO(scheduled_for, eventDate) };
  });
}
function computeDayLadder(eventDate, ladder, sign) {
  return ladder.map(({ offset_label, amount }) => {
    const scheduled_for = addDaysISO(eventDate, sign * amount);
    // `+ 0` normalizes a -0 result (sign=-1, amount=0) to 0 -- IEEE 754
    // addition of -0 and +0 yields +0, avoiding a cosmetic -0 in stored data.
    return { offset_label, scheduled_for, trigger_offset_days: sign * amount + 0 };
  });
}

// ---- Extracted shared payment-status logic ----
// Byte-for-byte the same decision as the pre-existing inline blocks in
// GET /api/properties/:propertyId/dues and GET /api/tenant/home -- only the
// truly identical part (payment matching -> status) is extracted; each call
// site's own due-date computation is left untouched (see server.js diff /
// the accompanying report for the one pre-existing discrepancy between
// those two call sites that this refactor deliberately does NOT paper over).
// Do not change this comparison logic without updating all three callers'
// tests together.
function computeDueStatus({ obligationId, payments, dueDate, today }) {
  const payment = (payments || []).find(p => p.obligation_id === obligationId && p.status !== 'rejected') || null;
  let status = 'due';
  if (payment && payment.status === 'paid') status = 'paid';
  else if (payment) status = 'pending_confirmation';
  else if (dueDate < today) status = 'overdue';
  return { status, payment };
}

// A reminder is only warranted while nothing has happened yet -- once a
// tenant has uploaded proof (pending_confirmation) or the owner has
// confirmed it (paid), further "due"/"overdue" reminders would be wrong,
// not just redundant. This is reminder-system judgment about which of the
// four EXISTING statuses warrant notifying, not a new payment-status
// interpretation -- the four states themselves are untouched.
function dueStatusWarrantsReminder(status) {
  return status === 'due' || status === 'overdue';
}

// The single "currently applicable" period for advance (rent_due) reminders
// -- the soonest due date that has NOT yet passed. Advance reminders only
// make sense for a date that hasn't happened yet, so if this month's due
// date has already gone by, the applicable period rolls forward to next
// month rather than re-surfacing a reminder for a date that's already in
// the past (per the approved "do not create reminders for prior periods"
// rule). A recurring monthly due date is always within 31 days, so rolling
// forward at most one month is always sufficient.
function currentOrUpcomingDueDate(dueDay, todayISO) {
  const thisMonth = dueDateForMonth(todayISO, 0, dueDay);
  const event_date = thisMonth >= todayISO ? thisMonth : dueDateForMonth(todayISO, 1, dueDay);
  return { event_date, period: periodForISO(event_date) };
}

// The single "currently applicable" period for rent_overdue -- the most
// recent due date that HAS already passed. Mirrors currentOrUpcomingDueDate
// but looks backward instead of forward, since "overdue" is only ever about
// a date that's already gone by.
function mostRecentPastDueDate(dueDay, todayISO) {
  const thisMonth = dueDateForMonth(todayISO, 0, dueDay);
  const event_date = thisMonth <= todayISO ? thisMonth : dueDateForMonth(todayISO, -1, dueDay);
  return { event_date, period: periodForISO(event_date) };
}

function computeAgreementEndDate(property) {
  return shiftMonthsISO(property.agreement_start_date, property.agreement_months || 11);
}

// ---- Eligibility predicates ----
function isApplianceWarrantyEligible(appliance) {
  return !!appliance.warranty_end && !['replaced', 'removed'].includes(appliance.condition_status);
}
function isPropertyAgreementEligible(property) {
  return !property.deleted_at && !!property.agreement_start_date;
}
// Property tax is a real recurring annual event, but modeled here as a
// single date the owner updates once a year (same manual-recurrence
// pattern as the mortgage spike's loan tracking) -- simpler than building
// annual-recurrence math for something that changes once a year at most.
function isPropertyTaxEligible(property) {
  return !property.deleted_at && !!property.property_tax_due_date;
}
function isMaintenanceUrgentEligible(cost) {
  return cost.urgency === 'high' && !mw.isTerminalRequestStatus(cost.request_status);
}
function isSettlementPendingEligible(rentCredit) {
  return rentCredit.status === 'pending';
}

// ---- Copy (concise, privacy-safe -- no raw IDs, no more detail than the
// recipient could already see in-app for their own data) ----
function truncate(s, n) { return (s || '').length > n ? `${s.slice(0, n - 1)}…` : (s || ''); }

const copy = {
  warranty_expiry: (a) => ({
    title: `Warranty ending soon: ${a.name}`,
    body: `The warranty for "${a.name}" ends on ${a.warranty_end}.`
  }),
  agreement_renewal: (p, endDate) => ({
    title: `Agreement renewal: ${p.property_name}`,
    body: `The rental agreement for ${p.property_name} ends on ${endDate}.`
  }),
  property_tax_due: (p, dueDate) => ({
    title: `Property tax due: ${p.property_name}`,
    body: `Property tax for ${p.property_name} is due on ${dueDate}.`
  }),
  rent_due: (o, dueDate) => ({
    title: 'Rent due soon',
    body: o.amount ? `Your ${o.label} of ₹${Number(o.amount).toLocaleString('en-IN')} is due on ${dueDate}.` : `Your ${o.label} is due on ${dueDate}.`
  }),
  rent_overdue: (o, propertyName, daysOverdue) => ({
    title: 'Rent overdue',
    body: `${o.label} at ${propertyName} is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue.`
  }),
  maintenance_urgent: (cost, propertyName) => ({
    title: 'Urgent maintenance still open',
    body: `"${truncate(cost.description, 120)}" at ${propertyName} is still unresolved.`
  }),
  settlement_pending: (rc, propertyName) => ({
    title: 'Settlement awaiting action',
    body: `A ${rc.type === 'rent_credit' ? 'rent credit' : 'reimbursement'} of ₹${Number(rc.amount).toLocaleString('en-IN')} at ${propertyName} is pending.`
  })
};

// ---- Generators ----
// Every generator returns { toInsert, toInvalidate }. toInsert rows are
// exactly the notifications table's insertable shape (minus id/created_at).
// toInvalidate entries are instructions, not writes -- see
// jobs/runReminders.js for how each field narrows the UPDATE's WHERE
// clause: { source_type, source_id, category, reason, recipient_user_id?,
// event_date?, excludeEventDate? }.

function generateWarrantyExpiry({ appliances, activePropertyIds, todayISO }) {
  const toInsert = [], toInvalidate = [];
  for (const a of appliances) {
    if (!activePropertyIds.has(a.property_id)) continue; // soft-deleted property: skip entirely, no invalidation semantics here
    if (!isApplianceWarrantyEligible(a)) {
      toInvalidate.push({ source_type: 'appliance', source_id: a.id, category: 'warranty_expiry', reason: 'source_date_changed' });
      continue;
    }
    const eventDate = a.warranty_end;
    toInvalidate.push({ source_type: 'appliance', source_id: a.id, category: 'warranty_expiry', reason: 'source_date_changed', excludeEventDate: eventDate });
    // Missed-run catch-up: once expired, no reminder slot is ever created
    // again for this event_date (a warranty that already lapsed doesn't
    // need a "2 months before" reminder retroactively).
    if (eventDate < todayISO) continue;
    for (const { offset_label, scheduled_for, trigger_offset_days } of computeMonthOrDayLadder(eventDate, WARRANTY_AGREEMENT_LADDER)) {
      // scheduled_for <= todayISO (its moment has arrived, whether on time
      // or catching up on a missed day) && eventDate >= todayISO (not yet
      // expired, guaranteed by the guard above). The unique dedupe_key
      // makes repeated attempts across days idempotent -- this is safe to
      // re-attempt every run, not just the exact scheduled day.
      if (scheduled_for > todayISO) continue;
      const c = copy.warranty_expiry(a);
      toInsert.push({
        recipient_user_id: a.user_id, recipient_role: 'owner', property_id: a.property_id,
        category: 'warranty_expiry', source_type: 'appliance', source_id: a.id,
        event_date: eventDate, offset_label, trigger_offset_days, scheduled_for,
        dedupe_key: buildDedupeKey({ category: 'warranty_expiry', source_type: 'appliance', source_id: a.id, offset_label, event_date: eventDate, recipient_user_id: a.user_id }),
        status: 'unread',
        title: c.title, body: c.body, deep_link: 'assets'
      });
    }
  }
  return { toInsert, toInvalidate };
}

function generateAgreementRenewal({ properties, todayISO }) {
  const toInsert = [], toInvalidate = [];
  for (const p of properties) {
    if (!isPropertyAgreementEligible(p)) {
      toInvalidate.push({ source_type: 'property', source_id: p.id, category: 'agreement_renewal', reason: 'source_date_changed' });
      continue;
    }
    const eventDate = computeAgreementEndDate(p);
    toInvalidate.push({ source_type: 'property', source_id: p.id, category: 'agreement_renewal', reason: 'source_date_changed', excludeEventDate: eventDate });
    // Same missed-run catch-up / no-reminders-after-expiry rule as warranty_expiry above.
    if (eventDate < todayISO) continue;
    for (const { offset_label, scheduled_for, trigger_offset_days } of computeMonthOrDayLadder(eventDate, WARRANTY_AGREEMENT_LADDER)) {
      if (scheduled_for > todayISO) continue;
      const c = copy.agreement_renewal(p, eventDate);
      toInsert.push({
        recipient_user_id: p.user_id, recipient_role: 'owner', property_id: p.id,
        category: 'agreement_renewal', source_type: 'property', source_id: p.id,
        event_date: eventDate, offset_label, trigger_offset_days, scheduled_for,
        dedupe_key: buildDedupeKey({ category: 'agreement_renewal', source_type: 'property', source_id: p.id, offset_label, event_date: eventDate, recipient_user_id: p.user_id }),
        status: 'unread',
        title: c.title, body: c.body, deep_link: 'tenants'
      });
    }
  }
  return { toInsert, toInvalidate };
}

// Byte-for-byte the same shape as generateAgreementRenewal above -- same
// ladder, same catch-up/no-reminders-after-expiry rule -- just against
// property_tax_due_date instead of the computed agreement end date.
function generatePropertyTaxDue({ properties, todayISO }) {
  const toInsert = [], toInvalidate = [];
  for (const p of properties) {
    if (!isPropertyTaxEligible(p)) {
      toInvalidate.push({ source_type: 'property', source_id: p.id, category: 'property_tax_due', reason: 'source_date_changed' });
      continue;
    }
    const eventDate = p.property_tax_due_date;
    toInvalidate.push({ source_type: 'property', source_id: p.id, category: 'property_tax_due', reason: 'source_date_changed', excludeEventDate: eventDate });
    if (eventDate < todayISO) continue;
    for (const { offset_label, scheduled_for, trigger_offset_days } of computeMonthOrDayLadder(eventDate, WARRANTY_AGREEMENT_LADDER)) {
      if (scheduled_for > todayISO) continue;
      const c = copy.property_tax_due(p, eventDate);
      toInsert.push({
        recipient_user_id: p.user_id, recipient_role: 'owner', property_id: p.id,
        category: 'property_tax_due', source_type: 'property', source_id: p.id,
        event_date: eventDate, offset_label, trigger_offset_days, scheduled_for,
        dedupe_key: buildDedupeKey({ category: 'property_tax_due', source_type: 'property', source_id: p.id, offset_label, event_date: eventDate, recipient_user_id: p.user_id }),
        status: 'unread',
        title: c.title, body: c.body, deep_link: 'properties'
      });
    }
  }
  return { toInsert, toInvalidate };
}

// tenantsByPropertyId: Map<property_id, Array<{id, user_id (login user id), property_id, is_active, login_user_id}>>
// -- already filtered by the job to is_active=true AND login_user_id IS NOT NULL.
// paymentsByObligationId: Map<obligation_id, Array<payments row>>.
//
// Targets only the single "currently applicable" period (see
// currentOrUpcomingDueDate) -- per the approved design, rent_due never
// reaches back into prior (already-passed) periods; that's rent_overdue's
// job. Within that one period, EVERY ladder offset whose scheduled_for has
// already arrived is attempted (not just the newest) -- a missed run can
// legitimately catch up on more than one advance reminder at once here,
// unlike rent_overdue's deliberately single-checkpoint catch-up below.
function generateRentDue({ obligations, tenantsByPropertyId, paymentsByObligationId, todayISO }) {
  const toInsert = [], toInvalidate = [];
  for (const o of obligations) {
    const tenants = tenantsByPropertyId.get(o.property_id) || [];
    const { event_date, period } = currentOrUpcomingDueDate(o.due_day, todayISO);
    const { status } = computeDueStatus({ obligationId: o.id, payments: (paymentsByObligationId.get(o.id) || []).filter(p => p.period === period), dueDate: event_date, today: todayISO });
    if (!dueStatusWarrantsReminder(status)) {
      toInvalidate.push({ source_type: 'obligation', source_id: o.id, category: 'rent_due', reason: 'obligation_paid', event_date });
      continue;
    }
    for (const tenant of tenants) {
      for (const { offset_label, scheduled_for, trigger_offset_days } of computeDayLadder(event_date, RENT_DUE_LADDER, -1)) {
        // Catch-up: attempt every offset whose moment has already arrived,
        // not only an exact same-day match. event_date is always >=
        // todayISO here (guaranteed by currentOrUpcomingDueDate), so this
        // can never reach into a prior period.
        if (scheduled_for > todayISO) continue;
        const c = copy.rent_due(o, event_date);
        toInsert.push({
          recipient_user_id: tenant.login_user_id, recipient_role: 'tenant', property_id: o.property_id,
          category: 'rent_due', source_type: 'obligation', source_id: o.id,
          event_date, offset_label, trigger_offset_days, scheduled_for,
          dedupe_key: buildDedupeKey({ category: 'rent_due', source_type: 'obligation', source_id: o.id, offset_label, event_date, recipient_user_id: tenant.login_user_id }),
          status: 'unread',
          title: c.title, body: c.body, deep_link: 'bills'
        });
      }
    }
  }
  return { toInsert, toInvalidate };
}

// Targets only the single "currently applicable" (most recent past) period
// via mostRecentPastDueDate.
//
// Missed-checkpoint decision (documented per the approved design): a
// recovered run creates ONLY the highest-severity checkpoint whose
// scheduled_for has arrived, never a stack of every checkpoint passed
// through -- e.g. resuming 10 days after a due date creates
// '7_days_overdue' only, not '1_day_overdue' AND '3_days_overdue' AND
// '7_days_overdue'. This is deliberately the least-noisy choice: the owner
// gets one accurate "here's how bad it is right now" signal instead of a
// burst of superseded historical ones. In NORMAL day-by-day operation
// (no missed runs) this produces exactly the same escalating sequence as
// before -- each real calendar day, at most one NEW threshold is crossed
// (the ladder's four offsets are all distinct), so "pick the single
// highest eligible offset each run" and "pick whichever offset newly
// became true today" agree; the difference only shows up after a gap.
function generateRentOverdue({ obligations, propertiesById, paymentsByObligationId, todayISO }) {
  const toInsert = [], toInvalidate = [];
  for (const o of obligations) {
    const { event_date, period } = mostRecentPastDueDate(o.due_day, todayISO);
    const propertyName = (propertiesById.get(o.property_id) || {}).property_name || 'your property';
    const { status } = computeDueStatus({ obligationId: o.id, payments: (paymentsByObligationId.get(o.id) || []).filter(p => p.period === period), dueDate: event_date, today: todayISO });
    if (!dueStatusWarrantsReminder(status)) {
      toInvalidate.push({ source_type: 'obligation', source_id: o.id, category: 'rent_overdue', reason: 'obligation_paid', event_date });
      continue;
    }
    const eligible = computeDayLadder(event_date, RENT_OVERDUE_LADDER, 1).filter(x => x.scheduled_for <= todayISO);
    if (eligible.length === 0) continue;
    const highest = eligible[eligible.length - 1]; // RENT_OVERDUE_LADDER is defined in ascending severity order
    const c = copy.rent_overdue(o, propertyName, highest.trigger_offset_days);
    toInsert.push({
      recipient_user_id: o.user_id, recipient_role: 'owner', property_id: o.property_id,
      category: 'rent_overdue', source_type: 'obligation', source_id: o.id,
      event_date, offset_label: highest.offset_label, trigger_offset_days: highest.trigger_offset_days, scheduled_for: highest.scheduled_for,
      dedupe_key: buildDedupeKey({ category: 'rent_overdue', source_type: 'obligation', source_id: o.id, offset_label: highest.offset_label, event_date, recipient_user_id: o.user_id }),
      status: 'unread',
      title: c.title, body: c.body, deep_link: 'bills'
    });
  }
  return { toInsert, toInvalidate };
}

// "Open" categories (maintenance_urgent / settlement_pending): unconditional
// on every run, not date-gated -- creates the initial notification whenever
// the source is currently eligible and no row exists for its dedupe_key,
// regardless of how old the source record is (a maintenance record created
// long before this reminder system existed, or before a missed run, still
// gets its notification the first time the job processes it). This already
// satisfies the catch-up requirement for these two categories without any
// scheduled_for gating, since there's nothing here to "miss" a day of.
//
// KNOWN LIMITATION, not fixed in this pass: the dedupe_key is stable for
// the life of the source record (event_date doesn't change), and the
// unique index on dedupe_key doesn't distinguish an 'invalidated' row from
// an active one. If a maintenance record's urgency is toggled away from
// 'high' and back to 'high' again while request_status stays non-terminal,
// the second high-urgency period will NOT get a fresh notification -- the
// first (now invalidated) row's dedupe_key blocks it. settlement_pending
// cannot hit this at all (rent_credits.status is a closed pending->applied|
// cancelled transition, never returns to pending). This is a narrow,
// pre-existing edge case for maintenance_urgent specifically; fixing it
// would require either a partial unique index (incompatible with
// supabase-js's upsert(..., {onConflict}) without raw SQL) or an explicit
// revive-on-invalidated-row step in the job -- deferred as a deliberate
// scope decision for this pass, not silently glossed over.
function generateMaintenanceUrgent({ costs, propertiesById, todayISO }) {
  const toInsert = [], toInvalidate = [];
  for (const cost of costs) {
    if (!isMaintenanceUrgentEligible(cost)) {
      const reason = cost.request_status === 'rejected' ? 'maintenance_rejected' : 'maintenance_resolved';
      toInvalidate.push({ source_type: 'maintenance_cost', source_id: cost.id, category: 'maintenance_urgent', reason });
      continue;
    }
    const eventDate = cost.cost_date || todayISO;
    const propertyName = (propertiesById.get(cost.property_id) || {}).property_name || 'your property';
    const c = copy.maintenance_urgent(cost, propertyName);
    toInsert.push({
      recipient_user_id: cost.user_id, recipient_role: 'owner', property_id: cost.property_id,
      category: 'maintenance_urgent', source_type: 'maintenance_cost', source_id: cost.id,
      event_date: eventDate, offset_label: 'open', trigger_offset_days: 0, scheduled_for: todayISO,
      dedupe_key: buildDedupeKey({ category: 'maintenance_urgent', source_type: 'maintenance_cost', source_id: cost.id, offset_label: 'open', event_date: eventDate, recipient_user_id: cost.user_id }),
      status: 'unread',
      title: c.title, body: c.body, deep_link: 'maintenance'
    });
  }
  return { toInsert, toInvalidate };
}

function generateSettlementPending({ rentCredits, propertiesById, todayISO }) {
  const toInsert = [], toInvalidate = [];
  for (const rc of rentCredits) {
    if (!isSettlementPendingEligible(rc)) {
      const reason = rc.status === 'applied' ? 'settlement_applied' : 'settlement_cancelled';
      toInvalidate.push({ source_type: 'rent_credit', source_id: rc.id, category: 'settlement_pending', reason });
      continue;
    }
    const eventDate = (rc.created_at || '').slice(0, 10) || todayISO;
    const propertyName = (propertiesById.get(rc.property_id) || {}).property_name || 'your property';
    const c = copy.settlement_pending(rc, propertyName);
    toInsert.push({
      recipient_user_id: rc.user_id, recipient_role: 'owner', property_id: rc.property_id,
      category: 'settlement_pending', source_type: 'rent_credit', source_id: rc.id,
      event_date: eventDate, offset_label: 'open', trigger_offset_days: 0, scheduled_for: todayISO,
      dedupe_key: buildDedupeKey({ category: 'settlement_pending', source_type: 'rent_credit', source_id: rc.id, offset_label: 'open', event_date: eventDate, recipient_user_id: rc.user_id }),
      status: 'unread',
      title: c.title, body: c.body, deep_link: 'maintenance'
    });
  }
  return { toInsert, toInvalidate };
}

// Tenants who are inactive or have never activated a login must stop
// receiving rent_due for a given obligation, regardless of period --
// separate from the paid/period-based invalidation above since this is
// scoped by recipient, not by event_date.
function invalidateInactiveTenantRentDue({ obligationIds, inactiveOrUnlinkedTenantUserIds }) {
  const toInvalidate = [];
  for (const obligationId of obligationIds) {
    for (const recipientUserId of inactiveOrUnlinkedTenantUserIds) {
      toInvalidate.push({ source_type: 'obligation', source_id: obligationId, category: 'rent_due', reason: 'tenancy_inactive', recipient_user_id: recipientUserId });
    }
  }
  return toInvalidate;
}

module.exports = {
  CATEGORIES,
  buildDedupeKey,
  WARRANTY_AGREEMENT_LADDER, RENT_DUE_LADDER, RENT_OVERDUE_LADDER,
  computeMonthOrDayLadder, computeDayLadder,
  computeDueStatus, dueStatusWarrantsReminder,
  currentOrUpcomingDueDate, mostRecentPastDueDate, computeAgreementEndDate,
  isApplianceWarrantyEligible, isPropertyAgreementEligible, isPropertyTaxEligible, isMaintenanceUrgentEligible, isSettlementPendingEligible,
  generateWarrantyExpiry, generateAgreementRenewal, generatePropertyTaxDue, generateRentDue, generateRentOverdue,
  generateMaintenanceUrgent, generateSettlementPending, invalidateInactiveTenantRentDue
};
