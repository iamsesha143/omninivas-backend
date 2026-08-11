-- WhatsApp Resolution Foundation: lets an owner correct a fact's category,
-- fact type, property link, and participant role BEFORE approval, without
-- ever overwriting the original AI extraction (category/fact_type/value/
-- confidence/evidence/message_seq stay untouched -- these are pure additive
-- correction columns, all nullable). Existing rows need no backfill: reading
-- them with all-null correction columns already produces correct "effective"
-- values via the app's own fallback-to-original logic.

ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS owner_corrected_category TEXT;
ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS owner_corrected_fact_type TEXT;
ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL;
ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS participant_role TEXT DEFAULT 'unknown'
  CHECK (participant_role IN ('tenant', 'owner', 'vendor', 'broker', 'other', 'unknown'));
ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS participant_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_whatsapp_facts_property ON public.whatsapp_extracted_facts(property_id);

-- No RLS/policy changes: table already has RLS enabled with no policies
-- (default-deny for anon/authenticated) from 010_whatsapp_import.sql;
-- service_role (server.js) is unaffected either way.

-- Rollback (manual, if ever needed):
--   ALTER TABLE public.whatsapp_extracted_facts DROP COLUMN IF EXISTS owner_corrected_category;
--   ALTER TABLE public.whatsapp_extracted_facts DROP COLUMN IF EXISTS owner_corrected_fact_type;
--   ALTER TABLE public.whatsapp_extracted_facts DROP COLUMN IF EXISTS property_id;
--   ALTER TABLE public.whatsapp_extracted_facts DROP COLUMN IF EXISTS participant_role;
--   ALTER TABLE public.whatsapp_extracted_facts DROP COLUMN IF EXISTS participant_ref;
--   DROP INDEX IF EXISTS idx_whatsapp_facts_property;
-- Safe to roll back: all five columns are additive correction/provenance
-- metadata, never referenced by any foreign key pointing INTO this table,
-- and no other table depends on their presence.
