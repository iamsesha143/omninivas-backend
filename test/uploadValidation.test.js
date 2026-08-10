// Pure unit tests for uploadValidation.js -- no server, no mock Supabase,
// no network. Synthetic in-memory buffers only; nothing here ever touches
// a real file or production data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateUploadedFile, DOCUMENT_UPLOAD_RULE, PHOTO_UPLOAD_RULE, MAX_DOCUMENT_BYTES, MAX_PHOTO_BYTES } = require('../uploadValidation');

const JPEG_BYTES = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n%mock pdf body for testing only\n');
// Minimal ISO-base-media container: 4-byte box size + 'ftyp' + 'isom' brand.
const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'), Buffer.from('isom', 'ascii')]);

function makeFile({ mimetype, buffer, size, originalname = 'file' }) {
  return { mimetype, buffer, size: size !== undefined ? size : buffer.length, originalname };
}

test('validateUploadedFile: no file is rejected', () => {
  const result = validateUploadedFile(null, DOCUMENT_UPLOAD_RULE);
  assert.equal(result.valid, false);
});

test('validateUploadedFile (documents rule): valid JPEG is accepted', () => {
  const file = makeFile({ mimetype: 'image/jpeg', buffer: JPEG_BYTES });
  assert.equal(validateUploadedFile(file, DOCUMENT_UPLOAD_RULE).valid, true);
});

test('validateUploadedFile (documents rule): valid PDF is accepted', () => {
  const file = makeFile({ mimetype: 'application/pdf', buffer: PDF_BYTES });
  assert.equal(validateUploadedFile(file, DOCUMENT_UPLOAD_RULE).valid, true);
});

test('validateUploadedFile (documents rule): PNG is accepted', () => {
  const file = makeFile({ mimetype: 'image/png', buffer: PNG_BYTES });
  assert.equal(validateUploadedFile(file, DOCUMENT_UPLOAD_RULE).valid, true);
});

test('validateUploadedFile (documents rule): video MIME is rejected -- documents/deed etc. are images+PDF only', () => {
  const file = makeFile({ mimetype: 'video/mp4', buffer: MP4_BYTES });
  const result = validateUploadedFile(file, DOCUMENT_UPLOAD_RULE);
  assert.equal(result.valid, false);
  assert.match(result.error, /type not allowed/i);
});

test('validateUploadedFile (photo rule): video MIME is rejected -- handover photo is images only', () => {
  const file = makeFile({ mimetype: 'video/mp4', buffer: MP4_BYTES });
  assert.equal(validateUploadedFile(file, PHOTO_UPLOAD_RULE).valid, false);
});

test('validateUploadedFile (photo rule): PDF MIME is rejected -- handover photo is images only, not documents', () => {
  const file = makeFile({ mimetype: 'application/pdf', buffer: PDF_BYTES });
  assert.equal(validateUploadedFile(file, PHOTO_UPLOAD_RULE).valid, false);
});

test('validateUploadedFile (photo rule): valid JPEG is accepted', () => {
  const file = makeFile({ mimetype: 'image/jpeg', buffer: JPEG_BYTES });
  assert.equal(validateUploadedFile(file, PHOTO_UPLOAD_RULE).valid, true);
});

test('validateUploadedFile: disallowed claimed MIME with a real matching signature is still rejected (not on the allowlist)', () => {
  const file = makeFile({ mimetype: 'application/zip', buffer: Buffer.from('PK mock zip bytes') });
  const result = validateUploadedFile(file, DOCUMENT_UPLOAD_RULE);
  assert.equal(result.valid, false);
  assert.match(result.error, /type not allowed/i);
});

test('validateUploadedFile: allowed claimed MIME but content does not match is rejected', () => {
  const file = makeFile({ mimetype: 'image/jpeg', buffer: Buffer.from('this is plain text, not a jpeg') });
  const result = validateUploadedFile(file, DOCUMENT_UPLOAD_RULE);
  assert.equal(result.valid, false);
  assert.match(result.error, /does not match/i);
});

test('validateUploadedFile: real JPEG bytes declared under a disallowed MIME is rejected on type, not signature', () => {
  const file = makeFile({ mimetype: 'application/octet-stream', buffer: JPEG_BYTES });
  const result = validateUploadedFile(file, DOCUMENT_UPLOAD_RULE);
  assert.equal(result.valid, false);
  assert.match(result.error, /type not allowed/i);
});

test('validateUploadedFile (documents rule): oversized file is rejected', () => {
  const file = makeFile({ mimetype: 'image/jpeg', buffer: JPEG_BYTES, size: MAX_DOCUMENT_BYTES + 1 });
  const result = validateUploadedFile(file, DOCUMENT_UPLOAD_RULE);
  assert.equal(result.valid, false);
  assert.match(result.error, /too large/i);
});

test('validateUploadedFile (photo rule): oversized file is rejected', () => {
  const file = makeFile({ mimetype: 'image/jpeg', buffer: JPEG_BYTES, size: MAX_PHOTO_BYTES + 1 });
  const result = validateUploadedFile(file, PHOTO_UPLOAD_RULE).valid;
  assert.equal(result, false);
});

test('validateUploadedFile (documents rule): file at exactly the size cap is accepted', () => {
  const file = makeFile({ mimetype: 'image/jpeg', buffer: JPEG_BYTES, size: MAX_DOCUMENT_BYTES });
  assert.equal(validateUploadedFile(file, DOCUMENT_UPLOAD_RULE).valid, true);
});
