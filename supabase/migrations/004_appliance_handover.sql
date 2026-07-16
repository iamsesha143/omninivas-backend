-- Phase 4: appliance/fixture handover checklist (move-in + move-out)
-- Feeds deposit-settlement conversations by recording item condition + a photo
-- at move-in, then again at move-out for the same tenant.

CREATE TABLE IF NOT EXISTS handovers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('move_in', 'move_out')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  conducted_date DATE DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_handovers_property ON handovers(property_id);
CREATE INDEX IF NOT EXISTS idx_handovers_tenant ON handovers(tenant_id);

CREATE TABLE IF NOT EXISTS handover_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handover_id UUID NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
  appliance_id UUID REFERENCES appliances(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'fair', 'damaged', 'missing')),
  photo_url TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_handover_items_handover ON handover_items(handover_id);

ALTER TABLE handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE handover_items ENABLE ROW LEVEL SECURITY;
