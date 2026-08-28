-- Per-message WhatsApp send log, dark-mode from day one. Same table shape
-- will be used once real sends go live (dark_mode false, provider_message_id
-- populated) -- built now so the whole pipeline (eligibility, content,
-- dedup) is provably correct before any real BSP credential exists.
CREATE TABLE whatsapp_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL REFERENCES users(id),
  notification_id UUID REFERENCES notifications(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  deep_link TEXT,
  dark_mode BOOLEAN NOT NULL DEFAULT true,
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_whatsapp_notifications_recipient ON whatsapp_notifications(recipient_user_id, created_at DESC);

ALTER TABLE whatsapp_notifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE reminder_job_runs ADD COLUMN IF NOT EXISTS whatsapp_sent INTEGER NOT NULL DEFAULT 0;
