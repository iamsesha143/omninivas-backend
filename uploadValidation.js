// Route-specific upload validation for the non-evidence upload routes
// (documents/deed, tenant documents, payment proof, appliance bill scan,
// handover photo). Deliberately separate from maintenanceWorkflow.js's own
// evidence validation (images+video+PDF, batch-aware) -- that module and its
// existing behavior/tests are left completely untouched by this file.
//
// Reuses maintenanceWorkflow.js's magic-byte signature detector
// (detectFileSignature) as the single source of truth for "does this file's
// real content match a known type" -- not duplicated here. Multer's
// `mimetype` is entirely client-supplied and cannot be trusted alone; a file
// is only accepted if its claimed MIME type is on the route's allowlist AND
// its actual leading bytes match that same type.

const { detectFileSignature, sanitizeFilename } = require('./maintenanceWorkflow');

// HEIC included alongside JPEG/PNG/WebP -- iPhone photos of documents/bills/
// receipts are commonly HEIC, and rejecting it would break a real, common
// upload path, not just a hypothetical one.
const DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

// Per-purpose caps, independently of Multer's blanket 50MB ceiling (which
// stays as the outer safety net for every route, untouched) -- a payment
// screenshot or a handover photo has no legitimate reason to be as large as
// the evidence route's own 100MB batch allowance.
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

const DOCUMENT_UPLOAD_RULE = { allowedMimeTypes: DOCUMENT_MIME_TYPES, maxBytes: MAX_DOCUMENT_BYTES, label: 'this upload' };
const PHOTO_UPLOAD_RULE = { allowedMimeTypes: PHOTO_MIME_TYPES, maxBytes: MAX_PHOTO_BYTES, label: 'this photo' };

// Order matches maintenanceWorkflow.js's validateEvidenceBatch: size, then
// claimed-MIME-not-allowed, then signature mismatch -- so an already-rejected
// type never leaks the more confusing "content doesn't match" message.
function validateUploadedFile(file, rule) {
  if (!file) return { valid: false, error: 'No file provided' };
  if (file.size > rule.maxBytes) {
    return { valid: false, error: `File is too large for ${rule.label} (max ${Math.round(rule.maxBytes / (1024 * 1024))} MB)` };
  }
  if (!rule.allowedMimeTypes.includes(file.mimetype)) {
    return { valid: false, error: `File type not allowed for ${rule.label}: ${file.mimetype || 'unknown'}` };
  }
  const detected = detectFileSignature(file.buffer);
  if (!detected || !rule.allowedMimeTypes.includes(detected) || detected !== file.mimetype) {
    return { valid: false, error: `File content does not match its declared type: ${sanitizeFilename(file.originalname || 'file')}` };
  }
  return { valid: true };
}

module.exports = {
  DOCUMENT_MIME_TYPES, PHOTO_MIME_TYPES, MAX_DOCUMENT_BYTES, MAX_PHOTO_BYTES,
  DOCUMENT_UPLOAD_RULE, PHOTO_UPLOAD_RULE,
  validateUploadedFile
};
