// AI helper functions used across OMniNivas. All calls go through the shared
// aiGateway client (aiGateway.js) -- no provider SDK, no provider API key here.
// Every function keeps the exact same feature-detected, never-throw contract it
// always had: missing gateway config, short/empty input, or any call failure
// all degrade to a "skipped" result and the caller falls back to its existing
// non-AI behavior. Nothing about server.js needed to change for this.
const aiGateway = require('./aiGateway');

// Deliberately complementary to extractAgreementFacts() below, not a restatement
// of it: the structured facts already cover rent/deposit/duration/maintenance
// payer/electricity payer/painting/fixtures as individually verifiable fields,
// so this prompt is told to skip repeating those as plain prose and instead
// surface only what a structured field can't capture -- exceptions, unusual
// clauses, and practical implications for the owner. Kept short on purpose:
// this is meant to sit alongside the structured facts, not reproduce the
// source document.
async function summarizeAgreement(text) {
  if (!aiGateway.isConfigured() || !text || text.trim().length < 50) return { skipped: true, summary: null };
  const prompt = `You are helping an Indian landlord who will ALSO see these facts already pulled out separately and shown as individual fields: monthly rent, security deposit, lease duration, who pays maintenance, who pays electricity, any painting clause, and any fixtures/appliances listed. Do NOT restate those as plain sentences and do NOT reproduce or paraphrase large chunks of the agreement text.\n\nInstead, in 2-4 short bullet points, surface ONLY things that matter but aren't captured by those simple fields, for example: unusual or one-sided clauses, penalty/lock-in terms, rent escalation clauses, sub-letting restrictions, anything that could surprise the owner or tenant later, or a brief note on the practical implication of a clause. If the agreement is entirely standard with nothing else worth flagging, say so in one line -- do not pad with restatements just to fill space.\n\nOnly state what is explicitly present in the text below -- never infer or guess a detail that isn't there.\n\nAgreement text:\n\n${text.slice(0, 16000)}`;
  const res = await aiGateway.run(prompt, { maxTokens: 350 });
  if (!res.ok) return { skipped: true, summary: null };
  return { skipped: false, summary: res.text };
}

const EMPTY_AGREEMENT_FACTS = {
  skipped: true, rent_amount: null, deposit_total: null, tenant_count: null,
  duration_months: null, maintenance_payer: null, electricity_payer: null,
  painting_clause: null, fixtures: []
};

// Structured, single-call extraction of the specific clause-level facts owners
// need verified (rent/deposit/duration/who-pays-what/painting/fixtures) --
// strict JSON is far less error-prone to consume than parsing these back out
// of prose, and this is the one gateway call extractDeposit() below now
// delegates to instead of running a second, separate call for the same
// document. fixtures maps to the move-in/appliances/handover area -- the
// review step offers to seed the appliance registry from it (never silently).
async function extractAgreementFacts(text) {
  if (!aiGateway.isConfigured() || !text || text.trim().length < 50) return { ...EMPTY_AGREEMENT_FACTS };
  const prompt = `Read this Indian rental agreement and extract ONLY these facts as strict JSON, no other text, in exactly this shape:\n{"rent_amount": <number or null>, "deposit_total": <number or null>, "tenant_count": <integer or null>, "duration_months": <integer or null>, "maintenance_payer": <"owner"|"tenant"|null>, "electricity_payer": <"owner"|"tenant"|null>, "painting_clause": <string or null>, "fixtures": <array of short strings>}\n\n- rent_amount: the monthly rent, a plain number, no currency symbols/commas.\n- deposit_total: the total security deposit amount, a plain number.\n- tenant_count: how many tenants/occupants are explicitly named as parties.\n- duration_months: the lease duration in months (an integer).\n- maintenance_payer: who pays society/maintenance charges -- exactly "owner" or "tenant".\n- electricity_payer: who pays electricity charges -- exactly "owner" or "tenant".\n- painting_clause: any painting/whitewashing/one-time charge clause, stated briefly in your own words (e.g. "one month's rent"), or null if there is none.\n- fixtures: any fittings/fixtures/appliances explicitly listed as provided with the property (e.g. "geyser", "modular kitchen", "wardrobe", "AC", "washing machine") -- short item names only, one per array entry, empty array if none listed.\n\nOnly state what is explicitly present in the text. If a detail isn't clearly and explicitly stated, use null (or an empty array for fixtures) -- never infer, guess, or estimate.\n\nAgreement text:\n\n${text.slice(0, 16000)}`;
  const res = await aiGateway.run(prompt, { maxTokens: 500 });
  if (!res.ok) return { ...EMPTY_AGREEMENT_FACTS };
  try {
    const match = res.text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : res.text);
    const num = (v) => typeof v === 'number' && v > 0 ? v : null;
    const payer = (v) => ['owner', 'tenant'].includes(v) ? v : null;
    const fixtures = Array.isArray(parsed.fixtures)
      ? [...new Set(parsed.fixtures.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim().slice(0, 60)))].slice(0, 20)
      : [];
    return {
      skipped: false,
      rent_amount: num(parsed.rent_amount),
      deposit_total: num(parsed.deposit_total),
      tenant_count: typeof parsed.tenant_count === 'number' && parsed.tenant_count > 0 ? parsed.tenant_count : null,
      duration_months: typeof parsed.duration_months === 'number' && parsed.duration_months > 0 ? parsed.duration_months : null,
      maintenance_payer: payer(parsed.maintenance_payer),
      electricity_payer: payer(parsed.electricity_payer),
      painting_clause: typeof parsed.painting_clause === 'string' && parsed.painting_clause.trim() ? parsed.painting_clause.trim().slice(0, 300) : null,
      fixtures
    };
  } catch (err) {
    console.warn('llm.js: extractAgreementFacts could not parse gateway response:', err.message);
    return { ...EMPTY_AGREEMENT_FACTS };
  }
}

