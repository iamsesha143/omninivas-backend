// Pure unit tests for maintenanceWorkflow.js -- no Supabase, no network, no
// database. Run with: node --test test/maintenanceWorkflow.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wf = require('../maintenanceWorkflow');

test('canTransitionRequestStatus allows the documented graph', () => {
  assert.equal(wf.canTransitionRequestStatus('reported', 'awaiting_approval'), true);
  assert.equal(wf.canTransitionRequestStatus('reported', 'approved'), true);
  assert.equal(wf.canTransitionRequestStatus('reported', 'rejected'), true);
  assert.equal(wf.canTransitionRequestStatus('reported', 'in_progress'), true);
  assert.equal(wf.canTransitionRequestStatus('awaiting_approval', 'approved'), true);
  assert.equal(wf.canTransitionRequestStatus('awaiting_approval', 'rejected'), true);
  assert.equal(wf.canTransitionRequestStatus('approved', 'in_progress'), true);
  assert.equal(wf.canTransitionRequestStatus('approved', 'resolved'), true);
  assert.equal(wf.canTransitionRequestStatus('approved', 'rejected'), true);
  assert.equal(wf.canTransitionRequestStatus('in_progress', 'resolved'), true);
  assert.equal(wf.canTransitionRequestStatus('in_progress', 'rejected'), true);
});

test('canTransitionRequestStatus rejects illegal/terminal/unknown transitions', () => {
  assert.equal(wf.canTransitionRequestStatus('resolved', 'in_progress'), false, 'resolved is terminal');
  assert.equal(wf.canTransitionRequestStatus('rejected', 'approved'), false, 'rejected is terminal');
  assert.equal(wf.canTransitionRequestStatus('awaiting_approval', 'reported'), false, 'no backward transition');
  assert.equal(wf.canTransitionRequestStatus('reported', 'resolved'), false, 'cannot skip straight to resolved');
  assert.equal(wf.canTransitionRequestStatus('approved', 'awaiting_approval'), false);
  assert.equal(wf.canTransitionRequestStatus('reported', 'reported'), false, 'same-state is not a transition');
  assert.equal(wf.canTransitionRequestStatus('bogus', 'approved'), false, 'unknown status rejected');
  assert.equal(wf.canTransitionRequestStatus('reported', 'bogus'), false, 'unknown target rejected');
});

test('isTerminalRequestStatus', () => {
  assert.equal(wf.isTerminalRequestStatus('resolved'), true);
  assert.equal(wf.isTerminalRequestStatus('rejected'), true);
  assert.equal(wf.isTerminalRequestStatus('approved'), false);
  assert.equal(wf.isTerminalRequestStatus('reported'), false);
});

test('canTransitionSettlementStatus: closed two-edge graph only', () => {
  assert.equal(wf.canTransitionSettlementStatus('pending', 'applied'), true);
  assert.equal(wf.canTransitionSettlementStatus('pending', 'cancelled'), true);
  assert.equal(wf.canTransitionSettlementStatus('applied', 'cancelled'), false, 'applied is immutable');
  assert.equal(wf.canTransitionSettlementStatus('applied', 'pending'), false);
  assert.equal(wf.canTransitionSettlementStatus('cancelled', 'applied'), false, 'cancelled is immutable');
  assert.equal(wf.canTransitionSettlementStatus('pending', 'pending'), false, 'same-state is not a transition');
});

test('normalizeApplicablePeriod: valid inputs', () => {
  assert.deepEqual(wf.normalizeApplicablePeriod('2026-08'), { value: '2026-08-01' });
  assert.deepEqual(wf.normalizeApplicablePeriod('2026-08-15'), { value: '2026-08-01' });
  assert.deepEqual(wf.normalizeApplicablePeriod('2026-02'), { value: '2026-02-01' });
  assert.deepEqual(wf.normalizeApplicablePeriod('2026-02-01'), { value: '2026-02-01' });
  assert.deepEqual(wf.normalizeApplicablePeriod('2024-02-29'), { value: '2024-02-01' }, '2024 is a real leap year');
  assert.deepEqual(wf.normalizeApplicablePeriod(null), { value: null });
  assert.deepEqual(wf.normalizeApplicablePeriod(undefined), { value: null });
  assert.deepEqual(wf.normalizeApplicablePeriod(''), { value: null });
});

