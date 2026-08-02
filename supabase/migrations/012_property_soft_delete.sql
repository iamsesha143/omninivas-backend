-- Safe property deletion: soft-delete only (deleted_at timestamp), never a hard
-- DELETE. Reversible, no cascade risk to tenants/obligations/payments/handovers.
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
