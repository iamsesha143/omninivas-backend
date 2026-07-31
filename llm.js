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

async function extractDeposit(text) {
  if (!client || !text || text.trim().length < 50) return { skipped: true, total: null, tenantCount: null };
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Read this Indian rental agreement and extract ONLY two facts as strict JSON, no other text: {"deposit_total": <number or null>, "tenant_count": <integer or null>}. deposit_total is the total security deposit amount explicitly stated (a plain number, no currency symbols or commas). tenant_count is how many tenants/occupants are explicitly named as parties on the agreement. If either isn't clearly stated, use null -- never guess or estimate.\n\nAgreement text:\n\n${text.slice(0, 12000)}`
      }]
    });
    const block = message.content?.find(b => b.type === 'text');
    const raw = block?.text?.trim();
    if (!raw) return { skipped: true, total: null, tenantCount: null };
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    const total = typeof parsed.deposit_total === 'number' && parsed.deposit_total > 0 ? parsed.deposit_total : null;
    const tenantCount = typeof parsed.tenant_count === 'number' && parsed.tenant_count > 0 ? parsed.tenant_count : null;
    if (total === null) return { skipped: true, total: null, tenantCount: null };
    return { skipped: false, total, tenantCount };
  } catch (err) {
    console.warn('llm.js: extractDeposit failed:', err.message);
    return { skipped: true, total: null, tenantCount: null };
  }
}

// Compares a move-in item list against a move-out item list and suggests
// conservative per-item deposit deductions. Text-only (item name/condition/notes
// -- not photo pixels): photo analysis is an explicitly deferred future extra,
// not part of this helper.
async function compareMoveInOut(moveInItems, moveOutItems) {
  if (!client || !moveOutItems || moveOutItems.length === 0) return { skipped: true, summary: null };
  try {
    const payload = moveOutItems.map(o => {
      const inItem = (moveInItems || []).find(i => (i.item_name || '').trim().toLowerCase() === (o.item_name || '').trim().toLowerCase());
      return {
        item: o.item_name,
        move_in_condition: inItem?.condition || 'not recorded at move-in',
        move_in_notes: inItem?.notes || '',
        move_out_condition: o.condition,
        move_out_notes: o.notes || ''
      };
    });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `You help an Indian landlord review a move-out inspection against the move-in record to suggest fair security-deposit deductions. For each item below, decide whether condition worsened, and if so suggest a modest INR deduction with a short reason. Be conservative: only suggest a deduction for real, stated degradation (e.g. good -> damaged), never for condition alone implying normal wear ("fair" is not automatically chargeable), and use null for suggested_deduction if the notes don't clearly support a number -- never invent one. Respond with ONLY strict JSON, no other text, in exactly this shape: {"items": [{"item": string, "changed": boolean, "suggested_deduction": number|null, "reason": string}], "total_suggested_deduction": number, "narrative": string (2-3 plain-English sentences for the landlord)}.\n\nItems:\n${JSON.stringify(payload, null, 2)}`
      }]
    });
    const block = message.content?.find(b => b.type === 'text');
    const raw = block?.text?.trim();
    if (!raw) return { skipped: true, summary: null };
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    if (!Array.isArray(parsed.items)) return { skipped: true, summary: null };
    return { skipped: false, summary: parsed };
  } catch (err) {
    console.warn('llm.js: compareMoveInOut failed:', err.message);
    return { skipped: true, summary: null };
  }
}

module.exports = { summarizeAgreement, extractDeposit, compareMoveInOut };
