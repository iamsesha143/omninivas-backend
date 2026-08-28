// WhatsApp dark-send hook in jobs/runReminders.js (sendWhatsAppNotifications
// and its wiring into runOnce). Separate file from runReminders.test.js
// (already large) rather than growing that one further. Same in-memory
// table mock; whatsappSender itself is exercised for real here (dark mode,
// no env vars set anywhere in this suite) rather than mocked, since dark
// mode never touches the network -- there's nothing to isolate it from.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInMemorySupabase } = require('./inMemorySupabaseMock');
const job = require('../jobs/runReminders');

function baseTables(overrides = {}) {
  return {
    appliances: [], properties: [], obligations: [], payments: [], tenants: [],
    maintenance_costs: [], rent_credits: [], notifications: [], reminder_job_runs: [],
    users: [], whatsapp_notifications: [],
    ...overrides
  };
}

test('sendWhatsAppNotifications: a consented recipient with a phone on file gets a dark send and a log row', async () => {
  const supabase = createInMemorySupabase(baseTables({
    users: [{ id: 'tenant-user-1', phone_number: '+919999999999', whatsapp_enabled: true }]
  }));
  const createdRows = [{ id: 'notif-1', recipient_user_id: 'tenant-user-1', category: 'rent_due', title: 'Rent due soon', body: 'Your rent is due on 2026-08-20.', deep_link: 'bills' }];

  const sent = await job.sendWhatsAppNotifications(supabase, createdRows);

  assert.equal(sent, 1);
  assert.equal(supabase.__tables.whatsapp_notifications.length, 1);
  const row = supabase.__tables.whatsapp_notifications[0];
  assert.equal(row.recipient_user_id, 'tenant-user-1');
  assert.equal(row.notification_id, 'notif-1');
  assert.equal(row.category, 'rent_due');
  assert.equal(row.dark_mode, true);
  assert.equal(row.provider_message_id, null);
  assert.ok(row.deep_link.endsWith('/?open=bills'));
});

test('sendWhatsAppNotifications: whatsapp_enabled false is skipped entirely, no log row', async () => {
  const supabase = createInMemorySupabase(baseTables({
    users: [{ id: 'tenant-user-1', phone_number: '+919999999999', whatsapp_enabled: false }]
  }));
  const createdRows = [{ id: 'notif-1', recipient_user_id: 'tenant-user-1', category: 'rent_due', title: 't', body: 'b', deep_link: 'bills' }];

  const sent = await job.sendWhatsAppNotifications(supabase, createdRows);

  assert.equal(sent, 0);
  assert.equal(supabase.__tables.whatsapp_notifications.length, 0);
});

test('sendWhatsAppNotifications: consented but no phone_number on file is skipped, not sent to null/undefined', async () => {
  const supabase = createInMemorySupabase(baseTables({
    users: [{ id: 'tenant-user-1', phone_number: null, whatsapp_enabled: true }]
  }));
  const createdRows = [{ id: 'notif-1', recipient_user_id: 'tenant-user-1', category: 'rent_due', title: 't', body: 'b', deep_link: 'bills' }];

  const sent = await job.sendWhatsAppNotifications(supabase, createdRows);

  assert.equal(sent, 0);
  assert.equal(supabase.__tables.whatsapp_notifications.length, 0);
});

test('sendWhatsAppNotifications: a category outside the WhatsApp-eligible set is skipped, never queries recipients', async () => {
  const supabase = createInMemorySupabase(baseTables({
    users: [{ id: 'owner-1', phone_number: '+919999999999', whatsapp_enabled: true }]
  }));
  const createdRows = [{ id: 'notif-1', recipient_user_id: 'owner-1', category: 'warranty_expiry', title: 't', body: 'b', deep_link: 'assets' }];

  const sent = await job.sendWhatsAppNotifications(supabase, createdRows);

  assert.equal(sent, 0);
  assert.equal(supabase.__tables.whatsapp_notifications.length, 0);
});

test('sendWhatsAppNotifications: empty createdRows returns 0 immediately, no query at all', async () => {
  const supabase = createInMemorySupabase(baseTables());
  const sent = await job.sendWhatsAppNotifications(supabase, []);
  assert.equal(sent, 0);
});

test('sendWhatsAppNotifications: rent_overdue (owner-facing) is eligible too, not just rent_due', async () => {
  const supabase = createInMemorySupabase(baseTables({
    users: [{ id: 'owner-1', phone_number: '+919888888888', whatsapp_enabled: true }]
  }));
  const createdRows = [{ id: 'notif-1', recipient_user_id: 'owner-1', category: 'rent_overdue', title: 'Rent overdue', body: 'Rent at Flat 3B is 3 days overdue.', deep_link: 'bills' }];

  const sent = await job.sendWhatsAppNotifications(supabase, createdRows);

  assert.equal(sent, 1);
  assert.equal(supabase.__tables.whatsapp_notifications[0].category, 'rent_overdue');
});

test('runOnce end-to-end: a consented tenant\'s rent_due reminder produces exactly one dark WhatsApp log row', async () => {
  const tables = baseTables({
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 10000, due_day: 20, paid_by: 'tenant', active: true }],
    payments: [{ obligation_id: 'ob1', period: '2026-07-01', status: 'paid' }],
    tenants: [{ id: 't1', property_id: 'p1', user_id: 'owner-1', login_user_id: 'tenant-user-1', is_active: true }],
    users: [{ id: 'tenant-user-1', phone_number: '+919999999999', whatsapp_enabled: true }]
  });
  const supabase = createInMemorySupabase(tables);

  const result = await job.runOnce(supabase, '2026-08-15', false);

  assert.equal(result.created, 1);
  assert.equal(result.whatsappSent, 1);
  assert.equal(supabase.__tables.whatsapp_notifications.length, 1);
  assert.equal(supabase.__tables.whatsapp_notifications[0].recipient_user_id, 'tenant-user-1');
});

test('runOnce end-to-end: an un-consented tenant\'s rent_due reminder is still created in-app, but never dark-sent', async () => {
  const tables = baseTables({
    obligations: [{ id: 'ob1', property_id: 'p1', user_id: 'owner-1', label: 'Rent', amount: 10000, due_day: 20, paid_by: 'tenant', active: true }],
    payments: [{ obligation_id: 'ob1', period: '2026-07-01', status: 'paid' }],
    tenants: [{ id: 't1', property_id: 'p1', user_id: 'owner-1', login_user_id: 'tenant-user-1', is_active: true }],
    users: [{ id: 'tenant-user-1', phone_number: '+919999999999', whatsapp_enabled: false }]
  });
  const supabase = createInMemorySupabase(tables);

  const result = await job.runOnce(supabase, '2026-08-15', false);

  assert.equal(result.created, 1); // in-app notification still created
  assert.equal(result.whatsappSent, 0);
  assert.equal(supabase.__tables.whatsapp_notifications.length, 0);
});
