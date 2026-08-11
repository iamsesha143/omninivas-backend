// Parsers that turn raw rental-agreement text (from OCR or PDF text layer)
// into structured property and tenant data.

const CITY_TO_STATE = {
  bengaluru: 'Karnataka', bangalore: 'Karnataka', mysore: 'Karnataka',
  mumbai: 'Maharashtra', pune: 'Maharashtra', nagpur: 'Maharashtra', thane: 'Maharashtra',
  delhi: 'Delhi', 'new delhi': 'Delhi', noida: 'Uttar Pradesh', ghaziabad: 'Uttar Pradesh',
  lucknow: 'Uttar Pradesh', gurgaon: 'Haryana', gurugram: 'Haryana', faridabad: 'Haryana',
  hyderabad: 'Telangana', chennai: 'Tamil Nadu', coimbatore: 'Tamil Nadu',
  kolkata: 'West Bengal', ahmedabad: 'Gujarat', surat: 'Gujarat',
  jaipur: 'Rajasthan', udaipur: 'Rajasthan', jodhpur: 'Rajasthan',
  kochi: 'Kerala', thiruvananthapuram: 'Kerala', chandigarh: 'Punjab',
  bhopal: 'Madhya Pradesh', indore: 'Madhya Pradesh', patna: 'Bihar', bhubaneswar: 'Odisha',
  visakhapatnam: 'Andhra Pradesh', vijayawada: 'Andhra Pradesh'
};

const STATES = [
  'Karnataka', 'Maharashtra', 'Delhi', 'Tamil Nadu', 'Tamilnadu', 'Telangana', 'Punjab',
  'Haryana', 'Uttar Pradesh', 'Rajasthan', 'Gujarat', 'West Bengal', 'Kerala',
  'Madhya Pradesh', 'Bihar', 'Odisha', 'Andhra Pradesh'
];

const titleCase = (s) => s.trim().replace(/\s+/g, ' ')
  .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

const cleanSpaces = (s) => s.replace(/\s+/g, ' ').replace(/[\s,.\-–]+$/g, '').trim();

// Some PDF/OCR sources (some PDF generators, and Tesseract on scanned pages with
// unusual layout) emit a line break after every word instead of real paragraph
// breaks. That silently breaks any regex anchored on \n as a line boundary (e.g.
// "name on its own line, then an Aadhaar line below it"). Collapse single line
// breaks within a paragraph back into spaces while preserving real paragraph
// breaks (blank lines), so downstream regexes see normal prose either way.
const normalizeText = (text) => (text || '')
  .split(/\n{2,}/)
  .map(para => para.replace(/\n/g, ' ').replace(/[ \t]+/g, ' ').trim())
  .join('\n\n');

function findCity(text) {
  let best = null;
  for (const city of Object.keys(CITY_TO_STATE)) {
    const idx = text.toLowerCase().indexOf(city);
    if (idx !== -1 && (best === null || idx < best.idx)) best = { idx, city };
  }
  return best ? titleCase(best.city) : null;
}

function findState(text, city) {
  for (const state of STATES) {
    if (new RegExp(state.replace(' ', '\\s+'), 'i').test(text)) {
      return state === 'Tamilnadu' ? 'Tamil Nadu' : state;
    }
  }
  if (city && CITY_TO_STATE[city.toLowerCase()]) return CITY_TO_STATE[city.toLowerCase()];
  return null;
}

