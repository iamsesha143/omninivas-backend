-- WhatsApp import v1: upload an exported chat, parse into structured messages,
-- run AI extraction into reviewable candidate facts. Nothing here is auto-linked
-- to core production entities (properties/tenants/obligations) -- approving a
-- fact only flips its own status in whatsapp_extracted_facts, it does not write
-- to any other table. That write-back is explicitly deferred to a later phase.

CREATE TABLE IF NOT EXISTS public.whatsapp_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL, -- nullable: import can stay unattached
  file_name TEXT,
  message_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded|parsed|extracted|extraction_unavailable|failed
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_imports_user ON public.whatsapp_imports(user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_imports_property ON public.whatsapp_imports(property_id);

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES public.whatsapp_imports(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts TEXT, -- kept as raw parsed text -- WhatsApp export date/locale formats vary too much to normalize reliably in v1
  sender TEXT,
  body TEXT,
  is_system BOOLEAN DEFAULT false -- encryption notices, media-omitted placeholders, etc.
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_import ON public.whatsapp_messages(import_id);

CREATE TABLE IF NOT EXISTS public.whatsapp_extracted_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES public.whatsapp_imports(id) ON DELETE CASCADE,
  category TEXT NOT NULL, -- person|property_reference|payment|deposit|date_milestone|maintenance|vendor|commitment
  fact_type TEXT,
  value TEXT,
  confidence NUMERIC,
  evidence TEXT,
  message_seq INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|edited|rejected
  owner_edited_value TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_facts_import ON public.whatsapp_extracted_facts(import_id);

ALTER TABLE public.whatsapp_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_extracted_facts ENABLE ROW LEVEL SECURITY;
-- No policies added, matching 002_enable_rls.sql's established posture: default-deny
-- for anon/authenticated, service_role (server.js) is unaffected.
