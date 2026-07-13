-- ============================================================================
-- Ownership policies for public.properties and public.tenants
-- ============================================================================
--
-- Prepared groundwork — not yet functional under the current architecture:
--
--   - These policies apply to the `authenticated` Postgres role and key off
--     auth.uid(). Under today's custom-JWT setup (see 002_enable_rls.sql),
--     no request ever reaches PostgREST as `authenticated` with a resolvable
--     auth.uid(): the frontend never calls Supabase directly, and the
--     backend always uses service_role, which bypasses RLS entirely
--     regardless of what policies exist. So right now these policies are
--     inert — auth.uid() evaluates to NULL, `user_id = NULL` is never true,
--     and access for the authenticated role stays denied exactly as it was
--     under the prior default-deny (no-policy) state from 002. Nothing
--     about current app behavior changes.
--
--   - They activate automatically, with no further migration work, if this
--     project later adopts Supabase Auth (auth.uid() starts resolving to
--     real user ids) or a custom-JWT-compatible auth.jwt() bridge that
--     Supabase can verify. At that point these are the ownership rules that
--     will already be in force.
--
-- ============================================================================

-- properties: owned directly by user_id
CREATE POLICY "owners can select their own properties"
  ON public.properties
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "owners can insert their own properties"
  ON public.properties
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "owners can update their own properties"
  ON public.properties
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "owners can delete their own properties"
  ON public.properties
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- tenants: two distinct ownership vectors exist on this table —
--   user_id        -> the property owner who manages this tenant record
--   login_user_id  -> the tenant's own account, for tenants who have login access
CREATE POLICY "owners can select their own tenants"
  ON public.tenants
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "tenants can select their own record"
  ON public.tenants
  FOR SELECT
  TO authenticated
  USING (login_user_id = auth.uid());

CREATE POLICY "owners can insert their own tenants"
  ON public.tenants
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "owners can update their own tenants"
  ON public.tenants
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "owners can delete their own tenants"
  ON public.tenants
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE/DELETE policy keyed on login_user_id: a
-- tenant should not be able to alter their own tenant record (deposit
-- amounts, move-in dates, verification flags, etc.) via direct table
-- access. If tenant self-service editing is needed later, scope it to
-- specific columns via a SECURITY DEFINER function, not a blanket
-- table-level policy.
-- ============================================================================