test('normalizeApplicablePeriod: malformed inputs return an error, never a guess', () => {
  assert.equal('error' in wf.normalizeApplicablePeriod('August 2026'), true);
  assert.equal('error' in wf.normalizeApplicablePeriod('2026/08'), true);
  assert.equal('error' in wf.normalizeApplicablePeriod('26-08'), true);
  assert.equal('error' in wf.normalizeApplicablePeriod('not-a-date'), true);
});

test('normalizeApplicablePeriod: rejects digit-shaped but impossible calendar values', () => {
  assert.equal('error' in wf.normalizeApplicablePeriod('2026-00'), true, 'month 00 does not exist');
  assert.equal('error' in wf.normalizeApplicablePeriod('2026-13'), true, 'month 13 does not exist');
  assert.equal('error' in wf.normalizeApplicablePeriod('2026-02-30'), true, '2026 is not a leap year -- Feb has 28 days');
  assert.equal('error' in wf.normalizeApplicablePeriod('2026-99-99'), true);
});

test('amount validators', () => {
  assert.equal(wf.isValidOptionalPositiveAmount(undefined), true);
  assert.equal(wf.isValidOptionalPositiveAmount(null), true);
  assert.equal(wf.isValidOptionalPositiveAmount(''), true);
  assert.equal(wf.isValidOptionalPositiveAmount('100'), true);
  assert.equal(wf.isValidOptionalPositiveAmount(0), false, 'zero is not > 0');
  assert.equal(wf.isValidOptionalPositiveAmount(-5), false);
  assert.equal(wf.isValidOptionalPositiveAmount('abc'), false);
  assert.equal(wf.isValidOptionalPositiveAmount(NaN), false);

  assert.equal(wf.isValidPositiveAmount(500), true);
  assert.equal(wf.isValidPositiveAmount(0), false);
  assert.equal(wf.isValidPositiveAmount(-1), false);
  assert.equal(wf.isValidPositiveAmount(undefined), false, 'required field, unlike the optional variant');

  assert.equal(wf.isValidOptionalNonNegativeAmount(0), true);
  assert.equal(wf.isValidOptionalNonNegativeAmount(undefined), true);
  assert.equal(wf.isValidOptionalNonNegativeAmount(-0.01), false);
});

test('enum validators', () => {
  assert.equal(wf.isValidRequestStatus('approved'), true);
  assert.equal(wf.isValidRequestStatus('bogus'), false);
  assert.equal(wf.isValidConditionStatus('under_repair'), true);
  assert.equal(wf.isValidConditionStatus('broken'), false);
  assert.equal(wf.isValidUrgency('high'), true);
  assert.equal(wf.isValidUrgency(null), true, 'urgency is optional');
  assert.equal(wf.isValidUrgency('urgent'), false);
  assert.equal(wf.isValidPaidBy('shared'), true);
  assert.equal(wf.isValidPaidBy('landlord'), false);
  assert.equal(wf.isValidSettlementType('rent_credit'), true);
  assert.equal(wf.isValidSettlementType('discount'), false);
  assert.equal(wf.isValidSettlementMethod('upi'), true);
  assert.equal(wf.isValidSettlementMethod(null), true, 'method optional unless applying');
  assert.equal(wf.isValidSettlementMethod('venmo'), false);
});

