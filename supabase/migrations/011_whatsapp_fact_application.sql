-- WhatsApp v2: track when/where an approved fact was applied into real records.
-- Additive only. The actual writes still go through the SAME existing endpoints
-- used for manual entry (PATCH /api/tenants/:id, PATCH /api/properties/:id,
-- PATCH /api/properties/:id/deposit, PATCH /api/obligations/:id, POST tenants/
-- maintenance/vendors) -- these columns are purely an audit/status marker set
-- by PATCH /api/whatsapp/facts/:id/apply after that write already succeeded.
ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS applied_to TEXT; -- e.g. 'tenant:<uuid>', 'property:<uuid>:flat_number'
ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS applied_payload JSONB;
ALTER TABLE public.whatsapp_extracted_facts ADD COLUMN IF NOT EXISTS applied_by UUID;

-- No RLS/policy changes: table already has RLS enabled with no policies
-- (default-deny for anon/authenticated) from 010_whatsapp_import.sql.
