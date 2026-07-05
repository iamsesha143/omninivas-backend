# OMniNivas — Product Roadmap & Strategy

*Last updated: July 2026. This file is the single source of truth for product direction.
Any AI session or developer should read this before proposing features.*

## Vision

The operating system for the self-managing Indian landlord (1–10 flats): rent + bills
truth, tenant relationship, documents, assets, and loan economics in one place.
Two-sided (owner + tenant logins). India first, USA second.

## Who it's for

- **Owner** (primary payer): tracks rent, bills, maintenance, documents, loans, appliances.
- **Tenant** (invited): sees dues, uploads payment proof, raises issues, downloads receipts.
- First wave: 3 users (founder + 2 brothers), Bengaluru flats.

## Current state (done, verified in production)

- Owner auth with real password verification (bcrypt)
- Properties: manual create + OCR auto-extraction from rental agreement PDFs
  (property name, address, city/state/pincode, tenants, Aadhaar, move-in date)
- Tenants, payments (paid/pending), maintenance costs, document storage, dashboard
- Web app (React on Railway) + API (Node/Express on Railway) + Supabase (Postgres+storage)

## Build phases (in order — each shippable alone)

### Phase 1 — Money truth (rent + recurring bills)  ✅ DONE (July 2026, verified in prod)
- `obligations` model per property: rent / electricity / water / society-maintenance /
  other, each with amount (or "variable"), due-day, who-pays (owner | tenant | split %).
  Handles the real case: owner pays society maintenance on some flats, tenant on others.
- Monthly expected-payments generation; overdue = red on dashboard.
- Payment proof upload (screenshot/photo — what tenants already send on WhatsApp);
  OCR the screenshot for amount / date / UTR; owner one-tap confirm.
- Auto-generated rent receipts (PDF) — tenants need these for HRA tax claims.

### Phase 2 — Tenant login
- `role` on users (owner | tenant); tenant invited by owner via link/code tied to tenancy.
- Tenant portal: my agreement, my dues, payment history, receipts, raise-an-issue.
- Data isolation: tenant sees only their tenancy. (Requires tightening RLS/storage policies.)

### Phase 3 — WhatsApp
- Start with in-app flows (upload + reminders) to prove usage.
- Then official WhatsApp Business API via a BSP (Gupshup / Twilio / Interakt): needs Meta
  business verification, a dedicated number, per-conversation pricing. Scope to exactly two
  jobs: (a) payment reminder messages, (b) "forward payment screenshot here" ingestion.
- `users.whatsapp_webhook_token` column already exists in the DB.

### Phase 4 — Asset & fixtures registry (differentiator)
- Per property: appliances (geyser, AC, fridge…) with make, model, serial, purchase date,
  bill photo, warranty end, AMC, service-center phone. OCR bill to auto-fill.
- Warranty-expiry + service-due reminders.
- Move-in fixtures checklist with photos (the agreement's "2 tube lights, 1 TV unit…"
  list) → powers move-out deposit settlement. Deposit disputes are the #1 landlord-tenant
  conflict; photo evidence is the killer feature.
- Issue tickets: tenant raises "geyser not working" → ticket auto-attaches appliance
  details + service number.

### Phase 5 — Mortgage & finances
- Loan per property: principal, rate, EMI, tenure → amortization schedule + prepayment
  what-if ("₹10k/month extra → done N years earlier").
- Net cash flow per property (rent − EMI − maintenance − repairs).
- Yearly income/expense statement per property (useful for ITR rental-income declaration).
- Never phrase as financial advice — it's arithmetic on the user's own numbers.

### Phase 6 — Paperwork brain
- Document vault categories + expiry dates (sale deed, khata, tax receipt, agreement).
- Reminders: agreement expiry (11-month cycles), rent escalation due, property tax due,
  tenant police verification (mandatory in Karnataka), TDS applicability at ₹50k+/month rent.

### Mobile (iOS + Android)
- One Expo/React Native app, camera-first (bills, meters, appliances, screenshots).
- Build after Phase 2 so it launches two-sided. Backend API is already mobile-ready.

## Competitors / inspiration

**India:** MyGate (society/security-first, not landlord-first), NoBroker (discovery +
rent-pay), NestAway-style managed rental (struggled), RentOk (owner rent collection —
closest Indian analog), Cred/PhonePe RentPay (payments only). Gap: nobody owns the
self-managing landlord's full lifecycle.

**USA (study these for Phase 5+ and US entry):** Stessa (landlord finances/accounting —
closest to our money-truth vision), TurboTenant, Avail (Realtor.com), RentRedi, Landlord
Studio, Baselane (landlord banking), Innago, TenantCloud, Hemlane; Buildium/AppFolio/
DoorLoop serve professional managers (not our segment). US entry notes: screening/credit
reports and state-by-state lease law are the moats there; our India OCR-agreement trick
translates to US leases well.

## Non-negotiables before strangers use it

1. ~~Real password verification~~ (done July 2026)
2. Tighten Supabase RLS + storage policies (currently permissive anon policies)
3. Privacy policy + DPDP Act (India) basics — we store Aadhaar numbers and scans:
   collect minimum, encrypt at rest, deletion on request
4. Paid infra (~₹1,500–2,500/mo): Railway hobby, Supabase pro when free tier limits hit
5. Rate limiting + backups before public launch

## Working agreements

- Deploy = push to GitHub main (Railway auto-deploys). Verify via /health version bump.
- Test every change against production with a throwaway account before telling users.
- Keep decisions in this file; keep DB changes in supabase-fix.sql style migration files.
