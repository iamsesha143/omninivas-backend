// Regression coverage for the real agreement-import failure on the Flat 512
// / Meda Heights document (Shankar Abhinav, 2025-07-01, 11 months, Rs. 38,000
// rent, Rs. 1,52,000 deposit). The fixture below is a SANITIZED reconstruction
// of the actual Tesseract OCR output captured from the real supplied PDF
// (rental-agreement-meda-512-1st-July-26.pdf) via the app's own extraction
// pipeline (server.js's tryPDFTextExtraction -> extractTextFromImageBasedPDFWithImageMagick,
// run standalone against the real file, never modified) -- Aadhaar number,
// tenant's private permanent address, and the account owner's real name/
// address/e-stamp certificate details have all been replaced with generic
// placeholders. Every OCR artifact that broke the original parsers is
// preserved deliberately, because it IS what's under test:
//   - "Second Party ..." e-stamp line removed entirely (not needed -- pattern
//     0, not pattern 2, is what fixed this document).
//   - No leading "(" before "Hereinafter called as the LESSEE" (only the
//     trailing "(which expression...)" boilerplate is parenthesized).
//   - 4 lines (S/o, 3-line address, Aadhaar) between "Mr. SHANKAR ABHINAY"
//     and the "Hereinafter..." clause -- far past the old 80-char window.
//   - "SHANKAR ABHINAY" (not "ABHINAV") -- a real, documented Tesseract V->Y
//     misread on the actual scanned document. Preserved as-is: this fixture
//     proves what the pipeline actually extracts, not a hand-corrected ideal.
//   - "within 5% day of English Calendar month" -- OCR misread of "5th".
//   - Rent/deposit clauses use verbose "shall be Rs. X/-" phrasing with the
//     currency figure ~95-100 chars from the keyword, past the old
//     60/80-char windows.
//   - "The Lessee has to pay actual amount as per association towards
//     maintenance charges" -- party-before-verb construction, not the
//     "borne/paid by" form the original findPayer only recognized.
//   - "shall be paid directly to the concerned department regularly by the
//     Lessee" -- an interposed clause between the verb and "by".
//   - "Tube Lights & Lights : 8 Nos" -- a combined line item where a second
//     fixture name ("& Lights") sits between "Tube Lights" and its quantity.
//
// Run with: node --test test/parsersFlat512.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePropertyFromText, parseTenantsFromText, parseAgreementFactsFromText } = require('../parsers');

const FLAT_512_SANITIZED = `RENTAL AGREEMENT

This Rental Agreement is made and executed on this 25% day of June 2025, Effective from :
01.07.2025, by between:

Mr. VENKATA RAGHAVAN
Residing at : Flat No. 8A, Blue Bell Tower,
Klassik Land Mark, Choodasandra,
Bangalore - 560 035.

plorenatter called as the LESSOR (which expression shall mean and include wherever the
content SO requires admits his heirs, executors, representatives amd assigns of the ONE
PART

AND

Mr. SHANKAR ABHINAY
Slo [REDACTED]
Permanent Address : [REDACTED ADDRESS LINE 1],
[REDACTED ADDRESS LINE 2]
[REDACTED ADDRESS LINE 3].
Aadhaar No: [REDACTED]
Hereinafter called as the LESSEE (which expression shall mean and include wherever the
context so requires admits his heirs, executors, representatives and assigns) of the OTHER
PART:

WITNESSES AS FOLLOWS:

Whereas the Lessor is the absolute owner of the Residential premises situated ats Flat No.
#512, Block -B, Meda Heights, Doddakannelli Road, Near AET Circle, Bangalore =
560035.

Which are more fully described in the Schedule written hereunder and hereinafter referred
to as the "Schedule Property".

Whereas the Lessor has agreed to grant a rent of the said premises tothe said premise so the
Lessces under the following terms and conditions. !

1. Tenant should not be using the premises for any GST Purposes without taking any
written approval from the owner and tenant will be responsible for any government
compliance on all GST or any tax related matters.

2. DURATION; The duration of the rent shall be for a period of 11 (Eleven) months
only effective from 01.07.2025. After the expiry period of 11 months, if the Lessces
want to continue, there will be 7% (Seven Percent) increase in the monthly rent after
11 months.

3. RENT; The monthly rent payable by the Lessees to the Lessor for the Schedule
Property shall be Rs. 38,000/- (Rupees Thirty Eight Thousand Only) to be paid per
month. The amount shall be paid every month within 5% day of English Calendar
month. The Lessee has to pay actual amount as per association towards
maintenance charges.

4. DEPOSIT; Whereas the LESSOR has leased the schedule premises to the LESSEE
for a consideration amount of Rs. 1,52,000/-(Rupees One Lakh Fifty Two Thousand
only) by way of Online Transfer to the Lessor as Security Deposit. The same amount
of shall be refundable by the Lessor to the Lessee without any interest at the time of
vacating the schedule premises.

5. ELECTRICITY CHARGES: The Lessor has provided scparate meter for the
Electricity Charges which shall be paid directly to the concerned department
regularly by the Lessee.

6. INTERNAL MAINTENANCE; The Lessee shall maintain the schedule property in
a state of good order and condition and shall not cause any damage or
discolourment to the Schedule Property therein always expecting fair wear and tear.

The Semi Furnished Residential premises situated at Flat No. #512, Block -B, Meda
Heights, Doddakannelli Road, Near AET Circle, Bangalore - 560035. Consisting of One
Hall, One kitchen, One Bedroom, attached bathroom and toilet having Electricity and Water
facility.

Fittings & | tures : Modular Kitchen with Chimney - 1 No, Fans : 3 Nos, Geyser : 1 No,
Tube Lights & Lights : 8 Nos, Cloth Hanger: 1 No, Stove: 1 No.

IN WITNESS WHEREOF the parties have executed this agreement in the presence of the
following, on the day, month and year as first above mentioned.

1. OWNER /LESSOR

2. LESSEE/ TENANT
`;

