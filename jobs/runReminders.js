#!/usr/bin/env node
// Standalone Railway Cron entry point (Phase 1B). This is the ONLY intended
// trigger for reminder generation -- there is no HTTP route that does this,
// deliberately, per the approved design. Connects, does one generation
// pass, logs the run, and exits. Not required/started by server.js.
//
// Credential: SUPABASE_SERVICE_ROLE_KEY only -- deliberately NOT the
// SUPABASE_KEY server.js uses. .env currently has three duplicate
// SUPABASE_KEY= lines (dotenv silently loads only the first and ignores the
// rest); this job's correctness shouldn't depend on trusting which one that
// is. If SUPABASE_SERVICE_ROLE_KEY is not set, this refuses to run rather
// than falling back to any other variable.
//
// Usage:
//   node jobs/runReminders.js             -- real run (writes to the DB)
//   node jobs/runReminders.js --dry-run   -- computes and logs sanitized
//                                             counts only; writes nothing.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const reminders = require('../reminders');
const { todayISOInTimezone } = require('../dateUtils');

const DRY_RUN = process.argv.includes('--dry-run');

async function fetchAll(supabase) {
  const [
    { data: appliances, error: e1 },
    { data: properties, error: e2 },
    { data: obligations, error: e3 },
    { data: payments, error: e4 },
    { data: tenants, error: e5 },
    { data: maintenanceCosts, error: e6 },
    { data: rentCredits, error: e7 }
  ] = await Promise.all([
    // Unfiltered (beyond the shape needed) so eligibility is decided purely
    // in reminders.js against the CURRENT full row -- a WHERE clause here
    // that pre-filtered e.g. urgency='high' would silently hide a row that
    // just became ineligible (e.g. urgency edited away from 'high') from
    // ever being invalidated, since it would no longer even be fetched.
    supabase.from('appliances').select('id, property_id, user_id, name, warranty_end, condition_status'),
    supabase.from('properties').select('id, user_id, property_name, agreement_start_date, agreement_months, deleted_at'),
    supabase.from('obligations').select('id, property_id, user_id, label, amount, due_day, paid_by, active').eq('active', true).eq('paid_by', 'tenant'),
    supabase.from('payments').select('id, obligation_id, period, status'),
    supabase.from('tenants').select('id, property_id, user_id, login_user_id, is_active'),
    supabase.from('maintenance_costs').select('id, property_id, user_id, description, urgency, request_status, cost_date'),
    supabase.from('rent_credits').select('id, property_id, user_id, type, amount, status, created_at')
  ]);
  for (const e of [e1, e2, e3, e4, e5, e6, e7]) if (e) throw e;
  return {
    appliances: appliances || [], properties: properties || [], obligations: obligations || [],
    payments: payments || [], tenants: tenants || [], maintenanceCosts: maintenanceCosts || [], rentCredits: rentCredits || []
  };
}

// Pure decision step -- fans fetched rows out into lookup maps, then calls
// reminders.js's pure generators. No I/O here; kept separate from fetchAll
// so both halves are independently testable.
function buildDecisions(source, todayISO) {
  const { appliances, properties, obligations, payments, tenants, maintenanceCosts, rentCredits } = source;

  const activePropertyIds = new Set(properties.filter(p => !p.deleted_at).map(p => p.id));
  const propertiesById = new Map(properties.map(p => [p.id, p]));

  const paymentsByObligationId = new Map();
  for (const p of payments) {
    if (!paymentsByObligationId.has(p.obligation_id)) paymentsByObligationId.set(p.obligation_id, []);
    paymentsByObligationId.get(p.obligation_id).push(p);
  }

  const tenantsByPropertyId = new Map();
  for (const t of tenants) {
    if (t.is_active && t.login_user_id) {
      if (!tenantsByPropertyId.has(t.property_id)) tenantsByPropertyId.set(t.property_id, []);
      tenantsByPropertyId.get(t.property_id).push(t);
    }
  }
  // A tenant who once had a login and is now inactive -- their existing
  // rent_due rows must be invalidated. A tenant who never had a login was
  // never a recipient, so there's nothing to invalidate for them.
  const inactiveOrUnlinkedTenantUserIds = [...new Set(tenants.filter(t => t.login_user_id && !t.is_active).map(t => t.login_user_id))];

  const parts = [
    reminders.generateWarrantyExpiry({ appliances, activePropertyIds, todayISO }),
    reminders.generateAgreementRenewal({ properties, todayISO }),
    reminders.generateRentDue({ obligations, tenantsByPropertyId, paymentsByObligationId, todayISO }),
    reminders.generateRentOverdue({ obligations, propertiesById, paymentsByObligationId, todayISO }),
    reminders.generateMaintenanceUrgent({ costs: maintenanceCosts, propertiesById, todayISO }),
    reminders.generateSettlementPending({ rentCredits, propertiesById, todayISO })
  ];

  const toInsert = parts.flatMap(p => p.toInsert);
  const toInvalidate = parts.flatMap(p => p.toInvalidate).concat(
    reminders.invalidateInactiveTenantRentDue({ obligationIds: obligations.map(o => o.id), inactiveOrUnlinkedTenantUserIds })
  );
  return { toInsert, toInvalidate };
}

