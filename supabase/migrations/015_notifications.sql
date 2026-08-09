-- Phase 1B: in-app owner/tenant reminder notifications, plus a job-run log
-- for the standalone Railway Cron script (jobs/runReminders.js). Additive
-- only. NOT executed as part of this change -- reviewed and approved before
-- being run against any database, per this repo's established migration
-- discipline (see 014_maintenance_equipment_vendor_rent_credits.sql).
--
-- No policies are created -- default-deny once RLS is enabled, matching
-- every other table since 002_enable_rls.sql. server.js (and this job) run
-- on the service_role key and bypass RLS entirely; RLS here only closes
-- Supabase's auto-generated PostgREST REST API surface, per that
-- migration's own documented rationale.

BEGIN;

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Recipient (always server-derived from the source row's own user_id /
  -- tenant login -- never accepted as client input by any route).
  recipient_user_id UUID NOT NULL,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('owner', 'tenant')),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,

  -- What this reminder is about.
  category TEXT NOT NULL CHECK (category IN (
    'warranty_expiry', 'agreement_renewal', 'rent_due', 'rent_overdue',
    'maintenance_urgent', 'settlement_pending'
  )),
  source_type TEXT NOT NULL CHECK (source_type IN ('appliance', 'property', 'obligation', 'maintenance_cost', 'rent_credit')),
  source_id UUID NOT NULL,

  -- Signed-offset scheduling (see reminders.js). event_date is the actual
  -- source date being reminded about (warranty_end, agreement end, a
  -- specific month's rent due date, or the source row's own creation date
  -- for the two "still open" categories). offset_label is the stable,
  -- human-readable identity of which configured reminder slot this is
  -- ('2_months', '5_days_before', 'open', ...) -- used in the dedupe key
  -- instead of trigger_offset_days because month-based offsets don't have
  -- a fixed day-count. trigger_offset_days is the resulting signed day
  -- delta (negative=before, 0=on, positive=after), stored for display/
  -- debugging, not as the mechanical driver of scheduled_for for
  -- month-based categories.
  event_date DATE NOT NULL,
  offset_label TEXT NOT NULL,
  trigger_offset_days INTEGER NOT NULL,
  scheduled_for DATE NOT NULL,

  -- Deterministic identity: category:source_type:source_id:offset_label:event_date:recipient_user_id
  dedupe_key TEXT NOT NULL,

  title TEXT NOT NULL,
  body TEXT NOT NULL,
  deep_link TEXT,

  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'dismissed', 'snoozed', 'invalidated')),
  snoozed_until DATE,
  invalidated_at TIMESTAMPTZ,
  invalidation_reason TEXT CHECK (invalidation_reason IS NULL OR invalidation_reason IN (
    'source_date_changed', 'obligation_paid', 'tenancy_inactive',
    'maintenance_resolved', 'maintenance_rejected', 'settlement_applied', 'settlement_cancelled'
  )),
  read_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Database-level consistency: these fields may only be populated
  -- together with their matching status, in both directions.
  CONSTRAINT chk_notifications_snoozed_requires_until
    CHECK (status != 'snoozed' OR snoozed_until IS NOT NULL),
  CONSTRAINT chk_notifications_snoozed_until_only_when_snoozed
    CHECK (status = 'snoozed' OR snoozed_until IS NULL),
  CONSTRAINT chk_notifications_invalidated_requires_fields
    CHECK (status != 'invalidated' OR (invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL)),
  CONSTRAINT chk_notifications_invalidation_fields_only_when_invalidated
    CHECK (status = 'invalidated' OR (invalidated_at IS NULL AND invalidation_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe ON public.notifications(dedupe_key);
-- Recipient-list queries (GET /api/notifications, GET /api/tenant/notifications).
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_list ON public.notifications(recipient_user_id, status, scheduled_for);
-- Daily job's snooze-reopen pass: find all snoozed rows whose snoozed_until has arrived.
CREATE INDEX IF NOT EXISTS idx_notifications_snoozed_due ON public.notifications(status, snoozed_until) WHERE status = 'snoozed';
-- Daily job's invalidation pass: find existing active rows for a given source to invalidate.
CREATE INDEX IF NOT EXISTS idx_notifications_source ON public.notifications(source_type, source_id, category, status);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- ---- Job-run log (operator visibility: did last night's run happen, did it fail) ----
CREATE TABLE IF NOT EXISTS public.reminder_job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  notifications_created INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminder_job_runs_started ON public.reminder_job_runs(started_at DESC);

ALTER TABLE public.reminder_job_runs ENABLE ROW LEVEL SECURITY;

COMMIT;
