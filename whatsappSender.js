// Mirrors aiGateway.js's configured-or-no-op pattern deliberately: no real
// WhatsApp BSP (Gupshup/Twilio/Interakt) account exists yet, so this module
// is built and fully wired into the reminder pipeline today, but every call
// is a no-op until WHATSAPP_BSP_URL/WHATSAPP_BSP_KEY are set. Flipping those
// env vars on later requires zero changes anywhere else that calls send().
const BSP_URL = process.env.WHATSAPP_BSP_URL || null;
const BSP_KEY = process.env.WHATSAPP_BSP_KEY || null;
const configured = !!(BSP_URL && BSP_KEY);

function isConfigured() {
  return configured;
}

// { to: phone string, title, body, deepLink } -> { ok, dark, providerMessageId? }
async function send({ to, title, body, deepLink }) {
  if (!configured) {
    console.log(`[whatsappSender] DARK MODE — would send to ${to}: "${title}" -> ${deepLink || '(no link)'}`);
    return { ok: true, dark: true, providerMessageId: null };
  }
  // Real BSP integration intentionally not implemented -- there is no real
  // account/contract to integrate against yet. Configuring the env vars
  // above without also implementing this branch would be a silent lie
  // (claims "configured" but can't actually send), so it fails loudly
  // instead of pretending to succeed.
  throw new Error('whatsappSender: WHATSAPP_BSP_URL/KEY are set but the real send implementation does not exist yet');
}

module.exports = { isConfigured, send };
