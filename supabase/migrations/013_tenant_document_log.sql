-- Document/verification history for a tenant: a lightweight append-only log
-- (not a new table) so WhatsApp document_reference facts (Aadhaar/PAN/ID
-- proof mentions) have somewhere real to land instead of staying
-- informational-only. Each entry is {date, note, source, evidence} -- never
-- the actual document number (that's redacted before it ever reaches the DB,
-- see server.js's redactLongDigitRuns). Additive only.
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS document_log JSONB NOT NULL DEFAULT '[]'::jsonb;
