// Pure helpers for the maintenance/equipment/vendor/rent-credit workflow
// (migration 014). No I/O, no Supabase, no Express -- everything here is a
// plain function of its arguments so it can be unit-tested directly. The
// routes in server.js call these to decide what's allowed; they never
// duplicate this logic inline.

const REQUEST_STATUSES = ['reported', 'awaiting_approval', 'approved', 'rejected', 'in_progress', 'resolved'];
const CONDITION_STATUSES = ['working', 'needs_verification', 'issue_reported', 'under_repair', 'repaired', 'replaced', 'removed'];
const URGENCY_LEVELS = ['low', 'normal', 'high'];
const SETTLEMENT_TYPES = ['rent_credit', 'reimbursement'];
const SETTLEMENT_STATUSES = ['pending', 'applied', 'cancelled'];
const SETTLEMENT_METHODS = ['cash', 'upi', 'bank_transfer', 'cheque', 'rent_deduction', 'other'];
const PAID_BY_VALUES = ['owner', 'tenant', 'shared'];

// Matches the CHECK constraint exactly -- keep in sync with migration 014.
const REQUEST_STATUS_TRANSITIONS = {
  reported: ['awaiting_approval', 'approved', 'rejected', 'in_progress'],
  awaiting_approval: ['approved', 'rejected'],
  approved: ['in_progress', 'resolved', 'rejected'],
  in_progress: ['resolved', 'rejected'],
  resolved: [],   // terminal
  rejected: []    // terminal
};

function isValidRequestStatus(v) { return REQUEST_STATUSES.includes(v); }
function isValidConditionStatus(v) { return CONDITION_STATUSES.includes(v); }
function isValidUrgency(v) { return v == null || URGENCY_LEVELS.includes(v); }
function isValidPaidBy(v) { return PAID_BY_VALUES.includes(v); }
function isValidSettlementType(v) { return SETTLEMENT_TYPES.includes(v); }
function isValidSettlementMethod(v) { return v == null || SETTLEMENT_METHODS.includes(v); }

// A maintenance record in a terminal request_status (resolved/rejected) is
// fully locked -- no field on it may change through the owner PATCH route,
// not just request_status. This is a stricter rule than the DB enforces on
// its own; the DB only constrains the enum values themselves.
function isTerminalRequestStatus(status) {
  return status === 'resolved' || status === 'rejected';
}

// `from` may be any current value; `to` is the requested new value. Returns
// true only if that exact transition is in the allowed graph above.
function canTransitionRequestStatus(from, to) {
  if (!isValidRequestStatus(from) || !isValidRequestStatus(to)) return false;
  return REQUEST_STATUS_TRANSITIONS[from].includes(to);
}

// Settlement lifecycle is a closed two-edge graph: pending->applied,
// pending->cancelled. Nothing else is ever legal, including re-applying an
// already-applied/cancelled row or any same-state no-op.
function canTransitionSettlementStatus(from, to) {
  if (!SETTLEMENT_STATUSES.includes(from) || !SETTLEMENT_STATUSES.includes(to)) return false;
  if (from !== 'pending') return false;
  return to === 'applied' || to === 'cancelled';
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

// Real calendar-date check (not just digit-shape) -- rejects e.g. month 13
// or Feb 30, and correctly allows Feb 29 only in an actual leap year.
function isRealCalendarDate(year, month, day) {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

// Accepts 'YYYY-MM' (month 01-12) or 'YYYY-MM-DD' (a real calendar date) and
// normalizes to the first of that month, matching the existing
// payments.period convention elsewhere in this codebase. Returns null for a
// genuinely absent value, or {error} for a present-but-malformed OR
// present-but-impossible (e.g. 2026-02-30) one so the caller can 400
// instead of silently dropping or misnormalizing it.
function normalizeApplicablePeriod(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  const s = String(input).trim();
  const INVALID = { error: 'applicable_period must be in YYYY-MM or YYYY-MM-DD format' };

  const monthMatch = s.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) return INVALID;
    return { value: `${monthMatch[1]}-${monthMatch[2]}-01` };
  }

  const dayMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayMatch) {
    const year = Number(dayMatch[1]);
    const month = Number(dayMatch[2]);
    const day = Number(dayMatch[3]);
    if (!isRealCalendarDate(year, month, day)) return INVALID;
    return { value: `${dayMatch[1]}-${dayMatch[2]}-01` };
  }

  return INVALID;
}

// undefined/null are treated as "not supplied" (valid -- the field is
// optional); any supplied value must be a finite number > 0.
function isValidOptionalPositiveAmount(v) {
  if (v === undefined || v === null || v === '') return true;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function isValidPositiveAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function isValidOptionalNonNegativeAmount(v) {
  if (v === undefined || v === null || v === '') return true;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

// ---- Evidence upload validation ----

const ALLOWED_EVIDENCE_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'video/mp4', 'video/quicktime',
  'application/pdf'
];
const MAX_EVIDENCE_FILES = 5;
const MAX_EVIDENCE_TOTAL_BYTES = 100 * 1024 * 1024;

function isAllowedEvidenceMime(mimetype) {
  return ALLOWED_EVIDENCE_MIME_TYPES.includes(mimetype);
}

// Same sanitization regex already used elsewhere in server.js for uploaded
// filenames (deed documents) -- kept consistent rather than inventing a
// second convention.
function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9.\-_ ]/g, '_').slice(0, 100);
}

