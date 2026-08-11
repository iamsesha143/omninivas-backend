-- Agreement Intake Completion: fixtures approved from an agreement's review
-- step need a quantity (e.g. "Fans x3") and a provenance marker distinguishing
-- them from a manually-added appliance (AssetsPage), so the review flow can
-- safely dedupe agreement-sourced rows without touching manual-add behavior.
-- Both columns are nullable-safe with defaults -- purely additive, no
-- backfill needed, no existing query depends on their absence.

ALTER TABLE appliances ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;
ALTER TABLE appliances ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'agreement'));

-- Rollback (manual, if ever needed):
--   ALTER TABLE appliances DROP COLUMN IF EXISTS quantity;
--   ALTER TABLE appliances DROP COLUMN IF EXISTS source;
-- Safe to roll back: both columns are additive display/provenance metadata,
-- not referenced by any foreign key or by existing rows' meaning.
