-- WhatsApp deposit-basis fix: a chat deposit clause is very often stated as
-- a multiple of rent ("Deposit: 4 months") rather than a rupee figure.
-- Without a structured place to put that, the bare number ("4") risks being
-- read downstream as a ₹4 deposit -- confirmed as a real failure mode
-- against the Flat 512 import fixture. These two columns hold that basis
-- distinctly from any currency amount; whatsappFactResolution.js's
-- applyDepositBasisSafetyNet populates them at import time for fact_type
-- 'deposit_basis' only. Purely additive, nullable, no backfill needed --
-- existing rows simply have both columns null (not a basis fact).

ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS basis_value NUMERIC;
ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS basis_unit TEXT;

-- Rollback (manual, if ever needed):
--   ALTER TABLE public.whatsapp_extracted_facts DROP COLUMN IF EXISTS basis_value;
--   ALTER TABLE public.whatsapp_extracted_facts DROP COLUMN IF EXISTS basis_unit;
-- Safe to roll back: both columns are additive, never referenced by any
-- foreign key, and no other table depends on their presence -- a fact whose
-- fact_type is 'deposit_basis' just loses its structured value/unit back to
-- whatever owner_edited_value/value free text already holds.
