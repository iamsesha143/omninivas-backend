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
  // 700, not 350: openai/gpt-oss-20b (the current default model, since
  // 2026-08-27) is a reasoning-style model that spends part of its token
  // budget on internal reasoning before the visible answer -- 350 was tuned
  // against the older non-reasoning llama-3.1-8b-instant and left too little
  // room, causing the gateway to return empty content (confirmed live:
  // aiGateway.js logged "gateway response had no recognizable text field"
  // on a real production test upload).
  const res = await aiGateway.run(prompt, { maxTokens: 700 });
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
  'maintenance', 'vendor', 'commitment', 'document_reference', 'utility_cost',
  'guardian_contact'
];

// Bounded fact_type vocabulary, used both by the extraction prompt below and
// as the server-side validation list for owner corrections (server.js) --
// an owner correcting a fact's type can only pick from real, known values,
// never arbitrary free text. 'repair_rent_offset' is new: a repair whose
// cost is being deducted/adjusted against rent is neither an ordinary
// maintenance record nor rent income, so it gets its own type rather than
// silently collapsing into either.
const WHATSAPP_FACT_TYPES = [
  'rent_payment', 'rent_due', 'deposit_paid', 'deposit_agreed', 'deposit_refund', 'deposit_basis',
  'issue_reported', 'repair_completed', 'repair_rent_offset',
  'electricity_cost', 'water_cost', 'other_utility_cost'
];

async function extractWhatsAppFacts(messages) {
  if (!aiGateway.isConfigured() || !messages || messages.length === 0) return { skipped: true, facts: [] };
  // Bound cost/tokens: cap message count and total character budget.
  const capped = messages.slice(0, 400);
  const payload = capped.map(m => ({ seq: m.seq, sender: m.sender, text: m.body })).filter(m => m.text);
  const json = JSON.stringify(payload).slice(0, 20000);
  // Kept deliberately concise: an earlier, much longer version of this prompt
  // (spelling out every category with multiple inline example phrases) caused
  // the free-tier model behind the gateway to hallucinate a generic "typical"
  // landlord-tenant chat instead of reading the actual conversation below --
  // confirmed by testing the long vs short prompt against identical real
  // input. Longer is not better for this model; every instruction here earned
  // its place by being re-tested against real data after adding it.
  const prompt = `This is a WhatsApp conversation between an Indian landlord and tenant, as an array of {seq, sender, text}. Extract candidate facts an owner could use to build/enrich their records. Only extract what is explicitly stated in THIS conversation -- never infer, guess, or invent a name, number, or date that isn't written below. Each fact must include the source message's seq and a short verbatim evidence snippet copied from that exact message. SAFETY RULE: never copy an actual Aadhaar/PAN/ID number (10+ digits) into value/evidence -- say a document was shared instead.\n\nPRIORITY RULE (apply before picking a category): if a message contains the word "deposit" or "security deposit", its category MUST be "deposit", never "payment" or "rent" -- this holds regardless of any amount, "paid"/"received"/confirmation wording also present in the same message. A deposit mention is never rent income.\n\nPRIORITY RULE: if a message says something like "deduct from rent", "adjust against rent", or an equivalent rent-offset phrase for a repair/expense, use category "maintenance" with fact_type "repair_rent_offset" -- never plain "issue_reported"/"repair_completed" and never category "payment". This is neither an ordinary maintenance record nor ordinary rent income.\n\nValid categories (use exactly these strings as the "category" field -- do not put a category name into fact_type instead): ${WHATSAPP_CATEGORIES.join(', ')}.\n- person: a named individual and their role (tenant/owner/vendor/other) -- NOT a guardian/emergency contact, use guardian_contact for those.\n- guardian_contact: a guardian/parent/spouse/emergency contact named FOR a tenant (not the tenant themselves). value = name (+ relationship if stated). This must be category "guardian_contact", never category "person".\n- property_reference: a flat/unit/address/property name mentioned.\n- payment: a rent amount, payment confirmation, or amount owed -- ONLY when the priority deposit rule above does not apply. fact_type: rent_payment or rent_due.\n- deposit: a deposit amount agreed, paid, or refunded. fact_type: deposit_paid, deposit_agreed, or deposit_refund. If the deposit is stated as a multiple of rent rather than a rupee figure (e.g. "4 months"), use fact_type deposit_basis and put ONLY the number of months in value -- never invent or compute a rupee amount from it.\n- date_milestone: a move-in or move-out date.\n- maintenance: a repair issue. If multiple messages are clearly about the SAME issue, combine them into ONE fact describing the outcome (not one fact per message). fact_type: issue_reported or repair_completed, or repair_rent_offset per the priority rule above.\n- utility_cost: an electricity/water/other bill amount. fact_type: electricity_cost, water_cost, or other_utility_cost.\n- vendor: a named service person/company and contact info, as its own fact.\n- commitment: a promise, follow-up, or agreed exception/special term.\n- document_reference: Aadhaar/PAN/ID being shared or requested (never the number itself).\n\nRespond with ONLY strict JSON, no other text: {"facts": [{"category": string, "fact_type": string, "value": string, "confidence": number (0-1), "evidence": string, "message_seq": number}]}. Empty facts array is valid if nothing is found.\n\nConversation:\n${json}`;
  const res = await aiGateway.run(prompt, { maxTokens: 3000 });
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

module.exports = { summarizeAgreement, extractDeposit, extractAgreementFacts, compareMoveInOut, extractWhatsAppFacts, WHATSAPP_CATEGORIES, WHATSAPP_FACT_TYPES };