// Kept as a thin wrapper so its external contract (server.js, deposit-confirm
// flow) is unchanged -- callers that only need the deposit/tenant-count subset
// don't need to know a richer extraction exists underneath.
async function extractDeposit(text) {
  const facts = await extractAgreementFacts(text);
  if (facts.skipped || facts.deposit_total === null) return { skipped: true, total: null, tenantCount: null };
  return { skipped: false, total: facts.deposit_total, tenantCount: facts.tenant_count };
}

// Compares a move-in item list against a move-out item list and suggests
// conservative per-item deposit deductions. Text-only (item name/condition/notes
// -- not photo pixels): photo analysis is an explicitly deferred future extra,
// not part of this helper.
async function compareMoveInOut(moveInItems, moveOutItems) {
  if (!aiGateway.isConfigured() || !moveOutItems || moveOutItems.length === 0) return { skipped: true, summary: null };
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
  const prompt = `You help an Indian landlord review a move-out inspection against the move-in record to suggest fair security-deposit deductions. For each item below, decide whether condition worsened, and if so suggest a modest INR deduction with a short reason. Be conservative: only suggest a deduction for real, stated degradation (e.g. good -> damaged), never for condition alone implying normal wear ("fair" is not automatically chargeable), and use null for suggested_deduction if the notes don't clearly support a number -- never invent one. Respond with ONLY strict JSON, no other text, in exactly this shape: {"items": [{"item": string, "changed": boolean, "suggested_deduction": number|null, "reason": string}], "total_suggested_deduction": number, "narrative": string (2-3 plain-English sentences for the landlord)}.\n\nItems:\n${JSON.stringify(payload, null, 2)}`;
  const res = await aiGateway.run(prompt, { maxTokens: 1200 });
  if (!res.ok) return { skipped: true, summary: null };
  try {
    const match = res.text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : res.text);
    if (!Array.isArray(parsed.items)) return { skipped: true, summary: null };
    return { skipped: false, summary: parsed };
  } catch (err) {
    console.warn('llm.js: compareMoveInOut could not parse gateway response:', err.message);
    return { skipped: true, summary: null };
  }
}

// WhatsApp import v1: turns a parsed chat's non-system messages into candidate
// structured facts for owner review. Every fact must carry an evidence snippet
// and a source message_seq so the frontend can show "why" -- never returned as
// final truth, only as something to Approve/Edit/Reject.
const WHATSAPP_CATEGORIES = [
  'person', 'property_reference', 'payment', 'deposit', 'date_milestone',
  'maintenance', 'vendor', 'commitment', 'document_reference', 'utility_cost'
];

