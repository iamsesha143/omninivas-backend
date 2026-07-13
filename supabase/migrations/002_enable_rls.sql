-- ============================================================================
-- Enable Row Level Security on all public tables
-- ============================================================================
--
-- Context (custom-JWT architecture, not Supabase Auth):
--
--   - server.js is the ONLY thing that talks to Supabase, and it always uses
--     the service_role key. service_role has the BYPASSRLS attribute at the
--     Postgres level, so RLS is never evaluated for it. Enabling RLS here has
--     ZERO effect on backend behavior or existing queries.
--
--   - The frontend never calls Supabase directly (no Supabase client, no
--     anon key usage, no session). RLS only governs the `anon` and
--     `authenticated` Postgres roles, neither of which the frontend ever
--     assumes. Enabling RLS has no effect on the frontend either.
--
--   - The actual thing this migration protects against: Supabase exposes
--     every table via an auto-generated PostgREST REST API
--     (https://<project>.supabase.co/rest/v1/<table>) regardless of whether
--     the app chooses to use it. With RLS disabled, anyone holding the
--     project's anon key can read/write these tables directly, completely
--     bypassing server.js, our custom JWT check, and all authorization
--     logic. That key can leak via git history, .env files, decompiled
--     mobile builds, or simple guessing of the project ref. This migration
--     closes that direct-access surface.
--
--   - No policies are created below. With RLS enabled and zero policies,
--     access defaults to deny for every role except service_role (which
--     bypasses RLS entirely, per above). That default-deny posture is
--     correct for this architecture: our custom JWT claims (user_id, role)
--     are not understood by Postgres/PostgREST — we are not using Supabase
--     Auth, so auth.uid() would resolve to NULL for any request under the
--     anon/authenticated roles. Writing ownership-style policies against
--     auth.uid() today would be meaningless. Real authorization (who can
--     see which tenant's data, owner vs. tenant role) continues to live in
--     server.js, where our JWT claims are actually verified.
--
-- ============================================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.co_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.other_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appliances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.co_occupants ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Future extension: ownership policies if we ever adopt Supabase Auth
-- ============================================================================
--
-- If this project ever switches from custom JWT to Supabase Auth (i.e. Auth
-- issues the JWT and auth.uid() reflects a real authenticated user), the
-- default-deny posture above can be relaxed with row-ownership policies.
-- Example pattern for the `authenticated` role, keyed off a user_id column
-- (adjust per table — some tables key off property_id/tenant_id instead):
--
--   CREATE POLICY "owners can read their own properties"
--     ON public.properties
--     FOR SELECT
--     TO authenticated
--     USING (user_id = auth.uid());
--
--   CREATE POLICY "owners can modify their own properties"
--     ON public.properties
--     FOR ALL
--     TO authenticated
--     USING (user_id = auth.uid())
--     WITH CHECK (user_id = auth.uid());
--
-- For tenant-scoped tables (e.g. public.tenants), a tenant should only see
-- their own row, which requires either:
--   (a) a tenants.auth_user_id column mapped to Supabase Auth's auth.uid(), or
--   (b) a SECURITY DEFINER helper function that resolves the current
--       Supabase Auth user to the corresponding tenants.id.
--
-- Until Supabase Auth is adopted, do NOT add authenticated/anon policies —
-- there is no trustworthy identity for PostgREST to check them against, and
-- a permissive-looking policy here would be worse than the current
-- default-deny, since it could be misread as "this table is protected" when
-- it would actually be gated on a claim that's always NULL.
-- ============================================================================
