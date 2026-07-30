-- Phase 1 foundation fix: remove anon/authenticated bucket-wide access to the
-- `documents` storage bucket (Aadhaar/PAN/deed/payment-proof/handover-photo files).
--
-- These two policies (added 2026-07-05 in supabase-fix.sql, before the RLS work in
-- 002-005) predate this project's move to a documented service_role architecture and
-- were never revisited by it. server.js is the ONLY Supabase client and always uses
-- the service_role key (see 002_enable_rls.sql), which bypasses storage.objects
-- policies entirely -- so dropping these has zero effect on backend behavior. What it
-- does close: Supabase's storage layer, like its REST API, is reachable directly by
-- anyone holding the project's anon key, completely bypassing server.js and its JWT
-- checks. With these policies in place, that meant unauthenticated read+write access
-- to every file in the bucket, gated only by path secrecy.
DROP POLICY IF EXISTS "app can upload documents" ON storage.objects;
DROP POLICY IF EXISTS "app can read documents" ON storage.objects;

-- No replacement policy is created: with RLS enabled on storage.objects (Supabase's
-- default for a non-public bucket) and zero policies, anon/authenticated access
-- defaults to deny, matching the same posture 002_enable_rls.sql already established
-- for every public.* table. service_role (server.js) is unaffected either way.
