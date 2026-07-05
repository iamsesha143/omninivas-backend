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
  if (!text) text = '';

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

  return {
    property_name: propertyName.substring(0, 80),
    street_address: address || `${city}`,
    city,
    state,
    pincode: pincode || '560000',
    property_type: propertyType,
    flat_number: flatNumber,
    society_name: society
  };
};

const parseTenantsFromText = (text) => {
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

module.exports = { parsePropertyFromText, parseTenantsFromText };
