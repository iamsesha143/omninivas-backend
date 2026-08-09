-- Maintenance approval workflow, equipment condition lifecycle, vendor
-- approval, and an auditable rent-credit/reimbursement ledger. Additive
-- only -- no existing column is renamed, retyped, or dropped; no existing
-- RLS policy is touched. Designed for a single, tracked migration
-- execution. IF NOT EXISTS prevents duplicate-object errors on a rerun,
-- but does not reconcile an existing object whose definition differs from
-- this migration. Run as a single transaction (BEGIN/COMMIT), no
-- CREATE INDEX CONCURRENTLY.
--
-- amount >= 0 on the pre-existing maintenance_costs.amount column is
-- deliberately NOT added as a DB CHECK here (avoids constraint-naming/
-- idempotency complexity on an existing column across reruns; confirmed via
-- live query before writing this migration: 0 of 4 existing rows violate
-- it). Non-negativity is enforced server-side in the API layer instead,
-- consistent with how paid_by is already validated in this codebase today.

BEGIN;

-- ---- maintenance_costs: approval lifecycle + equipment/vendor link + evidence ----
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS request_status TEXT NOT NULL DEFAULT 'resolved'
    CHECK (request_status IN ('reported','awaiting_approval','approved','rejected','in_progress','resolved'));
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS reported_by TEXT
    CHECK (reported_by IN ('tenant','owner'));
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS appliance_id UUID REFERENCES public.appliances(id) ON DELETE SET NULL;
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES public.vendors(id) ON DELETE SET NULL;
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS urgency TEXT
    CHECK (urgency IN ('low','normal','high'));
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS requested_amount NUMERIC
    CHECK (requested_amount IS NULL OR requested_amount > 0);
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS owner_decision_note TEXT;
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS evidence_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS decided_by UUID;          -- who approved/rejected (owner's user_id)
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE public.maintenance_costs
  ADD COLUMN IF NOT EXISTS source_ref JSONB;
  -- {"type":"whatsapp"|"agreement"|"manual"|"tenant_app","import_id":..,"message_seq":..,"fact_id":..}

CREATE INDEX IF NOT EXISTS idx_maintenance_costs_appliance ON public.maintenance_costs(appliance_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_costs_vendor ON public.maintenance_costs(vendor_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_costs_request_status ON public.maintenance_costs(request_status);

-- Explicit backfill: every pre-existing row was created via the owner-only
-- flow that existed before this migration (confirmed live: 4 rows total,
-- 0 negative amounts, before writing this migration).
UPDATE public.maintenance_costs SET reported_by = 'owner' WHERE reported_by IS NULL;

-- All rows are now backfilled -- make the column mandatory so no future
-- maintenance record can be inserted with an unknown reporter.
ALTER TABLE public.maintenance_costs
  ALTER COLUMN reported_by SET NOT NULL;

-- ---- appliances: condition lifecycle ----
ALTER TABLE public.appliances
  ADD COLUMN IF NOT EXISTS condition_status TEXT NOT NULL DEFAULT 'working'
    CHECK (condition_status IN ('working','needs_verification','issue_reported','under_repair','repaired','replaced','removed'));

-- ---- vendors: owner approval flag ----
ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- ---- rent_credits: new auditable adjustment ledger ----
CREATE TABLE IF NOT EXISTS public.rent_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  maintenance_cost_id UUID REFERENCES public.maintenance_costs(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('rent_credit','reimbursement')),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','cancelled')),
  applicable_period DATE,               -- normalized to first-of-month, enforced server-side
  applied_payment_id UUID REFERENCES public.payments(id) ON DELETE SET NULL,
  settlement_method TEXT
    CHECK (settlement_method IS NULL OR settlement_method IN ('cash','upi','bank_transfer','cheque','rent_deduction','other')),
  settlement_reference TEXT,            -- UTR/cheque no./free-text proof reference
  settled_by UUID,                      -- who marked it settled (owner's user_id)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rent_credits_property ON public.rent_credits(property_id);
CREATE INDEX IF NOT EXISTS idx_rent_credits_tenant ON public.rent_credits(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rent_credits_maintenance ON public.rent_credits(maintenance_cost_id);
CREATE INDEX IF NOT EXISTS idx_rent_credits_status ON public.rent_credits(status);

-- Hard guardrail: at most ONE active settlement (either type) per
-- maintenance event -- a reimbursement and a rent_credit can never both be
-- active for the same repair, enforced at the DB level, not just the API.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rent_credits_active_per_maintenance
  ON public.rent_credits(maintenance_cost_id)
  WHERE status != 'cancelled';

ALTER TABLE public.rent_credits ENABLE ROW LEVEL SECURITY;
-- No policies -- matches default-deny posture of every other table since
-- 002_enable_rls.sql. server.js runs on service_role (bypasses RLS
-- regardless); RLS here only closes Supabase's auto-generated PostgREST
-- surface, per that migration's own documented rationale.

COMMIT;