async function extractWhatsAppFacts(messages) {
  if (!aiGateway.isConfigured() || !messages || messages.length === 0) return { skipped: true, facts: [] };
  // Bound cost/tokens: cap message count and total character budget.
  const capped = messages.slice(0, 400);
  const payload = capped.map(m => ({ seq: m.seq, sender: m.sender, text: m.body })).filter(m => m.text);
  const json = JSON.stringify(payload).slice(0, 20000);
  const prompt = `This is a WhatsApp conversation between an Indian landlord and tenant, as an array of {seq, sender, text}. Extract candidate facts an owner could use to build/enrich their records. Only extract what is explicitly stated -- never infer or guess a number or date that isn't written. Each fact must include the source message's seq and a short verbatim evidence snippet copied from that message's text. SAFETY RULE: never copy an actual Aadhaar/PAN/ID number (or any 10+ digit sequence) into "value" or "evidence" -- describe that a document was shared/requested instead, e.g. value "Aadhaar copy shared", not the number itself.\n\nValid categories (use exactly these strings): ${WHATSAPP_CATEGORIES.join(', ')}.\n- person: a named individual and their apparent role (tenant/owner/vendor/other).\n- property_reference: any mention of a flat/unit/address/property name.\n- payment: rent paid/due history -- a stated rent amount, a rent payment confirmation, or a rent still owed. Use fact_type "rent_payment" or "rent_due".\n- deposit: security deposit history -- amount agreed, amount paid, or a refund/deduction mention. Use fact_type "deposit_paid", "deposit_agreed", or "deposit_refund".\n- date_milestone: a move-in or move-out date.\n- maintenance: a reported issue, OR a repair that was carried out (e.g. "geyser not working", "plumber fixed the leak yesterday"). Use fact_type "issue_reported" or "repair_completed".\n- utility_cost: an electricity, water, or other utility bill amount or payment mention (e.g. "electricity bill was 1200 this month"). Use fact_type "electricity_cost", "water_cost", or "other_utility_cost".\n- vendor: a mentioned service person/company (electrician, plumber, etc.) and contact info if given.\n- commitment: a promise or follow-up with or without a date (e.g. "will pay by 5th", "will send plumber tomorrow").\n- document_reference: a mention of Aadhaar, PAN, ID proof, or another document being shared/pending/requested (e.g. "sending Aadhaar copy", "need your PAN for the agreement") -- never extract the actual document number as the value, only that a document was referenced and its status.\n\nRespond with ONLY strict JSON, no other text, in exactly this shape: {"facts": [{"category": string, "fact_type": string, "value": string, "confidence": number (0-1), "evidence": string, "message_seq": number}]}. Omit anything not clearly supported by the text -- an empty facts array is a valid answer.\n\nConversation:\n${json}`;
  const res = await aiGateway.run(prompt, { maxTokens: 2400 });
  if (!res.ok) return { skipped: true, facts: [] };
  const match = res.text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : res.text;
  let facts = null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.facts)) facts = parsed.facts;
  } catch (err) {
    // Free-tier models occasionally cut off mid-object on a longer facts
    // array, breaking the outer JSON. Don't discard the whole extraction for
    // that -- salvage whichever individual {...} objects ARE complete and
    // valid instead of losing every fact because the last one got truncated.
    console.warn('llm.js: extractWhatsAppFacts got malformed JSON, attempting salvage:', err.message);
    facts = (raw.match(/\{[^{}]*\}/g) || [])
      .map(s => { try { return JSON.parse(s); } catch (_) { return null; } })
      .filter(Boolean);
  }
  if (!facts || facts.length === 0) return { skipped: true, facts: [] };
  const filtered = facts.filter(f => f && WHATSAPP_CATEGORIES.includes(f.category) && f.value);
  return { skipped: false, facts: filtered };
}

module.exports = { summarizeAgreement, extractDeposit, extractAgreementFacts, compareMoveInOut, extractWhatsAppFacts, WHATSAPP_CATEGORIES };