// Step 1 of the approved lifecycle: re-open elapsed snoozes. snoozed_until
// must be cleared in the same write -- the DB CHECK constraint forbids a
// non-snoozed row from retaining it.
async function reopenElapsedSnoozes(supabase, todayISO) {
  const { data, error } = await supabase.from('notifications')
    .update({ status: 'unread', snoozed_until: null })
    .eq('status', 'snoozed').lte('snoozed_until', todayISO)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

// Step 2: invalidate stale unread/read/snoozed rows matching one
// instruction from reminders.js. snoozed_until is cleared here too, for the
// same constraint reason as above (a snoozed row moving straight to
// invalidated must not keep a stale snoozed_until).
async function applyInvalidation(supabase, instr) {
  let q = supabase.from('notifications')
    .update({ status: 'invalidated', invalidated_at: new Date().toISOString(), invalidation_reason: instr.reason, snoozed_until: null })
    .eq('source_type', instr.source_type).eq('source_id', instr.source_id).eq('category', instr.category)
    .in('status', ['unread', 'read', 'snoozed']);
  if (instr.recipient_user_id) q = q.eq('recipient_user_id', instr.recipient_user_id);
  if (instr.event_date) q = q.eq('event_date', instr.event_date);
  if (instr.excludeEventDate) q = q.neq('event_date', instr.excludeEventDate);
  const { data, error } = await q.select('id');
  if (error) throw error;
  return (data || []).length;
}

// Step 3: generate only currently-valid reminders. `ignoreDuplicates: true`
// with `onConflict: 'dedupe_key'` is Supabase-js's INSERT ... ON CONFLICT
// (dedupe_key) DO NOTHING -- the single source of truth for "don't create
// the same reminder twice," not just a courtesy application-level check.
// .select('id') after an ignoreDuplicates upsert returns only the rows that
// were actually newly inserted, giving an accurate created-count.
async function insertNewNotifications(supabase, toInsert) {
  if (toInsert.length === 0) return 0;
  const { data, error } = await supabase.from('notifications')
    .upsert(toInsert, { onConflict: 'dedupe_key', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

async function runOnce(supabase, todayISO, dryRun) {
  const source = await fetchAll(supabase);
  const { toInsert, toInvalidate } = buildDecisions(source, todayISO);

  if (dryRun) {
    console.log(`[runReminders] DRY RUN for ${todayISO}: would reopen elapsed snoozes, apply ${toInvalidate.length} invalidation instruction(s), and attempt ${toInsert.length} candidate insert(s) (actual created count after dedupe may be lower). No rows written.`);
    return toInsert.length;
  }

  await reopenElapsedSnoozes(supabase, todayISO);
  for (const instr of toInvalidate) {
    await applyInvalidation(supabase, instr);
  }
  return insertNewNotifications(supabase, toInsert);
}

// injectedSupabase is an optional test-only seam: when provided, main() uses
// it directly and never touches env vars or createClient at all, so tests
// can drive the full create-run-then-log lifecycle deterministically
// against a local mock without ever opening a real Supabase connection.
// Called with no argument (the normal `node jobs/runReminders.js` path),
// behavior is unchanged -- real env-var check, real createClient.
async function main(injectedSupabase) {
  let supabase = injectedSupabase;
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error('[runReminders] Missing required configuration: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set. Refusing to run. (Not SUPABASE_KEY -- this job requires its own dedicated service-role variable.)');
      process.exitCode = 1;
      return;
    }
    supabase = createClient(url, key, { realtime: { transport: ws } });
  }
  const todayISO = todayISOInTimezone();

  let jobRunId = null;
  if (!DRY_RUN) {
    const { data, error } = await supabase.from('reminder_job_runs').insert([{ status: 'running' }]).select('id');
    if (error) {
      console.error('[runReminders] Could not create a job-run log row:', error.message);
      process.exitCode = 1;
      return;
    }
    jobRunId = data[0].id;
  }

  try {
    const created = await runOnce(supabase, todayISO, DRY_RUN);
    if (DRY_RUN) {
      console.log(`[runReminders] Dry run finished cleanly for ${todayISO}.`);
      process.exitCode = 0;
    } else {
      const { error } = await supabase.from('reminder_job_runs').update({
        status: 'success', finished_at: new Date().toISOString(), notifications_created: created
      }).eq('id', jobRunId);
      if (error) {
        // The generation work itself succeeded, but its completion/audit
        // record did not persist -- a cron run whose own log can't confirm
        // it finished is not a verified success. Never report success or
        // exit 0 in this case.
        console.error('[runReminders] Run completed but failed to record success in reminder_job_runs -- treating as failed for audit purposes:', error.message);
        process.exitCode = 1;
      } else {
        console.log(`[runReminders] Run succeeded for ${todayISO}. Created ${created} notification(s).`);
        process.exitCode = 0;
      }
    }
  } catch (err) {
    console.error('[runReminders] Run failed:', err.message);
    if (!DRY_RUN && jobRunId) {
      const { error } = await supabase.from('reminder_job_runs').update({
        status: 'failed', finished_at: new Date().toISOString(), error_message: String(err.message || err).slice(0, 2000)
      }).eq('id', jobRunId);
      if (error) console.error('[runReminders] Additionally failed to write the failure log:', error.message);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  // Safety-net only -- main() already catches its own errors and sets
  // process.exitCode; this exists in case something throws synchronously
  // before main()'s own try block starts (e.g. createClient itself).
  main().catch((err) => {
    console.error('[runReminders] Unhandled error:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, runOnce, fetchAll, buildDecisions, reopenElapsedSnoozes, applyInvalidation, insertNewNotifications };
