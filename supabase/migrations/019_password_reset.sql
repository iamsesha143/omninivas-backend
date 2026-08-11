-- Password Reset: self-service account recovery. Additive columns on
-- `users`, all nullable. Only a HASH of the reset token is ever stored
-- (SHA-256 of a 256-bit crypto.randomBytes token) -- the raw token exists
-- only in the emailed link and in the browser URL, never in the database.
-- SHA-256 (not bcrypt) is the correct/standard choice here: the token
-- already carries 256 bits of entropy, so the threat this hash defends
-- against is "can the token be recovered from a DB dump," not "can it be
-- brute-forced offline" (a slow hash like bcrypt exists specifically for
-- the latter, which doesn't apply to a token this large).
--
-- A new forgot-password request simply overwrites these three columns,
-- which is what invalidates any prior outstanding token for that user (the
-- old raw token's hash no longer matches anything in the DB). Single-use is
-- enforced by password_reset_used_at: reset-password checks it IS NULL
-- before accepting a token, and a successful reset both clears the
-- hash/expiry AND stamps used_at, so the same raw token can never work
-- twice even if somehow re-submitted.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_reset_used_at TIMESTAMPTZ;

-- Partial index: only rows with an outstanding token are ever looked up by
-- this column (reset-password's token-hash lookup), and most rows will have
-- it NULL almost all the time.
CREATE INDEX IF NOT EXISTS idx_users_password_reset_token_hash
  ON public.users(password_reset_token_hash) WHERE password_reset_token_hash IS NOT NULL;

-- Rollback (manual, if ever needed):
--   DROP INDEX IF EXISTS idx_users_password_reset_token_hash;
--   ALTER TABLE public.users DROP COLUMN IF EXISTS password_reset_token_hash;
--   ALTER TABLE public.users DROP COLUMN IF EXISTS password_reset_expires_at;
--   ALTER TABLE public.users DROP COLUMN IF EXISTS password_reset_used_at;
-- Safe to roll back: all three columns are additive, no FK, nothing else
-- reads or depends on them. Any outstanding (unused) reset link would simply
-- stop working, which is the same effect as it expiring.
