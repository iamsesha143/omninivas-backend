// razorpayClient.js -- configured-or-no-op pattern (createPaymentLink) plus
// the one real piece, verifyWebhookSignature. No real Razorpay account
// exists anywhere yet, so there is deliberately no "real payment link
// creation" test -- that path doesn't exist to test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

function freshClient(env) {
  for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
    if (env[k] !== undefined) process.env[k] = env[k]; else delete process.env[k];
  }
  delete require.cache[require.resolve('../razorpayClient')];
  return require('../razorpayClient');
}

test('isConfigured is false with no key/secret set', () => {
  const client = freshClient({});
  assert.equal(client.isConfigured(), false);
});

test('isConfigured is true once both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set', () => {
  const client = freshClient({ RAZORPAY_KEY_ID: 'rzp_test_id', RAZORPAY_KEY_SECRET: 'rzp_test_secret' });
  assert.equal(client.isConfigured(), true);
});

test('createPaymentLink in dark mode never throws and returns dark:true, no link', async () => {
  const client = freshClient({});
  const result = await client.createPaymentLink({ amountRupees: 10000, description: 'Rent', referenceId: 'ob1:2026-08-01' });
  assert.deepEqual(result, { ok: true, dark: true, link: null });
});

test('createPaymentLink throws rather than silently succeeding when configured but unimplemented', async () => {
  const client = freshClient({ RAZORPAY_KEY_ID: 'rzp_test_id', RAZORPAY_KEY_SECRET: 'rzp_test_secret' });
  await assert.rejects(() => client.createPaymentLink({ amountRupees: 100, description: 'x', referenceId: 'y' }), /real Payment Links call does not exist/);
});

test('webhooksConfigured is false with no RAZORPAY_WEBHOOK_SECRET set', () => {
  const client = freshClient({});
  assert.equal(client.webhooksConfigured(), false);
});

test('verifyWebhookSignature: a correctly-computed HMAC over the exact raw body passes', () => {
  const client = freshClient({ RAZORPAY_WEBHOOK_SECRET: 'whsec_test' });
  const rawBody = Buffer.from('{"event":"payment_link.paid"}');
  const validSig = crypto.createHmac('sha256', 'whsec_test').update(rawBody).digest('hex');
  assert.equal(client.verifyWebhookSignature(rawBody, validSig), true);
});

test('verifyWebhookSignature: a signature computed over different bytes fails', () => {
  const client = freshClient({ RAZORPAY_WEBHOOK_SECRET: 'whsec_test' });
  const rawBody = Buffer.from('{"event":"payment_link.paid"}');
  const tamperedBody = Buffer.from('{"event":"payment_link.paid","amount":999999}');
  const sigForTamperedBody = crypto.createHmac('sha256', 'whsec_test').update(tamperedBody).digest('hex');
  assert.equal(client.verifyWebhookSignature(rawBody, sigForTamperedBody), false);
});

test('verifyWebhookSignature: a signature computed with the wrong secret fails', () => {
  const client = freshClient({ RAZORPAY_WEBHOOK_SECRET: 'whsec_test' });
  const rawBody = Buffer.from('{"event":"payment_link.paid"}');
  const sigWithWrongSecret = crypto.createHmac('sha256', 'wrong_secret').update(rawBody).digest('hex');
  assert.equal(client.verifyWebhookSignature(rawBody, sigWithWrongSecret), false);
});

test('verifyWebhookSignature: no webhook secret configured always fails closed', () => {
  const client = freshClient({});
  const rawBody = Buffer.from('{"event":"payment_link.paid"}');
  const sig = crypto.createHmac('sha256', 'whsec_test').update(rawBody).digest('hex');
  assert.equal(client.verifyWebhookSignature(rawBody, sig), false);
});

test('verifyWebhookSignature: missing signature header fails closed', () => {
  const client = freshClient({ RAZORPAY_WEBHOOK_SECRET: 'whsec_test' });
  assert.equal(client.verifyWebhookSignature(Buffer.from('{}'), undefined), false);
});

test('verifyWebhookSignature: a mismatched-length signature never throws (timingSafeEqual guard)', () => {
  const client = freshClient({ RAZORPAY_WEBHOOK_SECRET: 'whsec_test' });
  assert.doesNotThrow(() => client.verifyWebhookSignature(Buffer.from('{}'), 'short'));
});
