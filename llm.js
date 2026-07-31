// Phase 2 LLM proof point: a single, narrow use of Claude to summarize an
// already-OCR'd rental agreement into plain-English bullet points. Feature-detected
// like notifications.js's Gmail setup -- missing ANTHROPIC_API_KEY, an empty/short
// input, or any call failure all degrade to { skipped: true, summary: null } and
// never throw, so /api/extract/property keeps working with zero AI involvement.
const Anthropic = require('@anthropic-ai/sdk');

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
if (!client) console.warn('llm.js: ANTHROPIC_API_KEY not set — agreement summarization disabled (no-op).');

async function summarizeAgreement(text) {
  if (!client || !text || text.trim().length < 50) return { skipped: true, summary: null };
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Summarize the key terms of this Indian rental agreement in 4-6 short plain-English bullet points (rent amount, security deposit, notice period, who pays which bills, and any unusual clauses). Only state what is explicitly present in the text below -- never infer or guess a detail that isn't there. If a detail isn't mentioned, omit it rather than guessing.\n\nAgreement text:\n\n${text.slice(0, 12000)}`
      }]
    });
    const block = message.content?.find(b => b.type === 'text');
    const summary = block?.text?.trim();
    if (!summary) return { skipped: true, summary: null };
    return { skipped: false, summary };
  } catch (err) {
    console.warn('llm.js: summarizeAgreement failed:', err.message);
    return { skipped: true, summary: null };
  }
}

module.exports = { summarizeAgreement };