test('isAllowedEvidenceMime', () => {
  assert.equal(wf.isAllowedEvidenceMime('image/jpeg'), true);
  assert.equal(wf.isAllowedEvidenceMime('application/pdf'), true);
  assert.equal(wf.isAllowedEvidenceMime('video/mp4'), true);
  assert.equal(wf.isAllowedEvidenceMime('application/zip'), false);
  assert.equal(wf.isAllowedEvidenceMime('text/html'), false);
  assert.equal(wf.isAllowedEvidenceMime(undefined), false);
});

test('sanitizeFilename strips unsafe characters and path separators', () => {
  assert.equal(wf.sanitizeFilename('../../etc/passwd'), '.._.._etc_passwd');
  // The output must never contain a path separator, regardless of input --
  // this is what actually matters for the evidence-path construction below.
  assert.equal(wf.sanitizeFilename('a/b\\c').includes('/'), false);
  assert.equal(wf.sanitizeFilename('a/b\\c').includes('\\'), false);
  // Output is always restricted to the same safe character set the rest of
  // this codebase already uses for uploaded filenames.
  assert.equal(/^[a-zA-Z0-9.\-_ ]+$/.test(wf.sanitizeFilename('weird<>name?.png')), true);
  assert.equal(/^[a-zA-Z0-9.\-_ ]+$/.test(wf.sanitizeFilename('geyser photo (1).jpg')), true);
});

test('buildEvidencePath matches the documented convention', () => {
  const path = wf.buildEvidencePath({ propertyId: 'prop1', maintenanceId: 'maint1', uniqueId: 'ab12cd34-uuid', filename: 'photo.jpg' });
  assert.equal(path, 'maintenance-evidence/prop1/maint1/ab12cd34-uuid_photo.jpg');
});

// ---- File-signature (magic byte) detection ----

const JPEG_BYTES = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP')]);
const PDF_BYTES = Buffer.from('%PDF-1.7\nrest of file');
const HEIC_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('heic')]);
const MP4_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('isom')]);
const MOV_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x14]), Buffer.from('ftyp'), Buffer.from('qt  ')]);
const UNKNOWN_FTYP_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('zzzz')]);
const GARBAGE_BYTES = Buffer.from('this is not any known file type at all');

test('detectFileSignature recognizes every allowed type by magic bytes', () => {
  assert.equal(wf.detectFileSignature(JPEG_BYTES), 'image/jpeg');
  assert.equal(wf.detectFileSignature(PNG_BYTES), 'image/png');
  assert.equal(wf.detectFileSignature(WEBP_BYTES), 'image/webp');
  assert.equal(wf.detectFileSignature(PDF_BYTES), 'application/pdf');
  assert.equal(wf.detectFileSignature(HEIC_BYTES), 'image/heic');
  assert.equal(wf.detectFileSignature(MP4_BYTES), 'video/mp4');
  assert.equal(wf.detectFileSignature(MOV_BYTES), 'video/quicktime');
});

test('detectFileSignature returns null for unknown/absent/too-short signatures, never a guess', () => {
  assert.equal(wf.detectFileSignature(UNKNOWN_FTYP_BYTES), null, 'ftyp box present but unrecognized brand');
  assert.equal(wf.detectFileSignature(GARBAGE_BYTES), null);
  assert.equal(wf.detectFileSignature(Buffer.from([0xFF])), null, 'too short to inspect');
  assert.equal(wf.detectFileSignature(null), null);
  assert.equal(wf.detectFileSignature(Buffer.alloc(0)), null);
});

test('isEvidenceSignatureValid: accepts only a signature that matches the claimed mimetype', () => {
  assert.equal(wf.isEvidenceSignatureValid({ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }), true);
  assert.equal(wf.isEvidenceSignatureValid({ buffer: PDF_BYTES, mimetype: 'application/pdf' }), true);
});

test('isEvidenceSignatureValid: rejects a claimed type that does not match the real signature', () => {
  assert.equal(wf.isEvidenceSignatureValid({ buffer: PNG_BYTES, mimetype: 'image/jpeg' }), false, 'real PNG mislabeled as JPEG');
  assert.equal(wf.isEvidenceSignatureValid({ buffer: JPEG_BYTES, mimetype: 'application/pdf' }), false);
});

