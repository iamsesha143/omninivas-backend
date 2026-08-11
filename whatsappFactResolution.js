// WhatsApp Resolution Foundation: deterministic (non-AI) helpers for
// resolving a whatsapp_extracted_facts row's "effective" category/fact_type,
// plus a safety net applied at import time that catches the exact failure
// mode a live production message exposed -- explicit "deposit" wording
// landing in category='payment' because the AI prompt had no precedence
// rule. Extracted into its own module (mirrors parsers.js/maintenanceWorkflow.js)
// so this logic is directly unit-testable without needing a configured AI
// gateway -- the import route's extraction step is a no-op in every test
// environment (no gateway key), so testing this only through the full route
// would never actually exercise it.

const PARTICIPANT_ROLES = ['tenant', 'owner', 'vendor', 'broker', 'other', 'unknown'];

// Effective-value resolution: an owner correction always wins over the
// original AI extraction, but the original is never overwritten -- both
// stay readable on the row forever.
const effectiveFactCategory = (fact) => fact.owner_corrected_category || fact.category;
const effectiveFactType = (fact) => fact.owner_corrected_fact_type || fact.fact_type;
const withEffectiveFields = (fact) => ({
  ...fact,
  effective_category: effectiveFactCategory(fact),
  effective_fact_type: effectiveFactType(fact)
});

// Deterministic safety net applied to every freshly-extracted candidate fact,
// right before insert. Never rewrites the original category/fact_type --
// only pre-fills the owner-correction columns, so this stays fully
// auditable and never silently changes already-stored facts (it only ever
// runs on facts being inserted right now).
function applyDepositFirstSafetyNet(fact) {
  if (fact.category !== 'payment') return fact;
  const text = `${fact.evidence || ''} ${fact.value || ''}`.toLowerCase();
  if (!/\bdeposit\b/.test(text)) return fact;
  const fact_type = /refund/.test(text) ? 'deposit_refund' : /agree/.test(text) ? 'deposit_agreed' : 'deposit_paid';
  return { ...fact, owner_corrected_category: 'deposit', owner_corrected_fact_type: fact_type };
}

// Same idea for repair-offset language ("deduct from rent", "adjust against
// rent") -- neither ordinary maintenance nor ordinary rent income, so it
// gets flagged with a distinct fact_type rather than silently collapsing
// into either. Stays within the existing 'maintenance' category.
function applyRepairOffsetSafetyNet(fact) {
  if (fact.category !== 'maintenance') return fact;
  const text = `${fact.evidence || ''} ${fact.value || ''}`.toLowerCase();
  if (!/(deduct|adjust).{0,20}(against\s+)?rent|rent.{0,15}offset/.test(text)) return fact;
  return { ...fact, owner_corrected_fact_type: 'repair_rent_offset' };
}

module.exports = {
  PARTICIPANT_ROLES,
  effectiveFactCategory,
  effectiveFactType,
  withEffectiveFields,
  applyDepositFirstSafetyNet,
  applyRepairOffsetSafetyNet
};