const parsePropertyFromText = (text) => {
  text = normalizeText(text);

  // The schedule-property clause ("...premises situated at: <address> - <pincode>")
  // is the most reliable anchor in Indian rental agreements.
  let address = '';
  let pincode = null;
  const situated = text.match(/situated\s+at\s*[:\-]?\s*([\s\S]{10,250}?)[\s\-–]*(\b\d{6}\b)/i);
  if (situated) {
    address = cleanSpaces(situated[1]);
    pincode = situated[2];
  } else {
    const addressMatch = text.match(/(?:address|premises|residing\s+at)\s*[:\-]?\s*([\s\S]{10,200}?)(?:\n\n|\b(\d{6})\b)/i);
    if (addressMatch) {
      address = cleanSpaces(addressMatch[1]).substring(0, 150);
      if (addressMatch[2]) pincode = addressMatch[2];
    }
  }
  if (!pincode) {
    // Indian pincodes start 1-8; \b avoids matching inside Aadhaar/certificate numbers
    const pinMatch = text.match(/\b([1-8]\d{5})\b/);
    if (pinMatch) pincode = pinMatch[1];
  }

  const city = findCity(address) || findCity(text) || 'Bengaluru';
  const state = findState(text, city) || 'Karnataka';

  // Flat number and society name, e.g. "flat# 4162, Wing 4, Sobha Sentosa, Panathur Main Road"
  const flatMatch = (address || text).match(/flat\s*(?:no\.?|number|#)?\s*[:\-]?\s*#?\s*(\d{1,5}[A-Za-z]?)\b/i);
  const flatNumber = flatMatch ? flatMatch[1] : null;

  let society = null;
  if (address) {
    for (const seg of address.split(',').map(s => s.trim())) {
      const words = seg.split(/\s+/);
      const looksLikeStreet = /\b(road|main|cross|street|marg|circle|nagar|layout|phase|block|wing|flat|floor|no\.?|#)\b/i.test(seg);
      const isCityOrState = seg.toLowerCase().includes(city.toLowerCase()) || /\d{6}/.test(seg);
      if (!looksLikeStreet && !isCityOrState && !/\d/.test(seg) && words.length >= 2 && words.length <= 4) {
        society = titleCase(seg);
        break;
      }
    }
  }

  let propertyName;
  if (society && flatNumber) propertyName = `${society} - Flat ${flatNumber}`;
  else if (society) propertyName = society;
  else if (flatNumber) propertyName = `Flat ${flatNumber}, ${city}`;
  else propertyName = `${city} Property`;

  const propertyType = /commercial|office|shop|godown|warehouse/i.test(text) ? 'commercial' : 'residential';

  if (address && pincode && !address.includes(pincode)) address = `${address} - ${pincode}`;

  // Agreement start date: "effective from 01/03/2026", "commencing from...",
  // "w.e.f. ...", "lease period from ...". Same date-anchor phrasing tenants
  // agreements commonly use for move-in, so this mirrors parseTenantsFromText's
  // own "effective from" regex.
  let agreementStartDate = null;
  const startMatch = text.match(/(?:effective|commenc\w*|w\.?e\.?f\.?|lease\s+period)\s*(?:on|from)?\s*[:\s]*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/i);
  if (startMatch) {
    const [, dd, mm, yyyy] = startMatch;
    agreementStartDate = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  // Duration: prefer a phrase anchored to the actual lease-term clause (e.g.
  // "period of 11 months", "lease period of 11 (eleven) months", "term of 11
  // months") over a bare "N months" match -- an unanchored match can pick up
  // an unrelated "1 month" notice-period clause instead if that phrase happens
  // to appear earlier in the document than the real lease duration.
  let agreementMonths = null;
  // [\s\S]{0,40}? tolerates real-world phrasing like "period of this agreement
  // shall be 11 months" where the number isn't immediately adjacent to "period
  // of" -- bounded and lazy so it can't reach across into an unrelated clause.
  const anchoredDuration = text.match(/(?:(?:lease|tenancy|rental)?\s*period\s+of|for\s+a\s+period\s+of|term\s+of)[\s\S]{0,40}?(\d{1,2})\s*(?:\([a-z]+\)\s*)?months?/i);
  if (anchoredDuration) {
    const n = parseInt(anchoredDuration[1], 10);
    if (n >= 1 && n <= 60) agreementMonths = n;
  }
  if (agreementMonths === null) {
    const durationMatch = text.match(/(\d{1,2})\s*(?:\([a-z]+\)\s*)?months?/i);
    if (durationMatch) {
      const n = parseInt(durationMatch[1], 10);
      if (n >= 1 && n <= 60) agreementMonths = n;
    }
  }

  return {
    property_name: propertyName.substring(0, 80),
    street_address: address || `${city}`,
    city,
    state,
    pincode: pincode || '560000',
    property_type: propertyType,
    flat_number: flatNumber,
    society_name: society,
    agreement_start_date: agreementStartDate,
    agreement_months: agreementMonths
  };
};

const parseTenantsFromText = (text) => {
  // NOT normalized like parsePropertyFromText -- pattern 1 below intentionally
  // relies on a real single line break between an all-caps name and the
  // Aadhaar line beneath it; collapsing that would break well-formatted real
  // documents to "fix" what turned out to be a synthetic-test-PDF artifact
  // (some PDF generators emit one word per line). Needs a real sample
  // document to verify/improve tenant-extraction accuracy further.
  if (!text) text = '';
  const emails = [...new Set(text.match(/[\w.\-]+@[\w.\-]+\.\w+/gi) || [])];
  // \b keeps us from matching 10-digit substrings of Aadhaar/certificate numbers
  const phones = [...new Set([...text.matchAll(/(?:\+91[\s\-]?)?\b([6-9]\d{9})\b/g)].map(m => m[1]))];

  // Move-in date: "Effective from: 01/03/2026" (dd/mm/yyyy)
  let moveIn = null;
  const eff = text.match(/effective\s*(?:to\s*)?\s*from\s*[:\s]*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/i);
  if (eff) {
    const [, dd, mm, yyyy] = eff;
    moveIn = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  const names = [];
  const aadhars = [];
  const seen = new Set();
  const addName = (raw, aadhar) => {
    const name = titleCase(raw.replace(/[^A-Za-z\s.]/g, ' '));
    if (name.length < 3 || name.length > 50) return;
    if (/lessor|lessee|party|agreement|schedule|witness|property/i.test(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
    aadhars.push(aadhar || null);
  };

  // 0) The standard Indian rental-agreement party clause: "<Name> (hereinafter
  // called the "LESSEE/TENANT" ...)". Found to be the single most common real
  // document structure (missed entirely before this pattern existed -- 0
  // tenants extracted on a realistic sample agreement using this exact
  // phrasing). The "hereinafter ... lessee/tenant" keyword match stays
  // case-insensitive (documents often render it "LESSEE/TENANT" in caps), but
  // the immediately-preceding name is validated separately with a
  // case-SENSITIVE title-case check (a mixed-case regex under the same /i
  // flag would also match ALL-CAPS boilerplate like "ONE PART" or "AND",
  // since /i makes [a-z] match uppercase too) -- this two-step split is what
  // keeps the Lessor's own name (tagged "LESSOR/OWNER" in the mirror clause
  // just above) from ever being captured here.
  for (const hm of text.matchAll(/\(hereinafter\s+(?:called|referred\s+to\s+as)[^)]{0,80}(lessee|tenant)[^)]*\)/gi)) {
    const before = text.slice(Math.max(0, hm.index - 80), hm.index);
    const nameMatch = before.match(/((?:[A-Z][a-z]+\.?\s+){0,4}[A-Z][a-z]+\.?)\s*$/);
    if (nameMatch) addName(nameMatch[1]);
  }
  // 1) Names directly above an "Aadhar id" line (most reliable; tolerate OCR typos like "Aadbhar").
  // [A-Z .] (no \n) keeps the match on a single line so it can't swallow preceding lines.
  for (const m of text.matchAll(/(?:^|\n)[^\w\n]*([A-Z][A-Z .]{3,45})[ \t]*\n[^\n]*?a[a-z]{1,3}h?[a-z]?r\s*id\s*[-—:\s]*(\d{12})/gi)) {
    addName(m[1].replace(/^(?:AND|MR|MRS|MS|SMT|SRI)[. ]+/i, ''), m[2]);
  }
  // 2) "Second Party : NAME AND NAME" on e-stamp certificates
  const sp = text.match(/second\s+party\s*[:\-]?\s*([A-Z][A-Za-z\s,&.]+?)(?:\n|$)/im);
  if (sp) {
    for (const part of sp[1].split(/\s+(?:AND|&)\s+|,/i)) addName(part);
  }
  // 3) Generic "tenant/lessee: Name" fallback
  for (const m of text.matchAll(/(?:tenant|lessee)\s*[:\-]\s*([A-Z][A-Za-z\s.]{2,45}?)(?:\n|,|aadhar|phone|email)/gi)) {
    addName(m[1]);
  }

  const count = Math.max(names.length, emails.length, phones.length);
  const tenants = [];
  for (let i = 0; i < count; i++) {
    if (!names[i] && !emails[i] && !phones[i]) continue;
    tenants.push({
      name: names[i] || `Tenant ${i + 1}`,
      personal_email: emails[i] || null,
      personal_phone: phones[i] || null,
      aadhar_card: aadhars[i] || null,
      date_of_move_in: moveIn
    });
  }
  // A tenant found via a structured pattern (real name) is valid even without contact info
  return tenants.filter(t => !t.name.startsWith('Tenant ') || t.personal_email || t.personal_phone);
};

// Deterministic (non-AI) extraction of the clause-level facts an owner needs
// to review after uploading a signed agreement: rent amount/due day, deposit
// amount + refundable status, who's responsible for maintenance/electricity,
// and fixtures/fittings with quantities. Mirrors parsePropertyFromText's own
// regex-only approach -- these facts must extract reliably even when the AI
// gateway is unavailable (llm.js's extractAgreementFacts is entirely
// gateway-dependent and has been confirmed dormant since 2026-08-03; this
// function has no such dependency). Each found fact also carries the exact
// source snippet it was read from, in `evidence`, for the review screen to
// show provenance -- never returned as final truth, only as something to
// verify/edit/reject.
const FIXTURE_DEFS = [
  { name: 'Modular Kitchen', re: /modular\s*kitchen/i },
  { name: 'Chimney', re: /chimney/i },
  { name: 'Geyser', re: /geysers?/i },
  { name: 'Fan', re: /\bfans?\b/i },
  { name: 'Tube Light', re: /tube\s*lights?/i },
  { name: 'Wardrobe', re: /wardrobes?/i },
  { name: 'Air Conditioner', re: /\bA\/?Cs?\b|air[\s-]?condition(?:er)?s?/i },
  { name: 'Refrigerator', re: /refrigerator|fridge/i },
  { name: 'Washing Machine', re: /washing\s*machine/i },
  { name: 'Bed', re: /\bbeds?\b/i }
];

// A quantity phrased either before ("3 Fans") or after ("Fans - 3 Nos.") the
// item name. No explicit count found near the mention -> singular (1), which
// is also correct for an item listed on its own (e.g. "Geyser - 1 No.").
function extractQuantityNear(text, matchIndex, matchLength) {
  const before = text.slice(Math.max(0, matchIndex - 15), matchIndex);
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + 20);
  const beforeNum = before.match(/(\d{1,2})\s*(?:x\s*)?$/);
  if (beforeNum) return parseInt(beforeNum[1], 10);
  const afterNum = after.match(/^\s*[-:]?\s*(\d{1,2})\s*(?:no\.?s?|nos\.?|units?|pieces?|pcs?)?\b/i);
  if (afterNum) return parseInt(afterNum[1], 10);
  return 1;
}

const parseAgreementFactsFromText = (rawText) => {
  const text = normalizeText(rawText || '');
  const out = {
    rent_amount: null, rent_due_day: null,
    deposit_total: null, deposit_refundable: null,
    maintenance_payer: null, electricity_payer: null,
    fixtures: [], evidence: {}
  };

  // Rent amount: prefer a currency figure near the word "rent"; fall back to
  // a currency figure near "per month"/"monthly rent" phrasing.
  let rentMatch = text.match(/rent[\s\S]{0,60}?(?:₹|rs\.?|inr)\s*([\d,]+)(?:\/-)?/i);
  if (!rentMatch) rentMatch = text.match(/(?:₹|rs\.?|inr)\s*([\d,]+)(?:\/-)?[\s\S]{0,40}?(?:per\s*month|monthly\s*rent|as\s*rent)/i);
  if (rentMatch) {
    const v = parseInt(rentMatch[1].replace(/,/g, ''), 10);
    if (v >= 500 && v <= 1000000) { out.rent_amount = v; out.evidence.rent_amount = cleanSpaces(rentMatch[0]); }
  }

  // Rent due day: "on or before the 5th day of every ... month" style clauses,
  // falling back to a bare "Nth day of every month" or "rent due day: N".
  const dueDayMatch = text.match(/(?:on or before|due on|payable on|by)\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+)?of\s+(?:every|each)\s+(?:[a-z]+\s+){0,2}month/i)
    || text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+)?of\s+(?:every|each)\s+(?:[a-z]+\s+){0,2}month/i)
    || text.match(/rent\s+due\s+(?:date|day)?\s*[:\-]?\s*(\d{1,2})(?:st|nd|rd|th)?/i);
  if (dueDayMatch) {
    const day = parseInt(dueDayMatch[1], 10);
    if (day >= 1 && day <= 31) { out.rent_due_day = day; out.evidence.rent_due_day = cleanSpaces(dueDayMatch[0]); }
  }

  // Deposit total + refundable status, the latter read from the sentence the
  // amount itself was found in (never inferred from elsewhere in the document).
  const depositMatch = text.match(/security\s+deposit[\s\S]{0,80}?(?:₹|rs\.?|inr)\s*([\d,]+)(?:\/-)?/i)
    || text.match(/deposit[\s\S]{0,80}?(?:₹|rs\.?|inr)\s*([\d,]+)(?:\/-)?/i);
  if (depositMatch) {
    const v = parseInt(depositMatch[1].replace(/,/g, ''), 10);
    if (v >= 500 && v <= 100000000) {
      out.deposit_total = v;
      out.evidence.deposit_total = cleanSpaces(depositMatch[0]);
      const clauseWindow = text.slice(depositMatch.index, Math.min(text.length, depositMatch.index + depositMatch[0].length + 150));
      out.deposit_refundable = /non[\s-]?refundable/i.test(clauseWindow) ? false : (/refundable/i.test(clauseWindow) ? true : null);
    }
  }

  // Maintenance/electricity responsibility: "<keyword> ... shall be borne/paid
  // by the tenant/lessee/owner/lessor". tenant and lessee both normalize to
  // 'tenant'; owner and lessor (and landlord) both normalize to 'owner'.
  const findPayer = (keywordRe) => {
    const re = new RegExp(`${keywordRe.source}[\\s\\S]{0,150}?(?:shall\\s+be\\s+(?:borne(?:\\s+and\\s+paid)?|paid)|to\\s+be\\s+(?:borne|paid)|payable|borne)\\s+by\\s+(?:the\\s+)?(tenant|lessee|owner|lessor|landlord)`, 'i');
    const mm = text.match(re);
    if (!mm) return null;
    const who = mm[1].toLowerCase();
    return { payer: (who === 'tenant' || who === 'lessee') ? 'tenant' : 'owner', evidence: cleanSpaces(mm[0]) };
  };
  const maint = findPayer(/maintenance/i);
  if (maint) { out.maintenance_payer = maint.payer; out.evidence.maintenance_payer = maint.evidence; }
  const elec = findPayer(/electricity/i);
  if (elec) { out.electricity_payer = elec.payer; out.evidence.electricity_payer = elec.evidence; }

  // Fixtures: each known item name found gets its nearby quantity. "Tube
  // Light" is checked before the generic "Light" fallback so "tube lights"
  // isn't double-counted as both a distinct tube-light item and a plain light.
  for (const def of FIXTURE_DEFS) {
    const fm = text.match(def.re);
    if (!fm) continue;
    out.fixtures.push({ name: def.name, quantity: extractQuantityNear(text, fm.index, fm[0].length) });
  }
  if (!out.fixtures.some(f => f.name === 'Tube Light')) {
    const fm = text.match(/\blights?\b/i);
    if (fm) out.fixtures.push({ name: 'Light', quantity: extractQuantityNear(text, fm.index, fm[0].length) });
  }

  return out;
};

// Pulls amount, date, and UTR/reference out of OCR'd payment screenshots (GPay/PhonePe/bank).
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

const parsePaymentProof = (text) => {
  if (!text) text = '';
  const out = { amount: null, date: null, utr: null };

  // Amount: prefer explicit currency markers; take the largest (screenshots often show balance + amount)
  const amounts = [];
  for (const m of text.matchAll(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/gi)) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (v > 0 && v < 10000000) amounts.push(v);
  }
  if (amounts.length) out.amount = Math.max(...amounts);

  // UTR / transaction reference
  const utr = text.match(/(?:utr|ref(?:erence)?\s*(?:no|id)?|transaction\s*id|txn\s*id)[^\w]{0,5}([A-Za-z0-9]{10,25})/i) || text.match(/\b(\d{12})\b/);
  if (utr) out.utr = utr[1];

  // Date: "5 Mar 2026" / "05/03/2026" styles
  const d1 = text.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[,\s]+(\d{4})/i);
  const d2 = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (d1) out.date = `${d1[3]}-${MONTHS[d1[2].toLowerCase().slice(0, 3)]}-${d1[1].padStart(2, '0')}`;
  else if (d2) out.date = `${d2[3]}-${d2[2].padStart(2, '0')}-${d2[1].padStart(2, '0')}`;

  return out;
};

