const GATEWAY_URL = process.env.AI_GATEWAY_URL || null;
const GATEWAY_KEY = process.env.AI_GATEWAY_KEY || null;
const GATEWAY_PROVIDER = process.env.AI_GATEWAY_PROVIDER || 'groq';
const GATEWAY_MODEL = process.env.AI_GATEWAY_MODEL || 'llama-3.1-8b-instant';
const configured = !!(GATEWAY_URL && GATEWAY_KEY);

if (!configured) {
  console.warn('aiGateway.js: AI_GATEWAY_URL / AI_GATEWAY_KEY not set — AI features disabled (no-op).');
}

function isConfigured() {
  return configured;
}

function extractText(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  return (
    data.text ??
    data.output ??
    data.result ??
    data.response ??
    data.content ??
    data.choices?.[0]?.message?.content ??
    data.choices?.[0]?.text ??
    null
  );
}

async function run(prompt, { maxTokens = 1000, timeoutMs = 20000 } = {}) {
  if (!configured || !prompt) return { ok: false };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      provider: GATEWAY_PROVIDER,
      model: GATEWAY_MODEL,
      messages: [
        { role: 'user', content: prompt }
      ]
    };

    const res = await fetch(`${GATEWAY_URL}/v1/ai/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
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
    console.warn('aiGateway.js: request failed:', err.name === 'AbortError' ? 'timed out' : err.message);
    return { ok: false };
  }
}

module.exports = { run, isConfigured };
