// Email notifications (Phase 3, email-first). Gmail SMTP via nodemailer — chosen
// because every transactional-API provider (Resend/SendGrid/Postmark) requires
// verifying a domain to send from a custom address, and none can send literally
// as swamigroot@gmail.com without owning gmail.com. Optional/feature-detected like
// the Upstash Redis setup in server.js: missing env vars log a warning and no-op
// rather than crashing the app.
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const FROM_NAME = process.env.EMAIL_FROM_NAME || 'OMniNivas';

let transporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
} else {
  console.warn('Notifications: GMAIL_USER/GMAIL_APP_PASSWORD not set — email sending disabled (no-op).');
}

async function sendEmail({ to, subject, html, text }) {
  if (!transporter || !to) return { skipped: true };
  try {
    const info = await transporter.sendMail({
      from: `"${FROM_NAME}" <${process.env.GMAIL_USER}>`,
      to, subject, html, text
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.warn('Notifications: sendEmail failed:', err.message);
    return { sent: false, error: err.message };
  }
}

// Owner's own preference, keyed by their users.id (== req.userId on owner routes).
async function getEmailPreference(userId) {
  if (!userId) return true;
  const { data } = await supabase.from('users').select('email_enabled').eq('id', userId).single();
  return data ? data.email_enabled !== false : true;
}

// A tenant may not have activated their login yet (no login_user_id) — in that
// case there's no users row and no way they could have opted out, so default on.
async function getTenantEmailPreference(tenant) {
  if (!tenant || !tenant.login_user_id) return true;
  return getEmailPreference(tenant.login_user_id);
}

// Every value below comes from the database (tenant/property rows a landlord or
// tenant controls) and lands directly in an HTML email body — escape it so a
// name like `<img src=x onerror=...>` can't inject markup/links into mail sent
// to someone else. Only applied to `html`; the `text` sibling is never rendered
// as markup, so raw values are correct there.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const footer = () =>
  `<p style="margin-top:2rem;font-size:0.8rem;color:#6b7280">You're receiving this because you have an account with OMniNivas. Manage email preferences in Settings.</p>`;

const wrap = (bodyHtml) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
    <h2 style="color:#1e3a5f">OMniNivas</h2>
    ${bodyHtml}
    ${footer()}
  </div>`;

const APP_URL = 'https://omninivas-frontend-production.up.railway.app';

function handoverCreatedEmail({ tenantName, propertyName }) {
  const subject = `Move-in handover started for ${propertyName}`;
  const t = escapeHtml(tenantName), p = escapeHtml(propertyName);
  const html = wrap(`
    <p>A move-in handover checklist has been started for <b>${t}</b> at <b>${p}</b>.</p>
    <p>Log in to OMniNivas and open <b>Move-In Handover</b> to view or add items: <a href="${APP_URL}">${APP_URL}</a></p>
  `);
  const text = `A move-in handover checklist has been started for ${tenantName} at ${propertyName}. Log in to OMniNivas (${APP_URL}) and open Move-In Handover to view or add items.`;
  return { subject, html, text };
}

function handoverCompletedEmail({ tenantName, propertyName }) {
  const subject = `Your move-in handover for ${propertyName} is complete`;
  const t = escapeHtml(tenantName), p = escapeHtml(propertyName);
  const html = wrap(`
    <p>Hi ${t},</p>
    <p>Your move-in handover checklist for <b>${p}</b> has been completed — it records the condition of each fixture/appliance at move-in.</p>
    <p>Log in to OMniNivas and open <b>Move-In Handover</b> to view the full summary: <a href="${APP_URL}">${APP_URL}</a></p>
  `);
  const text = `Hi ${tenantName}, your move-in handover checklist for ${propertyName} has been completed. Log in to OMniNivas (${APP_URL}) and open Move-In Handover to view the full summary.`;
  return { subject, html, text };
}

function moveOutCompletedEmail({ tenantName, propertyName }) {
  const subject = `Move-out inspection for ${propertyName} is complete`;
  const t = escapeHtml(tenantName), p = escapeHtml(propertyName);
  const html = wrap(`
    <p>The move-out inspection for <b>${t}</b> at <b>${p}</b> has been completed, comparing current condition against the move-in record.</p>
    <p>Log in to OMniNivas and open <b>Move-Out Inspection</b> to view the full summary: <a href="${APP_URL}">${APP_URL}</a></p>
  `);
  const text = `The move-out inspection for ${tenantName} at ${propertyName} has been completed. Log in to OMniNivas (${APP_URL}) and open Move-Out Inspection to view the full summary.`;
  return { subject, html, text };
}

// Scaffolding only (task: "optional... even if not fully wired") — no cron/scheduler
// infra exists in this codebase yet, so nothing calls this today. Wire it up once
// a scheduled job mechanism exists (see the TODO near the obligations/dues logic
// in server.js).
function rentDueReminderEmail({ tenantName, propertyName, amount, dueDate, label }) {
  const subject = `Reminder: ${label} due for ${propertyName}`;
  const html = wrap(`
    <p>Hi ${tenantName},</p>
    <p><b>${label}</b> of <b>₹${amount}</b> is due on <b>${dueDate}</b> for ${propertyName}.</p>
    <p>Log in to OMniNivas to view or upload payment proof: <a href="${APP_URL}">${APP_URL}</a></p>
  `);
  const text = `Hi ${tenantName}, ${label} of ₹${amount} is due on ${dueDate} for ${propertyName}. Log in to OMniNivas (${APP_URL}) to view or upload payment proof.`;
  return { subject, html, text };
}

module.exports = {
  sendEmail,
  getEmailPreference,
  getTenantEmailPreference,
  handoverCreatedEmail,
  handoverCompletedEmail,
  moveOutCompletedEmail,
  rentDueReminderEmail
};
