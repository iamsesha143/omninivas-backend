-- ============================================================
-- OMniNivas PHASE 2 — Assets, Vendors, Tenant self-service, Renewals
-- Run ONCE in Supabase: SQL Editor -> paste -> Run -> "Run without RLS"
-- (matches the rest of the app; backend enforces user_id isolation)
-- ============================================================

-- APPLIANCES: geyser, AC, fridge... per property, with warranty + service info
CREATE TABLE IF NOT EXISTS appliances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,                       -- "Geyser - bathroom"
  category TEXT DEFAULT 'other',            -- geyser | ac | fridge | washing_machine | fan | other
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  purchase_date DATE,
  warranty_end DATE,
  amc_provider TEXT,
  service_phone TEXT,
  bill_url TEXT,                            -- uploaded purchase bill
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- VENDORS: plumbers, electricians, carpenters the owner calls (reusable across properties)
CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  trade TEXT DEFAULT 'other',              -- plumber | electrician | carpenter | painter | appliance | other
  phone TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- TENANTS: self-service invite token (tenant fills their own extra details)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS share_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS vehicle_number TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS alternate_phone TEXT;

-- PROPERTIES: agreement dates for renewal reminders
ALTER TABLE properties ADD COLUMN IF NOT EXISTS agreement_start_date DATE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS agreement_months INTEGER DEFAULT 11;
