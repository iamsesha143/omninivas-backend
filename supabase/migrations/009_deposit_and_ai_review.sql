-- AI move-in/move-out and deposit assistant. All columns additive/nullable --
-- existing rows and behavior are unaffected until each feature is actually used.

-- Part 1: tenant self-service edit audit trail.
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMP;

-- Part 2: deposit from agreement (AI) or manual entry. Per-tenant split is NOT a
-- new column -- it reuses the existing tenants.deposit_amount column, written by
-- the confirm-deposit endpoint as an equal split across active tenants.
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS deposit_suggested_total NUMERIC;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS deposit_source TEXT; -- 'agreement_ai' | 'manual'
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS deposit_total NUMERIC; -- owner-confirmed value
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS deposit_confirmed_at TIMESTAMP;

-- Part 3: AI move-in vs move-out assistant. Raw AI output lives only on
-- `handovers` (owner-only surface); handover_items gains the owner-confirmed
-- per-item deduction, which is the only AI-derived value ever shown to tenants.
ALTER TABLE public.handovers ADD COLUMN IF NOT EXISTS ai_summary_json JSONB;
ALTER TABLE public.handovers ADD COLUMN IF NOT EXISTS ai_run_at TIMESTAMP;
ALTER TABLE public.handover_items ADD COLUMN IF NOT EXISTS deduction_amount NUMERIC;
ALTER TABLE public.handover_items ADD COLUMN IF NOT EXISTS deduction_reason TEXT;

-- No RLS/policy changes: service_role (server.js) is unaffected either way, and
-- these tables already carry the default-deny posture from 002_enable_rls.sql.