// Pulls appliance details out of an OCR'd purchase bill / invoice.
const parseApplianceFromText = (text) => {
  if (!text) text = '';
  const out = { brand: null, model: null, serial_number: null, purchase_date: null, warranty_months: null, category: 'other' };

  const BRANDS = ['Bajaj', 'Havells', 'Racold', 'AO Smith', 'V-Guard', 'Crompton', 'Venus', 'Whirlpool', 'LG', 'Samsung', 'Voltas', 'Blue Star', 'Daikin', 'Hitachi', 'Godrej', 'Haier', 'IFB', 'Bosch', 'Panasonic', 'Orient', 'Usha', 'Kenstar', 'Prestige', 'Faber', 'Symphony'];
  for (const b of BRANDS) {
    if (new RegExp(`\\b${b.replace(/[-\s]/g, '[-\\s]?')}\\b`, 'i').test(text)) { out.brand = b; break; }
  }

  const CATS = { geyser: /geyser|water\s*heater/i, ac: /\bair\s*condition|\bA\/?C\b|split\s*ac|inverter\s*ac/i, fridge: /refrigerator|fridge/i, washing_machine: /washing\s*machine/i, fan: /\bfan\b/i };
  for (const [cat, re] of Object.entries(CATS)) { if (re.test(text)) { out.category = cat; break; } }

  const model = text.match(/(?:model|model\s*no\.?|model\s*name)[\s:.#-]*([A-Za-z0-9\-\/]{3,25})/i);
  if (model) out.model = model[1];
  const serial = text.match(/(?:serial|serial\s*no\.?|s\/n|sr\.?\s*no\.?)[\s:.#-]*([A-Za-z0-9\-]{5,25})/i);
  if (serial) out.serial_number = serial[1];

  const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const d1 = text.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[,\s]+(\d{4})/i);
  const d2 = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (d1) out.purchase_date = `${d1[3]}-${MONTHS[d1[2].toLowerCase().slice(0, 3)]}-${d1[1].padStart(2, '0')}`;
  else if (d2) out.purchase_date = `${d2[3]}-${d2[2].padStart(2, '0')}-${d2[1].padStart(2, '0')}`;

  const warr = text.match(/(\d{1,2})\s*(?:year|yr)s?\s*warranty|warranty[\s:]*(\d{1,2})\s*(?:year|yr)/i);
  if (warr) out.warranty_months = (parseInt(warr[1] || warr[2], 10)) * 12;
  else { const wm = text.match(/(\d{1,2})\s*months?\s*warranty/i); if (wm) out.warranty_months = parseInt(wm[1], 10); }

  return out;
};

module.exports = { parsePropertyFromText, parseTenantsFromText, parsePaymentProof, parseApplianceFromText, parseAgreementFactsFromText };
