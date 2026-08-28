// whatsappSender.js -- mirrors aiGateway.js's configured-or-no-op pattern.
// No real BSP credential exists anywhere yet, so these tests only cover the
// dark-mode path plus the "configured but not implemented" guard; there is
// deliberately no real-send test since no real send path exists to test.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('isConfigured is false with no WHATSAPP_BSP_URL/KEY set', () => {
  delete process.env.WHATSAPP_BSP_URL;
  delete process.env.WHATSAPP_BSP_KEY;
  delete require.cache[require.resolve('../whatsappSender')];
  const sender = require('../whatsappSender');
  assert.equal(sender.isConfigured(), false);
});

test('send() in dark mode never throws, logs, and returns ok:true, dark:true, no provider id', async () => {
  delete process.env.WHATSAPP_BSP_URL;
  delete process.env.WHATSAPP_BSP_KEY;
  delete require.cache[require.resolve('../whatsappSender')];
  const sender = require('../whatsappSender');

  const result = await sender.send({ to: '+919999999999', title: 'Rent due soon', body: 'Rent is due', deepLink: 'https://example.test/bills' });
  assert.deepEqual(result, { ok: true, dark: true, providerMessageId: null });
});

test('isConfigured becomes true once both env vars are set', () => {
  process.env.WHATSAPP_BSP_URL = 'https://bsp.example.test';
  process.env.WHATSAPP_BSP_KEY = 'test-key';
  delete require.cache[require.resolve('../whatsappSender')];
  const sender = require('../whatsappSender');
  assert.equal(sender.isConfigured(), true);
  delete process.env.WHATSAPP_BSP_URL;
  delete process.env.WHATSAPP_BSP_KEY;
});

test('send() throws rather than silently succeeding when configured but the real path is unimplemented', async () => {
  process.env.WHATSAPP_BSP_URL = 'https://bsp.example.test';
  process.env.WHATSAPP_BSP_KEY = 'test-key';
  delete require.cache[require.resolve('../whatsappSender')];
  const sender = require('../whatsappSender');

  await assert.rejects(() => sender.send({ to: '+919999999999', title: 'x', body: 'y' }), /real send implementation does not exist/);
  delete process.env.WHATSAPP_BSP_URL;
  delete process.env.WHATSAPP_BSP_KEY;
});
