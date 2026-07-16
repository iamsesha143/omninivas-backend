-- Phase 3: email notification preferences (WhatsApp column is schema-only prep,
-- not implemented yet -- it needs its own DPDP-compliant opt-in flow later).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN NOT NULL DEFAULT false;