// The random component is generated by the caller (crypto.randomUUID() in
// server.js) and passed in -- keeps this module I/O-free and deterministic
// given its arguments, same convention as the rest of this file.
function buildEvidencePath({ propertyId, maintenanceId, uniqueId, filename }) {
  return `maintenance-evidence/${propertyId}/${maintenanceId}/${uniqueId}_${sanitizeFilename(filename)}`;
}

// ---- Evidence file-signature (magic byte) validation ----
// Multer's `mimetype` is entirely client-supplied (it's just an HTTP header
// on the multipart part) and cannot be trusted alone -- a relabeled file
// would sail through a MIME-only check. This inspects the actual leading
// bytes of the buffer and only accepts a file whose real content matches
// its claimed type. No dependency: the signature set here (JPEG/PNG/WebP/
// PDF magic numbers, plus ISO-base-media "ftyp" major-brand parsing for
// MP4/MOV/HEIC, which all share that container format) is small and stable
// enough to hand-roll.
function detectFileSignature(buffer) {
  if (!buffer || buffer.length < 4) return null;

  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';

  if (buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return 'image/png';
  }

  if (buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }

  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }

  // ISO base media container (MP4/MOV/HEIC all share this box structure) --
  // the 4-byte "major brand" right after the ftyp tag is what distinguishes
  // them, not the container format itself.
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').replace(/\0/g, '').trim().toLowerCase();
    const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'];
    const MP4_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'm4v', 'm4a', 'm4p', 'm4b', '3gp4', '3gp5', '3g2a', 'mmp4', 'dash'];
    if (HEIC_BRANDS.includes(brand)) return 'image/heic';
    if (brand === 'qt') return 'video/quicktime';
    if (MP4_BRANDS.includes(brand)) return 'video/mp4';
    return null; // ftyp container present but brand not recognized -- never guess
  }

  // Older QuickTime files can open directly with a top-level atom instead of
  // a leading ftyp box.
  if (buffer.length >= 8) {
    const atom = buffer.subarray(4, 8).toString('ascii');
    if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(atom)) return 'video/quicktime';
  }

  return null;
}

// A file is only trusted if its detected signature is both an allowed type
// AND exactly matches what the client claimed -- an allowed-but-mismatched
// pair (e.g. a real PNG uploaded with mimetype set to "image/jpeg") is
// rejected too, not silently corrected.
function isEvidenceSignatureValid(file) {
  const detected = detectFileSignature(file && file.buffer);
  if (!detected) return false;
  if (!isAllowedEvidenceMime(detected)) return false;
  return detected === file.mimetype;
}

// Validates an entire batch of uploaded files (count, total size, each
// file's claimed MIME type, then each file's actual signature) before any
// Storage call is made. Per-file size is enforced separately by the
// existing global Multer limit (50MB) -- this function only adds the
// checks Multer doesn't already do. Claimed-MIME-not-allowed is checked
// (and reported) before signature mismatch, so an already-rejected type
// never leaks a "content doesn't match" message instead of the clearer
// "type not allowed" one.
function validateEvidenceBatch(files) {
  const list = files || [];
  if (list.length > MAX_EVIDENCE_FILES) {
    return { valid: false, error: `At most ${MAX_EVIDENCE_FILES} files allowed per request` };
  }
  const totalBytes = list.reduce((sum, f) => sum + (f.size || 0), 0);
  if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
    return { valid: false, error: 'Combined upload size exceeds 100 MB' };
  }
  for (const f of list) {
    if (!isAllowedEvidenceMime(f.mimetype)) {
      return { valid: false, error: `File type not allowed: ${f.mimetype || 'unknown'}` };
    }
  }
  for (const f of list) {
    if (!isEvidenceSignatureValid(f)) {
      return { valid: false, error: `File content does not match its declared type: ${sanitizeFilename(f.originalname || 'file')}` };
    }
  }
  return { valid: true };
}

// ---- Rent-credit reconciliation ----

// Given a candidate `payments` row and the rent_credit's own property/
// tenant/period, decides whether that payment is a legitimate reconciliation
// target. Pure -- the route fetches the payment row, this function judges it.
function paymentReconciles({ payment, propertyId, tenantId, applicablePeriod }) {
  if (!payment) return false;
  if (payment.property_id !== propertyId) return false;
  if (tenantId && payment.tenant_id !== tenantId) return false;
  if (applicablePeriod && payment.period !== applicablePeriod) return false;
  return true;
}

module.exports = {
  REQUEST_STATUSES, CONDITION_STATUSES, URGENCY_LEVELS, SETTLEMENT_TYPES,
  SETTLEMENT_STATUSES, SETTLEMENT_METHODS, PAID_BY_VALUES,
  ALLOWED_EVIDENCE_MIME_TYPES, MAX_EVIDENCE_FILES, MAX_EVIDENCE_TOTAL_BYTES,
  isValidRequestStatus, isValidConditionStatus, isValidUrgency, isValidPaidBy,
  isValidSettlementType, isValidSettlementMethod, isTerminalRequestStatus,
  canTransitionRequestStatus, canTransitionSettlementStatus,
  normalizeApplicablePeriod,
  isValidOptionalPositiveAmount, isValidPositiveAmount, isValidOptionalNonNegativeAmount,
  isAllowedEvidenceMime, sanitizeFilename, buildEvidencePath, validateEvidenceBatch,
  detectFileSignature, isEvidenceSignatureValid,
  paymentReconciles
};