test('Flat 512: extracts the tenant name across the multi-line gap, with no leading "(" before "Hereinafter"', () => {
  const tenants = parseTenantsFromText(FLAT_512_SANITIZED);
  assert.equal(tenants.length, 1);
  // "Abhinay" (not "Abhinav") reflects the real OCR output verbatim -- the
  // review UI shows this with evidence for the owner to correct, it is never
  // silently "fixed" to match the name spelled correctly on paper.
  assert.equal(tenants[0].name, 'Shankar Abhinay');
});

test('Flat 512: never extracts the Lessor as a tenant', () => {
  const tenants = parseTenantsFromText(FLAT_512_SANITIZED);
  assert.ok(!tenants.some(t => t.name.includes('Raghavan')), 'the owner\'s name must never appear as an extracted tenant');
});

test('Flat 512: rent amount 38,000 and due day 5 extract despite the verbose clause and OCR-mangled ordinal ("5%" for "5th")', () => {
  const facts = parseAgreementFactsFromText(FLAT_512_SANITIZED);
  assert.equal(facts.rent_amount, 38000);
  assert.equal(facts.rent_due_day, 5);
});

test('Flat 512: the 7% continuation-rent-increase clause extracts as reference data, and never alters rent_amount itself', () => {
  const facts = parseAgreementFactsFromText(FLAT_512_SANITIZED);
  assert.equal(facts.rent_escalation_percent, 7);
  assert.equal(facts.rent_amount, 38000, 'the written rent figure itself is never multiplied by the escalation clause -- no ₹40,660 anywhere in the parser output');
  assert.ok(typeof facts.evidence.rent_escalation_percent === 'string' && facts.evidence.rent_escalation_percent.length > 0);
});

test('Flat 512: deposit 1,52,000 extracts as refundable, from the "consideration amount...Security Deposit...refundable" clause', () => {
  const facts = parseAgreementFactsFromText(FLAT_512_SANITIZED);
  assert.equal(facts.deposit_total, 152000);
  assert.equal(facts.deposit_refundable, true);
});

test('Flat 512: maintenance payer resolves via the reverse "Lessee has to pay...maintenance" construction', () => {
  const facts = parseAgreementFactsFromText(FLAT_512_SANITIZED);
  assert.equal(facts.maintenance_payer, 'tenant');
});

test('Flat 512: electricity payer resolves across the interposed "...to the concerned department regularly..." clause', () => {
  const facts = parseAgreementFactsFromText(FLAT_512_SANITIZED);
  assert.equal(facts.electricity_payer, 'tenant');
});

test('Flat 512: all six fixture categories extract with the correct quantities, including the combined "Tube Lights & Lights : 8 Nos" line', () => {
  const facts = parseAgreementFactsFromText(FLAT_512_SANITIZED);
  const byName = Object.fromEntries(facts.fixtures.map(f => [f.name, f.quantity]));
  assert.equal(byName['Modular Kitchen'], 1);
  assert.equal(byName['Chimney'], 1);
  assert.equal(byName['Geyser'], 1);
  assert.equal(byName['Fan'], 3);
  assert.equal(byName['Tube Light'], 8);
  assert.equal(byName['Cloth Hanger'], 1);
  assert.equal(byName['Stove'], 1);
});

test('Flat 512: property facts (flat number, society, pincode, agreement start date, duration) extract correctly', () => {
  const prop = parsePropertyFromText(FLAT_512_SANITIZED);
  assert.equal(prop.flat_number, '512');
  assert.equal(prop.society_name, 'Meda Heights');
  assert.equal(prop.pincode, '560035');
  assert.equal(prop.agreement_start_date, '2025-07-01');
  assert.equal(prop.agreement_months, 11);
});

test('Flat 512: the agreement term (2025-07-01 + 11 months) computes to an end date that has already passed relative to any date from 2026-06-01 onward -- the historical-status decision this document requires', () => {
  const prop = parsePropertyFromText(FLAT_512_SANITIZED);
  const leaseEnd = new Date(prop.agreement_start_date + 'T00:00:00');
  leaseEnd.setMonth(leaseEnd.getMonth() + prop.agreement_months);
  assert.equal(leaseEnd.toISOString().split('T')[0], '2026-06-01');
  assert.ok(leaseEnd.getTime() < Date.now(), 'this fixture\'s term has already ended as of when this suite runs');
});
