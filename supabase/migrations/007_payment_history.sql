-- Phase 1 foundation fix: audit trail for payment status/amount edits.
--
-- PATCH /api/payments/:id previously overwrote status/amount/notes in place with no
-- history -- for a product whose stated #1 differentiator is resolving deposit/payment
-- disputes fairly, that meant the app itself had no record to arbitrate a dispute
-- beyond "trust the current row." This table captures every edit; server.js writes to
-- it inline (no trigger -- this codebase has none, and an inline insert matches its
-- existing plain-Node-logic style).

CREATE TABLE IF NOT EXISTS payment_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  changed_by UUID NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  previous_amount NUMERIC,
  new_amount NUMERIC,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_history_payment ON payment_history(payment_id);

ALTER TABLE payment_history ENABLE ROW LEVEL SECURITY;
-- No policies added, matching 002_enable_rls.sql's established posture: default-deny
-- for anon/authenticated, service_role (server.js) is unaffected.
