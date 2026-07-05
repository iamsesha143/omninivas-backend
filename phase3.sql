-- ============================================================
-- OMniNivas PHASE 3 — Tenant login + richer tenant fields
-- Run ONCE in Supabase: SQL Editor -> paste -> Run -> "Run without RLS"
-- Additive only — nothing is deleted.
-- ============================================================

-- USERS: role distinguishes owner vs tenant logins
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'owner';

-- TENANTS: link to a login account + deposit + screening fields
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS login_user_id UUID;      -- the users row this tenant logs in with
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deposit_paid_date DATE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deposit_details TEXT;      -- mode / reference
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deposit_refunded_amount NUMERIC;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deposit_refunded_date DATE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS profession TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS employer TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS police_verification_status TEXT DEFAULT 'pending';  -- pending | done

-- CO-OCCUPANTS: the other people living with the primary tenant
CREATE TABLE IF NOT EXISTS co_occupants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  relationship TEXT,       -- spouse | child | parent | friend | colleague | other
  age INTEGER,
  phone TEXT,
  id_type TEXT,            -- aadhaar | pan | passport | other
  id_number TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
