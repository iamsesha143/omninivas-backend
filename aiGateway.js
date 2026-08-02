// Shared AI gateway client. This is the ONLY place in OMniNivas that talks to
// an AI backend -- no provider SDKs (Anthropic, OpenAI, etc.) and no provider
// API keys (GROQ_API_KEY, MISTRAL_API_KEY, etc.) live in this codebase.
// Everything goes through POST {AI_GATEWAY_URL}/v1/ai/run using AI_GATEWAY_KEY.
//
// IMPORTANT / not yet verified: the gateway's exact request and response shape
// was not documented anywhere I could find, and I had no working AI_GATEWAY_KEY
// to test against the live service (only confirmed via GET /health that it's up
// and requires auth). The shapes below are a reasonable best-effort guess,
// written defensively: the response parser tries several common field names,
// and every failure mode (missing env vars, network error, unexpected response
// shape) degrades to { ok: false } rather than throwing. Once a real key is
// available, run `node test-ai-gateway.js` (see bottom of this file's sibling
// test script) and adjust REQUEST/response parsing below if the real gateway
// disagrees -- everything that needs changing is in this one file.

// ---- Single config point: provider/model are NOT hardcoded -----------------
// Leaving these unset (the default) means the request omits `provider`/`model`
// entirely, so the gateway applies whatever default it's configured with --
// the safest option since we don't control or know the gateway's internals.
// Set AI_GATEWAY_PROVIDER / AI_GATEWAY_MODEL in the environment to pin a
// specific one later, with no code changes needed anywhere else in the app.
const GATEWAY_PROVIDER = process.env.AI_GATEWAY_PROVIDER || null;
const GATEWAY_MODEL = process.env.AI_GATEWAY_MODEL || null;
// -----------------------------------------------------------------------------

const GATEWAY_URL = process.env.AI_GATEWAY_URL || null;
const GATEWAY_KEY = process.env.AI_GATEWAY_KEY || null;
const configured = !!(GATEWAY_URL && GATEWAY_KEY);

if (!configured) {
  console.warn('aiGateway.js: AI_GATEWAY_URL / AI_GATEWAY_KEY not set — AI features disabled (no-op).');
}

function isConfigured() {
  return configured;
}

// Tries a handful of common response shapes so a small gateway-side naming
// difference doesn't silently break every AI feature at once.
function extractText(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  return (
    data.output ??
    data.text ??
    data.result ??
    data.response ??
    data.content ??
    data.choices?.[0]?.message?.content ??
    data.choices?.[0]?.text ??
    null
  );
}

// Sends a single text prompt to the gateway. Returns { ok: true, text } on
// success, or { ok: false } on ANY failure -- never throws. Callers (llm.js)
// treat { ok: false } exactly like "AI unavailable" and fall back to their
// existing non-AI behavior.
async function run(prompt, { maxTokens = 1000, timeoutMs = 20000 } = {}) {
  if (!configured || !prompt) return { ok: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = { prompt, max_tokens: maxTokens };
    if (GATEWAY_PROVIDER) body.provider = GATEWAY_PROVIDER;
    if (GATEWAY_MODEL) body.model = GATEWAY_MODEL;

    const res = await fetch(`${GATEWAY_URL}/v1/ai/run`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-gateway-key': GATEWAY_KEY,},
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      // Never log the prompt or the key -- status/text only.
      console.warn(`aiGateway.js: gateway returned ${res.status}`);
      return { ok: false };
    }
    const data = await res.json().catch(() => null);
    const text = extractText(data)?.toString().trim();
    if (!text) {
      console.warn('aiGateway.js: gateway response had no recognizable text field');
      return { ok: false };
    }
    return { ok: true, text };
  } catch (err) {
    clearTimeout(timeout);
    // err.message only -- never the prompt, never GATEWAY_KEY.
    console.warn('aiGateway.js: request failed:', err.name === 'AbortError' ? 'timed out' : err.message);
    return { ok: false };
  }
}

module.exports = { run, isConfigured };
