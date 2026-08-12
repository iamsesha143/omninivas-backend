// Unit tests for parsers.js's regex-only (non-AI) extraction, focused on the
// Agreement Intake Completion slice: parseAgreementFactsFromText (new) plus
// the parseTenantsFromText fix for the "<Name> (hereinafter called the
// "LESSEE/TENANT" ...)" clause structure. No file/OCR involved -- these
// functions take raw text directly, so a realistic constructed agreement
// text is enough to validate the regexes without needing OCR fidelity.
//
// Run with: node --test test/parsers.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePropertyFromText, parseTenantsFromText, parseAgreementFactsFromText } = require('../parsers');

// A realistic three-clause-style Indian rental agreement embodying every fact
// in the acceptance scenario (tenant, property, dates, rent, deposit,
// responsibilities, fixtures). No AI gateway involved in any of this --
// deterministic regex only.
const MEDA_HEIGHTS_AGREEMENT = `RENTAL AGREEMENT

This Rental Agreement is made and executed at Bengaluru on this 28th day of May 2026 between:

Mr. Rajendra Kumar (hereinafter called the "LESSOR/OWNER" which expression shall unless repugnant to the context mean and include his heirs, legal representatives, executors and assigns) of the ONE PART

AND

Meesa Shivaram Prasad (hereinafter called the "LESSEE/TENANT" which expression shall unless repugnant to the context mean and include his heirs, legal representatives, executors and assigns) of the OTHER PART.

WHEREAS the Lessor is the absolute owner of the residential premises situated at: Flat #613, Block-B, Meda Heights, Sarjapur Main Road, Bengaluru - 560035 (hereinafter referred to as the "SCHEDULED PROPERTY") and has agreed to let out the same to the Lessee on the following terms and conditions.

1. TERM: This agreement is effective from 01/06/2026 and the lease period of this agreement shall be for 11 (eleven) months, commencing from 01/06/2026 and ending on 30/04/2027, renewable thereafter by mutual consent.

2. RENT: The monthly rent for the scheduled property shall be Rs. 41,000/- (Rupees Forty One Thousand Only) payable in advance on or before the 5th day of every English calendar month, by NEFT/online transfer to the Lessor's bank account.

3. SECURITY DEPOSIT: The Lessee has paid to the Lessor a sum of Rs. 1,50,000/- (Rupees One Lakh Fifty Thousand Only) as interest-free refundable security deposit, receipt of which is hereby acknowledged by the Lessor, the same having been paid by online transfer. The said deposit shall be refunded to the Lessee at the time of vacating the scheduled property, after deducting any dues.

4. MAINTENANCE: The society maintenance charges shall be borne and paid by the Tenant directly to the association every month.

5. ELECTRICITY: The electricity charges as per the BESCOM meter installed in the scheduled property shall be paid by the Tenant directly, based on actual consumption.

6. FIXTURES AND FITTINGS: The Lessor has provided the following fixtures and fittings along with the scheduled property, which the Lessee acknowledges having received in good working condition:
   a. Modular kitchen with chimney - 1 No.
   b. Fans - 3 Nos.
   c. Geyser - 1 No.
   d. Tube lights - 8 Nos.

7. The Lessee shall not sub-let, assign or part with possession of the scheduled property without the prior written consent of the Lessor.

IN WITNESS WHEREOF the parties hereto have set their hands on the day, month and year first above written.

LESSOR                                          LESSEE
Rajendra Kumar                                  Meesa Shivaram Prasad
`;

// ---- parseTenantsFromText: the "(hereinafter called the LESSEE/TENANT)" clause ----

test('parseTenantsFromText: extracts the tenant name from a "(hereinafter called the LESSEE/TENANT)" clause', () => {
  const tenants = parseTenantsFromText(MEDA_HEIGHTS_AGREEMENT);
  assert.equal(tenants.length, 1);
  assert.equal(tenants[0].name, 'Meesa Shivaram Prasad');
  assert.equal(tenants[0].date_of_move_in, '2026-06-01');
});

test('parseTenantsFromText: never extracts the Lessor/Owner as a tenant', () => {
  const tenants = parseTenantsFromText(MEDA_HEIGHTS_AGREEMENT);
  assert.ok(!tenants.some(t => t.name.includes('Rajendra')), 'the owner\'s name must never appear as an extracted tenant');
});

test('parseTenantsFromText: "referred to as" phrasing (not just "called") is also recognized', () => {
  const text = `Priya Nair (hereinafter referred to as the "TENANT") agrees to the following.`;
  const tenants = parseTenantsFromText(text);
  assert.equal(tenants.length, 1);
  assert.equal(tenants[0].name, 'Priya Nair');
});

