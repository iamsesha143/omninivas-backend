// Same configured-or-no-op pattern as aiGateway.js/whatsappSender.js: no
// real Razorpay merchant account exists yet, so createPaymentLink() is dark
// until RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are set. Scoped deliberately to
// a single owner's own merchant account collecting their own rent, never a
// multi-landlord marketplace (that would need Razorpay Route + RBI payment-
// aggregator authorization -- out of scope, a different and much larger
// undertaking).
//
// verifyWebhookSignature() is the one piece that's REAL today, not dark --
// it's pure HMAC verification, no network call, no account needed, and it's
// the thing most worth getting right before any live webhook ever arrives
// (a wrong signature check is either a security hole or silently rejects
// every real event).
const crypto = require('crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID || null;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || null;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || null;
const configured = !!(KEY_ID && KEY_SECRET);

function isConfigured() {
  return configured;
}

function webhooksConfigured() {
  return !!WEBHOOK_SECRET;
}

// { amountRupees, description, referenceId } -> { ok, dark, link? }
async function createPaymentLink({ amountRupees, description, referenceId }) {
  if (!configured) {
    console.log(`[razorpayClient] DARK MODE — would create a ₹${amountRupees} payment link for "${description}" (ref ${referenceId})`);
    return { ok: true, dark: true, link: null };
  }
  // Real Razorpay Payment Links API call intentionally not implemented --
  // no live merchant account/contract exists yet. Same reasoning as
  // whatsappSender.js: claiming "configured" without a working real path
  // would be a silent lie, so this fails loudly instead.
  throw new Error('razorpayClient: RAZORPAY_KEY_ID/SECRET are set but the real Payment Links call does not exist yet');
}

// Per Razorpay's own documented requirement: signed over the RAW request
// body bytes, never a re-parsed/re-stringified req.body (JSON.stringify can
// reorder keys or change whitespace, silently producing a different byte
// sequence and breaking an otherwise-correct signature). timingSafeEqual
// requires equal-length buffers -- the length check first avoids it
// throwing on a mismatched length instead of just returning false.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, webhooksConfigured, createPaymentLink, verifyWebhookSignature };
