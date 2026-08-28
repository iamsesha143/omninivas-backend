-- Dark-architecture prep for Razorpay UPI collection -- no real Razorpay
-- account exists yet (see razorpayClient.js), but the schema is built now
-- so the webhook handler's idempotency guarantee (a UNIQUE constraint, not
-- just an application-level check) is real and testable against synthetic
-- payloads before any live traffic ever reaches it.
--
-- payment_method already exists on this table (free-text, nullable, no
-- migration ever defined it -- pre-dates this repo's migrations/ directory,
-- confirmed live: 'upi'/null values, no CHECK constraint) -- the webhook
-- handler writes 'razorpay' into it, no schema change needed for that part.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT UNIQUE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS razorpay_payment_link_id TEXT;