test('parseTenantsFromText: no matching clause structure at all returns an empty array, not a guess', () => {
  const tenants = parseTenantsFromText('This document has no identifiable party clause whatsoever.');
  assert.deepEqual(tenants, []);
});

// ---- parseAgreementFactsFromText ----

test('parseAgreementFactsFromText: extracts every fact in the acceptance scenario correctly', () => {
  const facts = parseAgreementFactsFromText(MEDA_HEIGHTS_AGREEMENT);
  assert.equal(facts.rent_amount, 41000);
  assert.equal(facts.rent_due_day, 5);
  assert.equal(facts.deposit_total, 150000);
  assert.equal(facts.deposit_refundable, true);
  assert.equal(facts.maintenance_payer, 'tenant');
  assert.equal(facts.electricity_payer, 'tenant');
});

test('parseAgreementFactsFromText: fixture quantities match the agreement exactly, including implicit singular items', () => {
  const facts = parseAgreementFactsFromText(MEDA_HEIGHTS_AGREEMENT);
  const byName = Object.fromEntries(facts.fixtures.map(f => [f.name, f.quantity]));
  assert.equal(byName['Modular Kitchen'], 1);
  assert.equal(byName['Chimney'], 1);
  assert.equal(byName['Geyser'], 1);
  assert.equal(byName['Fan'], 3);
  assert.equal(byName['Tube Light'], 8);
  // "lights" is subsumed into "Tube Light" here -- must not also appear as a
  // separate generic "Light" item (that would double-count the same clause).
  assert.equal(byName['Light'], undefined);
});

test('parseAgreementFactsFromText: every found fact carries a verifiable source-text snippet', () => {
  const facts = parseAgreementFactsFromText(MEDA_HEIGHTS_AGREEMENT);
  for (const key of ['rent_amount', 'rent_due_day', 'deposit_total', 'maintenance_payer', 'electricity_payer']) {
    assert.ok(typeof facts.evidence[key] === 'string' && facts.evidence[key].length > 0, `evidence missing for ${key}`);
  }
});

test('parseAgreementFactsFromText: a non-refundable deposit clause is read as refundable=false, not left ambiguous', () => {
  const text = `SECURITY DEPOSIT: The Tenant has paid Rs. 20,000/- as a non-refundable security deposit towards administrative charges.`;
  const facts = parseAgreementFactsFromText(text);
  assert.equal(facts.deposit_total, 20000);
  assert.equal(facts.deposit_refundable, false);
});

test('parseAgreementFactsFromText: deposit clause silent on refundability yields null, never a guessed true/false', () => {
  const text = `SECURITY DEPOSIT: The Tenant has paid Rs. 20,000/- as security deposit.`;
  const facts = parseAgreementFactsFromText(text);
  assert.equal(facts.deposit_total, 20000);
  assert.equal(facts.deposit_refundable, null);
});

test('parseAgreementFactsFromText: owner-paid maintenance and electricity are read as owner, not tenant', () => {
  const text = `MAINTENANCE: The maintenance charges shall be borne and paid by the Owner. ELECTRICITY: Electricity charges shall be paid by the Landlord.`;
  const facts = parseAgreementFactsFromText(text);
  assert.equal(facts.maintenance_payer, 'owner');
  assert.equal(facts.electricity_payer, 'owner');
});

test('parseAgreementFactsFromText: missing/ambiguous fields are all null and an empty fixtures array, never fabricated', () => {
  const facts = parseAgreementFactsFromText('This is a short document with no identifiable financial or fixture clauses.');
  assert.equal(facts.rent_amount, null);
  assert.equal(facts.rent_due_day, null);
  assert.equal(facts.deposit_total, null);
  assert.equal(facts.deposit_refundable, null);
  assert.equal(facts.maintenance_payer, null);
  assert.equal(facts.electricity_payer, null);
  assert.equal(facts.rent_escalation_percent, null);
  assert.deepEqual(facts.fixtures, []);
});

test('parseAgreementFactsFromText: empty/undefined input never throws', () => {
  assert.doesNotThrow(() => parseAgreementFactsFromText(''));
  assert.doesNotThrow(() => parseAgreementFactsFromText(undefined));
});

// ---- Regression: parsePropertyFromText still extracts the property facts correctly ----

test('parsePropertyFromText: still extracts property_name, address, and agreement dates from the same document', () => {
  const prop = parsePropertyFromText(MEDA_HEIGHTS_AGREEMENT);
  assert.equal(prop.flat_number, '613');
  assert.equal(prop.society_name, 'Meda Heights');
  assert.equal(prop.pincode, '560035');
  assert.equal(prop.agreement_start_date, '2026-06-01');
  assert.equal(prop.agreement_months, 11);
});
