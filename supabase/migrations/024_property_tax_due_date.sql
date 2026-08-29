-- Phase 6 (document-expiry reminders): property tax specifically. Agreement
-- renewal reminders already exist and run via the reminders engine; this
-- adds the same treatment for property tax, which had no field to hang a
-- reminder on at all until now.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_tax_due_date DATE;
