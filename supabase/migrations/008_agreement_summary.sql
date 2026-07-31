-- Phase 2 LLM proof point: store the AI-generated agreement summary (Claude Haiku 4.5)
-- produced at property-creation time from OCR'd rental-agreement text, so both the
-- owner (Tenants/Agreement card) and the tenant (tenant portal home) see the same
-- clearly-labeled summary later, not just at the moment of extraction. Nullable and
-- additive -- existing rows are unaffected, no RLS/policy change (existing table-level
-- RLS from 002_enable_rls.sql already covers this column; service_role is unaffected).
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS agreement_summary TEXT;