test('isEvidenceSignatureValid: rejects an unknown/absent signature even if the claimed type is allowed', () => {
  assert.equal(wf.isEvidenceSignatureValid({ buffer: GARBAGE_BYTES, mimetype: 'image/jpeg' }), false);
  assert.equal(wf.isEvidenceSignatureValid({ buffer: null, mimetype: 'image/jpeg' }), false);
});

test('validateEvidenceBatch: happy path', () => {
  const files = [
    { size: 1024, mimetype: 'image/jpeg', buffer: JPEG_BYTES },
    { size: 2048, mimetype: 'application/pdf', buffer: PDF_BYTES }
  ];
  assert.deepEqual(wf.validateEvidenceBatch(files), { valid: true });
});

test('validateEvidenceBatch: signature mismatch rejected even when count/size/claimed-MIME are all fine', () => {
  const files = [{ size: 1024, mimetype: 'image/jpeg', buffer: GARBAGE_BYTES }];
  const result = wf.validateEvidenceBatch(files);
  assert.equal(result.valid, false);
  assert.match(result.error, /does not match its declared type/);
});

test('validateEvidenceBatch: too many files', () => {
  const files = Array.from({ length: 6 }, () => ({ size: 100, mimetype: 'image/jpeg' }));
  const result = wf.validateEvidenceBatch(files);
  assert.equal(result.valid, false);
  assert.match(result.error, /At most 5 files/);
});

test('validateEvidenceBatch: total size over 100MB rejected even if each file is under the per-file limit', () => {
  const files = [
    { size: 40 * 1024 * 1024, mimetype: 'video/mp4' },
    { size: 40 * 1024 * 1024, mimetype: 'video/mp4' },
    { size: 30 * 1024 * 1024, mimetype: 'video/mp4' }
  ];
  const result = wf.validateEvidenceBatch(files);
  assert.equal(result.valid, false);
  assert.match(result.error, /100 MB/);
});

test('validateEvidenceBatch: disallowed MIME type rejected', () => {
  const files = [{ size: 100, mimetype: 'application/x-msdownload' }];
  const result = wf.validateEvidenceBatch(files);
  assert.equal(result.valid, false);
  assert.match(result.error, /not allowed/);
});

test('paymentReconciles: matches on property + tenant + period', () => {
  const payment = { property_id: 'p1', tenant_id: 't1', period: '2026-08-01' };
  assert.equal(wf.paymentReconciles({ payment, propertyId: 'p1', tenantId: 't1', applicablePeriod: '2026-08-01' }), true);
});

test('paymentReconciles: rejects property mismatch', () => {
  const payment = { property_id: 'p2', tenant_id: 't1', period: '2026-08-01' };
  assert.equal(wf.paymentReconciles({ payment, propertyId: 'p1', tenantId: 't1', applicablePeriod: '2026-08-01' }), false);
});

test('paymentReconciles: rejects tenant mismatch', () => {
  const payment = { property_id: 'p1', tenant_id: 't2', period: '2026-08-01' };
  assert.equal(wf.paymentReconciles({ payment, propertyId: 'p1', tenantId: 't1', applicablePeriod: '2026-08-01' }), false);
});

test('paymentReconciles: rejects period mismatch', () => {
  const payment = { property_id: 'p1', tenant_id: 't1', period: '2026-07-01' };
  assert.equal(wf.paymentReconciles({ payment, propertyId: 'p1', tenantId: 't1', applicablePeriod: '2026-08-01' }), false);
});

test('paymentReconciles: null payment never reconciles', () => {
  assert.equal(wf.paymentReconciles({ payment: null, propertyId: 'p1', tenantId: 't1', applicablePeriod: '2026-08-01' }), false);
});
