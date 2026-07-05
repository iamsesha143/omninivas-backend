-- OMniNivas database alignment fix (July 2026)
-- The tables in Supabase were created stricter than the app needs.
-- Run this ONCE in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to run multiple times.

-- USERS: store password hashes so logins are actually verified
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- TENANTS: app allows tenants with phone only, and move-in date is optional
ALTER TABLE tenants ALTER COLUMN personal_email DROP NOT NULL;
ALTER TABLE tenants ALTER COLUMN date_of_move_in DROP NOT NULL;
ALTER TABLE tenants ALTER COLUMN occupancy_type SET DEFAULT 'single';
ALTER TABLE tenants ALTER COLUMN occupancy_type DROP NOT NULL;

-- PAYMENTS: app tracks a paid/pending status; type and method are optional details
ALTER TABLE payments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'paid';
ALTER TABLE payments ALTER COLUMN payment_type SET DEFAULT 'rent';
ALTER TABLE payments ALTER COLUMN payment_type DROP NOT NULL;
ALTER TABLE payments ALTER COLUMN payment_method DROP NOT NULL;

-- STORAGE: allow the app to upload and list files in the "documents" bucket
-- (create the bucket first: Storage -> New bucket -> "documents")
DROP POLICY IF EXISTS "app can upload documents" ON storage.objects;
DROP POLICY IF EXISTS "app can read documents" ON storage.objects;
CREATE POLICY "app can upload documents" ON storage.objects
  FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = 'documents');
CREATE POLICY "app can read documents" ON storage.objects
  FOR SELECT TO anon, authenticated USING (bucket_id = 'documents');

-- MAINTENANCE_COSTS: app uses cost_date + status; category/cost_type are optional
ALTER TABLE maintenance_costs DROP CONSTRAINT IF EXISTS valid_category;
ALTER TABLE maintenance_costs ADD COLUMN IF NOT EXISTS cost_date DATE DEFAULT CURRENT_DATE;
ALTER TABLE maintenance_costs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE maintenance_costs ALTER COLUMN cost_type SET DEFAULT 'repair';
ALTER TABLE maintenance_costs ALTER COLUMN cost_type DROP NOT NULL;
ALTER TABLE maintenance_costs ALTER COLUMN maintenance_date DROP NOT NULL;
ALTER TABLE maintenance_costs ALTER COLUMN category DROP NOT NULL;
