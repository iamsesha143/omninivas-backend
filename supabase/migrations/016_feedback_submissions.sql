-- Help & Feedback (in-app, no email/notification workflow). Capture-only:
-- no status/review workflow, no reply mechanism, no admin UI in this slice
-- (Supabase table editor is the interim review path).
--
-- No FK to properties, deliberately -- this is a denormalized name snapshot
-- at submission time, not a live reference. Avoids coupling to a property
-- row that could later be soft-deleted, and avoids needing tenant-side
-- property_id plumbing this slice deliberately skips (GET /api/tenant/home
-- doesn't currently select property.id -- out of scope to change here).
--
-- user_id/role are always server-derived from the verified JWT
-- (POST /api/feedback in server.js) -- never trusted from client input.

CREATE TABLE IF NOT EXISTS public.feedback_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'tenant')),
  category TEXT NOT NULL CHECK (category IN ('bug', 'feature_request', 'question', 'other')),
  message TEXT NOT NULL,
  page TEXT,
  app_version TEXT,
  property_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_user ON public.feedback_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created ON public.feedback_submissions(created_at);

-- Same default-deny posture as every other table (002_enable_rls.sql):
-- server.js uses the service_role key (bypasses RLS entirely); this closes
-- Supabase's auto-generated PostgREST REST API surface for this table. No
-- policies -- there is no trustworthy identity for PostgREST to check them
-- against under this custom-JWT architecture.
ALTER TABLE public.feedback_submissions ENABLE ROW LEVEL SECURITY;
