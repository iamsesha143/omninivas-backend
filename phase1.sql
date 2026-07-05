-- ============================================================
-- OMniNivas: FRESH START + PHASE 1 (Rent & Bills)  — July 2026
-- Run ONCE in Supabase: SQL Editor -> New query -> paste -> Run
-- ============================================================

-- 1) WIPE ALL DATA (requested fresh start — deletes every account,
--    property, tenant, payment, and uploaded document)
TRUNCATE TABLE payments, maintenance_costs, tenants, properties, users CASCADE;
DELETE FROM storage.objects WHERE bucket_id = 'documents';

-- 2) OBLIGATIONS: recurring dues per property (rent, electricity,
--    society maintenance, water...) with who-pays and due day
CREATE TABLE IF NOT EXISTS obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',          -- rent | electricity | water | society_maintenance | other
  label TEXT NOT NULL,                          -- what the owner calls it
  amount NUMERIC,                               -- null = varies month to month
  due_day INTEGER NOT NULL DEFAULT 5,           -- day of month it's due
  paid_by TEXT NOT NULL DEFAULT 'tenant',       -- owner | tenant
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 3) PAYMENTS: link a payment to an obligation + month, with proof
ALTER TABLE payments ADD COLUMN IF NOT EXISTS obligation_id UUID;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period DATE;         -- first day of the month it covers
ALTER TABLE payments ADD COLUMN IF NOT EXISTS proof_url TEXT;      -- uploaded screenshot path
ALTER TABLE payments ALTER COLUMN tenant_id DROP NOT NULL;         -- owner-paid bills have no tenant
