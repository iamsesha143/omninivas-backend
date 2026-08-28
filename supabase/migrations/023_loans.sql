-- Phase 5 (mortgage/EMI) spike -- manual entry only, deliberately no live
-- bank connection. A real connection needs RBI's Account Aggregator
-- framework (FIU registration + a licensed AA provider), a separate,
-- much larger undertaking than this smoke test; see CLAUDE.md.
CREATE TABLE loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  user_id UUID NOT NULL REFERENCES users(id),
  lender_name TEXT NOT NULL,
  principal NUMERIC NOT NULL CHECK (principal > 0),
  interest_rate NUMERIC NOT NULL CHECK (interest_rate > 0 AND interest_rate < 100), -- annual %, e.g. 8.5
  tenure_months INTEGER NOT NULL CHECK (tenure_months > 0),
  emi_amount NUMERIC NOT NULL CHECK (emi_amount > 0),
  start_date DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_loans_property ON loans(property_id);

ALTER TABLE loans ENABLE ROW LEVEL SECURITY;
