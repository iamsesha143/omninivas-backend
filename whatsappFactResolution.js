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

// A WhatsApp deposit is very commonly stated as a multiple of rent ("Deposit:
// 4 months") rather than a rupee figure. Without this net, a bare "4" reads
// downstream as if it were a ₹4 deposit -- a real failure mode confirmed
// against the Flat 512 import fixture. Structures it as {basis_value:4,
// basis_unit:'months'} instead, a shape that the frontend deliberately has
// no currency-apply path for (evidence/reference only, see index.jsx). Runs
// LAST in the safety-net chain (server.js) so month-basis phrasing always
// wins over applyDepositFirstSafetyNet's generic 'deposit_paid' default --
// it reads the fact's ORIGINAL category, not owner_corrected_category, so
// it fires the same whether the AI first called this 'payment' or 'deposit'.
function applyDepositBasisSafetyNet(fact) {
  if (fact.category !== 'payment' && fact.category !== 'deposit') return fact;
  const text = `${fact.evidence || ''} ${fact.value || ''}`.toLowerCase();
  if (!/\bdeposit\b/.test(text)) return fact;
  const monthsMatch = text.match(/(\d{1,3})\s*(?:months?|mo\.?)\b/);
  if (!monthsMatch) return fact;
  return {
    ...fact,
    owner_corrected_category: 'deposit',
    owner_corrected_fact_type: 'deposit_basis',
    basis_value: parseInt(monthsMatch[1], 10),
    basis_unit: 'months'
  };
}

module.exports = {
  PARTICIPANT_ROLES,
  effectiveFactCategory,
  effectiveFactType,
  withEffectiveFields,
  applyDepositFirstSafetyNet,
  applyRepairOffsetSafetyNet,
  applyDepositBasisSafetyNet
};
