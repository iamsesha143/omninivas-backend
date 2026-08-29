require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const multer = require('multer');
const ws = require('ws');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf');
const Tesseract = require('tesseract.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const rateLimit = require('express-rate-limit');
const { Redis } = require('@upstash/redis');
const mw = require('./maintenanceWorkflow');
const uploadValidation = require('./uploadValidation');
const reminders = require('./reminders');
const { todayISOInTimezone, dueDateForExplicitMonth, daysInMonth } = require('./dateUtils');
const aiGateway = require('./aiGateway');
const notifications = require('./notifications');
const backupCore = require('./backupCore');
const runReminders = require('./jobs/runReminders');
const razorpayClient = require('./razorpayClient');
const cashflow = require('./cashflow');
const loanMath = require('./loanMath');

const app = express();

// Railway's edge terminates the client connection and adds one X-Forwarded-For
// entry, then an internal hop forwards to the container as a second, separate
// connection - so two hops need to be trusted, not one. Traced through
// proxy-addr's exact algorithm against captured request data: trust proxy = 1
// resolved req.ip to that unstable internal hop; = 2 resolves correctly to
// the real, stable client IP.
app.set('trust proxy', 2);

app.use(cors({
  origin: ['https://omninivas-frontend-production.up.railway.app', 'http://localhost:3000', 'http://localhost:4173'],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// `verify` captures the exact raw bytes alongside the normal parsed body --
// needed for the Razorpay webhook route's HMAC signature check, which must
// be computed over the raw request body, never a re-stringified req.body
// (JSON.stringify can reorder/reformat in ways that change the byte
// sequence and silently break a correct signature). No effect on any other
// route; req.rawBody is simply unused everywhere else.
app.use(express.json({ limit: '50mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Custom express-rate-limit Store backed by Upstash, using only plain
// commands (incr/pexpire/pttl/decr/del) - no Lua/EVALSHA, which behaved
// inconsistently when proxied through Upstash's REST API in testing.
class UpstashRateLimitStore {
  constructor(redis, prefix) {
    this.redis = redis;
    this.prefix = prefix;
    this.localKeys = false;
  }
  init(options) {
    this.windowMs = options.windowMs;
  }
  prefixKey(key) {
    return `${this.prefix}${key}`;
  }
  async increment(key) {
    const redisKey = this.prefixKey(key);
    const totalHits = await this.redis.incr(redisKey);
    if (totalHits === 1) {
      await this.redis.pexpire(redisKey, this.windowMs);
    }
    const ttl = await this.redis.pttl(redisKey);
    const resetTime = new Date(Date.now() + (ttl > 0 ? ttl : this.windowMs));
    return { totalHits, resetTime };
  }
  async decrement(key) {
    await this.redis.decr(this.prefixKey(key));
  }
  async resetKey(key) {
    await this.redis.del(this.prefixKey(key));
  }
  async get(key) {
    const redisKey = this.prefixKey(key);
    const totalHits = await this.redis.get(redisKey);
    if (totalHits === null || totalHits === undefined) return void 0;
    const ttl = await this.redis.pttl(redisKey);
    return { totalHits: Number(totalHits), resetTime: new Date(Date.now() + Math.max(ttl, 0)) };
  }
}

let makeRedisStore = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = Redis.fromEnv();
  makeRedisStore = (prefix) => new UpstashRateLimitStore(redis, prefix);
  console.log('Rate limiter: using Redis store');
} else {
  console.warn('Rate limiter: using in-memory store (fallback) - UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set');
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  ...(makeRedisStore ? { store: makeRedisStore('rl:global:') } : {}),
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  ...(makeRedisStore ? { store: makeRedisStore('rl:auth:') } : {}),
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many login attempts. Please try again in 15 minutes.' });
  },
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || '',
  { realtime: { transport: ws } }
);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Server will not start.');
  process.exit(1);
}

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.sub;
    req.role = decoded.role || 'owner';
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const requireOwner = (req, res, next) => {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Owner access only' });
  next();
};

// User-controlled strings (property names, tenant names, obligation labels,
// owner full_name/email) get interpolated directly into hand-built HTML
// responses in a few places below (CA export, rent receipt) -- this is what
// stands between a property named e.g. "<script>..." and stored XSS in a
// page an owner or their CA opens.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Standard error responses for the maintenance/equipment/vendor/rent-credit
// routes (migration 014 and everything built on it). A cross-owner or
// cross-tenant lookup and a genuinely nonexistent resource both produce this
// exact same 404 -- never distinguishing "doesn't exist" from "exists but
// isn't yours" in the response. Unexpected errors are logged with full
// detail server-side and NEVER expose err.message/SQL/constraint names/
// storage paths/credentials to the client.
const notFound = (res) => res.status(404).json({ error: 'Not found' });
const badRequest = (res, message) => res.status(400).json({ error: message });
const unexpectedError = (routeLabel, err, res) => {
  console.error(`[${routeLabel}]`, err);
  res.status(500).json({ error: 'Unable to complete the request.' });
};

// Multer throws (calls next(err)) for file-count/size violations, which
// would otherwise bypass the route handler entirely and fall through to the
// generic 500 error handler at the bottom of this file -- a validation
// failure, not an unexpected server error. This 4-arg (error-handling)
// middleware sits between `upload.array(...)` and the route handler on
// every evidence-upload route, converting known Multer errors into the same
// 400 policy as everything else, and any other upload error into a generic
// safe message. Never exposes err.message/multer internals to the client.
const handleUploadErrors = (err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_COUNT') return badRequest(res, `At most ${mw.MAX_EVIDENCE_FILES} files allowed per request`);
  if (err.code === 'LIMIT_FILE_SIZE') return badRequest(res, 'One or more files exceed the maximum file size');
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return badRequest(res, 'Unexpected file field');
  return badRequest(res, 'Invalid file upload');
};

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: 'MVP3.2-tenant-login',
    time: new Date().toISOString() 
  });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, full_name, phone_number } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const { data: existing } = await supabase.from('users').select('id').eq('email', email.trim().toLowerCase()).maybeSingle();
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
    const password_hash = await bcrypt.hash(password, 10);
    const row = { email: email.trim().toLowerCase(), full_name, phone_number, password_hash, whatsapp_webhook_token: crypto.randomBytes(16).toString('hex') };
    let { data, error } = await supabase.from('users').insert([row]).select();
    if (error && /password_hash/i.test(error.message || '')) {
      // users table predates the password_hash column; keep registration working until the migration runs
      delete row.password_hash;
      ({ data, error } = await supabase.from('users').insert([row]).select());
    }
    if (error) throw error;
    delete data[0].password_hash;
    const token = jwt.sign({ sub: data[0].id, email, role: 'owner' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: data[0], token, role: 'owner' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { data, error } = await supabase.from('users').select('*').eq('email', email.trim().toLowerCase()).single();
    if (error || !data) return res.status(401).json({ error: 'Invalid credentials' });
    if (data.password_hash) {
      const ok = await bcrypt.compare(password, data.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    } else {
      // Account created before password storage existed: adopt this password on first login
      const password_hash = await bcrypt.hash(password, 10);
      await supabase.from('users').update({ password_hash }).eq('id', data.id);
    }
    delete data.password_hash;
    const role = data.role || 'owner';
    const token = jwt.sign({ sub: data.id, email, role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: data, token, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PASSWORD RESET (self-service account recovery) =====

const RESET_TOKEN_TTL_MINUTES = 30;
// SHA-256, not bcrypt: the raw token already carries 256 bits of entropy
// (crypto.randomBytes(32)), so the property this hash needs is "can't be
// reversed from a DB dump", not "resists offline brute force" -- the latter
// is what a slow hash like bcrypt is for, and doesn't apply to a token this
// large. Matches the standard pattern used by Django/Rails/most frameworks.
const hashResetToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const FORGOT_PASSWORD_GENERIC_RESPONSE = { message: "If an account exists for this email, we've sent a reset link." };

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  // This route NEVER returns anything other than the one generic message,
  // on any path (found, not found, or an internal error) -- account
  // enumeration protection extends to error behavior too, not just the
  // happy path. Every failure is logged server-side only.
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (email) {
      const { data: user } = await supabase.from('users').select('id, email, full_name').eq('email', email).maybeSingle();
      // Token generation always runs, whether or not a user was found, to
      // narrow (not eliminate -- DB/email I/O still varies) the timing gap
      // between the "exists" and "doesn't exist" paths.
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(rawToken);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();
      if (user) {
        await supabase.from('users').update({
          // Overwriting these three columns is what invalidates any prior
          // outstanding token for this user -- its hash no longer matches.
          password_reset_token_hash: tokenHash, password_reset_expires_at: expiresAt, password_reset_used_at: null
        }).eq('id', user.id);
        const resetUrl = `${notifications.APP_URL}/reset-password?token=${rawToken}`;
        // Fire-and-forget, matching this codebase's existing email pattern --
        // a slow/failed send must never affect this endpoint's generic
        // response or its timing in a way that's observable to the caller.
        notifications.sendPasswordResetEmail(user, resetUrl, RESET_TOKEN_TTL_MINUTES).catch(() => {});
      }
    }
    res.json(FORGOT_PASSWORD_GENERIC_RESPONSE);
  } catch (err) {
    console.error('[POST /api/auth/forgot-password]', err);
    res.json(FORGOT_PASSWORD_GENERIC_RESPONSE);
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Reset token is required', reason: 'invalid' });
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const tokenHash = hashResetToken(token);
    const { data: user } = await supabase.from('users').select('id, password_reset_expires_at, password_reset_used_at')
      .eq('password_reset_token_hash', tokenHash).maybeSingle();
    // Distinguishing invalid/used/expired here is safe -- none of these
    // reveal WHICH email the token belonged to, only the token's own state,
    // and the frontend needs to show different copy for each.
    if (!user) return res.status(400).json({ error: 'This reset link is invalid.', reason: 'invalid' });
    if (user.password_reset_used_at) return res.status(400).json({ error: 'This reset link has already been used.', reason: 'used' });
    if (!user.password_reset_expires_at || new Date(user.password_reset_expires_at).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'This reset link has expired. Request a new one.', reason: 'expired' });
    }
    const password_hash = await bcrypt.hash(new_password, 10);
    await supabase.from('users').update({
      password_hash,
      // Belt-and-suspenders: clearing the hash makes the raw token
      // permanently unresolvable even if the used_at check were ever
      // bypassed by a future bug, on top of used_at itself.
      password_reset_token_hash: null, password_reset_expires_at: null, password_reset_used_at: new Date().toISOString()
    }).eq('id', user.id);
    // Existing JWTs are intentionally left valid -- this codebase has no
    // session/revocation table (stateless 30-day JWTs), so there is no safe
    // "invalidate every prior token" mechanism to call here. Disclosed
    // limitation, not an oversight: a device that was already logged in
    // before the reset stays logged in until its JWT naturally expires.
    res.json({ message: 'Password updated. Please log in with your new password.' });
  } catch (err) {
    console.error('[POST /api/auth/reset-password]', err);
    res.status(500).json({ error: 'Unable to reset password right now.' });
  }
});

// Works for both owner and tenant logins — both are rows in `users`, distinguished by `role`.
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('id, email, full_name, role, email_enabled, whatsapp_enabled').eq('id', req.userId).single();
    if (error || !data) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/auth/me/preferences', verifyToken, async (req, res) => {
  try {
    const allowed = {};
    if (req.body.email_enabled !== undefined) allowed.email_enabled = req.body.email_enabled;
    // whatsapp_enabled is a DPDP consent flag, not an ordinary preference --
    // the frontend only ever sends true after showing the full disclosure
    // (sender, message categories, opt-out), never as a silent default.
    if (req.body.whatsapp_enabled !== undefined) allowed.whatsapp_enabled = req.body.whatsapp_enabled;
    const { data, error } = await supabase.from('users').update(allowed).eq('id', req.userId).select('id, email, full_name, role, email_enabled, whatsapp_enabled');
    if (error) throw error;
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Owner-only diagnostic for the dormant AI gateway (agreement summaries,
// deposit suggestion, move-out deduction assistant, WhatsApp fact
// extraction all route through it -- see aiGateway.js). Never exposes the
// key, gateway URL, request headers, prompts, or raw gateway response --
// only whether it's configured, and (only when configured) the non-secret
// provider/model identifiers already visible in aiGateway.js's own console
// warning. Provider/model defaults mirror aiGateway.js's own fallbacks
// intentionally, rather than importing them, to keep this a read-only
// consumer of that module's public isConfigured()/run() surface.
// ?probe=true additionally runs one real, fixed, non-sensitive prompt
// through aiGateway.run() and reports only ok/failed -- never the response
// text. Not called automatically anywhere; fires only on an explicit
// owner-authenticated request.
app.get('/api/settings/ai-status', verifyToken, requireOwner, async (req, res) => {
  try {
    const configured = aiGateway.isConfigured();
    const response = { configured };
    if (configured) {
      response.provider = process.env.AI_GATEWAY_PROVIDER || 'groq';
      response.model = process.env.AI_GATEWAY_MODEL || 'llama-3.1-8b-instant';
    }
    if (req.query.probe === 'true') {
      const probeResult = await aiGateway.run('Reply with the single word OK.', { maxTokens: 5 });
      response.probe = probeResult.ok ? 'ok' : 'failed';
    }
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'Unable to determine AI status right now.' });
  }
});

// Machine-to-machine trigger for the daily DB backup (see backupCore.js). No
// JWT here deliberately -- the caller is an unattended GitHub Actions cron
// job, not a logged-in owner, so it authenticates with a static shared
// secret instead. timingSafeEqual guards against a timing side-channel on
// the secret comparison; the length check first avoids it throwing on
// mismatched buffer lengths.
app.post('/api/admin/backup', async (req, res) => {
  const provided = req.get('x-backup-secret') || '';
  const expected = process.env.BACKUP_SECRET || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await backupCore.runBackup();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('backup failed:', err.message);
    res.status(500).json({ ok: false, error: 'Backup failed' });
  }
});

// Machine-to-machine trigger for the reminder-generation job (see
// jobs/runReminders.js) -- same shared-secret pattern as /api/admin/backup,
// and deliberately its OWN secret rather than reusing BACKUP_SECRET, so a
// leaked trigger secret for one job can't also unlock the other.
// jobs/runReminders.js's own main() still requires SUPABASE_SERVICE_ROLE_KEY
// specifically (not the general SUPABASE_KEY this route/file otherwise
// uses) and refuses to run without it -- that safety property is preserved
// exactly as originally designed, only the trigger mechanism changed (from
// a Railway-native cron, never actually provisioned, to this endpoint).
app.post('/api/admin/run-reminders', async (req, res) => {
  const provided = req.get('x-reminders-secret') || '';
  const expected = process.env.REMINDERS_SECRET || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runReminders.main();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    console.error('run-reminders failed:', err.message);
    res.status(500).json({ ok: false, error: 'Reminder job failed' });
  }
});

const FEEDBACK_CATEGORIES = ['bug', 'feature_request', 'question', 'other'];

// In-app Help & Feedback (capture-only, no email/notification/review
// workflow in this slice). Works for both owner and tenant tokens -- both
// are rows in `users`, same dual-role pattern as GET /api/auth/me.
// user_id/role always come from the verified token, never from the
// request body, even if the client sends conflicting values for either.
app.post('/api/feedback', verifyToken, async (req, res) => {
  try {
    const { category, message, page, app_version, property_name } = req.body;
    if (!FEEDBACK_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${FEEDBACK_CATEGORIES.join(', ')}` });
    }
    const trimmedMessage = typeof message === 'string' ? message.trim() : '';
    if (trimmedMessage.length < 5 || trimmedMessage.length > 2000) {
      return res.status(400).json({ error: 'message must be between 5 and 2000 characters' });
    }
    const row = {
      user_id: req.userId,
      role: req.role,
      category,
      message: trimmedMessage,
      page: typeof page === 'string' ? page.trim().slice(0, 200) : null,
      app_version: typeof app_version === 'string' ? app_version.trim().slice(0, 50) : null,
      property_name: typeof property_name === 'string' ? property_name.trim().slice(0, 200) : null
    };
    const { data, error } = await supabase.from('feedback_submissions').insert([row]).select('id, created_at');
    if (error) throw error;
    res.status(201).json({ id: data[0].id, created_at: data[0].created_at });
  } catch (err) {
    res.status(500).json({ error: 'Could not save your feedback. Please try again.' });
  }
});

// No DB CHECK constraint yet (deliberately deferred -- see the property-type
// preflight audit before that migration is proposed). This is the only
// place values are currently constrained, matching the same client-safe-
// validation-before-a-raw-DB-error pattern already used for feedback
// categories.
const PROPERTY_TYPES = ['residential', 'commercial', 'land'];

app.post('/api/properties', verifyToken, async (req, res) => {
  try {
    const { property_name, city, state, street_address, pincode, property_type, agreement_summary, deposit_suggested_total, agreement_start_date, agreement_months } = req.body;

    if (!property_name || !city || !state || !pincode) {
      return res.status(400).json({ error: 'Property name, city, state, and pincode required' });
    }
    if (property_type !== undefined && !PROPERTY_TYPES.includes(property_type)) {
      return res.status(400).json({ error: `property_type must be one of: ${PROPERTY_TYPES.join(', ')}` });
    }

    // Duplicate guard: same owner, same name + pincode, not soft-deleted.
    const { data: dupe } = await supabase.from('properties').select('id')
      .eq('user_id', req.userId).is('deleted_at', null)
      .ilike('property_name', property_name.trim()).eq('pincode', pincode.trim()).maybeSingle();
    if (dupe) return res.status(409).json({ error: 'A property with this name and pincode already exists' });

    const { data, error } = await supabase.from('properties').insert([{
      user_id: req.userId,
      property_name: property_name.trim(),
      city: city.trim(),
      state: state.trim(),
      street_address: street_address ? street_address.trim() : '',
      pincode: pincode.trim(),
      property_type: property_type || 'residential',
      agreement_summary: agreement_summary || null,
      // Suggestion only -- not yet owner-confirmed. deposit_total stays null until
      // PATCH /api/properties/:id/deposit is called (Accept or manual Override).
      deposit_suggested_total: deposit_suggested_total || null,
      deposit_source: deposit_suggested_total ? 'agreement_ai' : null,
      agreement_start_date: agreement_start_date || null,
      agreement_months: agreement_months || 11
    }]).select();
    
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('properties').select('*').eq('user_id', req.userId).is('deleted_at', null);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('properties').select('*').eq('id', req.params.id).eq('user_id', req.userId).is('deleted_at', null).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Safe delete: soft-delete only (deleted_at), never a hard DELETE -- reversible,
// no cascade risk. Blocked if the property still has active tenants so nobody
// can lose a live tenancy's context by accident; owner must deactivate tenants
// first (existing PATCH /api/tenants/:id { is_active:false } flow).
app.delete('/api/properties/:id', verifyToken, async (req, res) => {
  try {
    const { data: prop } = await supabase.from('properties').select('id').eq('id', req.params.id).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
    if (!prop) return res.status(404).json({ error: 'Property not found' });
    const { data: activeTenants } = await supabase.from('tenants').select('id').eq('property_id', req.params.id).eq('is_active', true).limit(1);
    if (activeTenants && activeTenants.length > 0) {
      return res.status(409).json({ error: 'This property still has active tenants. Deactivate or move out all tenants before deleting it.' });
    }
    const { error } = await supabase.from('properties').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/properties/:id', verifyToken, async (req, res) => {
  try {
    if (req.body.property_type !== undefined && !PROPERTY_TYPES.includes(req.body.property_type)) {
      return res.status(400).json({ error: `property_type must be one of: ${PROPERTY_TYPES.join(', ')}` });
    }
    const allowed = {};
    for (const k of ['property_name', 'street_address', 'city', 'state', 'pincode', 'flat_number', 'society_name', 'property_type', 'agreement_start_date', 'agreement_months', 'property_tax_due_date']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    const { data, error } = await supabase.from('properties').update(allowed).eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirm a property's deposit: either accept the previously-suggested agreement_ai
// total, or set one manually. Either way, splits it equally across the CURRENT
// active tenant list and writes it to each tenant's existing deposit_amount column
// -- no new per-tenant column. Re-callable any time to correct/replace the split.
app.patch('/api/properties/:id/deposit', verifyToken, async (req, res) => {
  try {
    const { deposit_total, accept_suggestion, tenant_ids, source: requestedSource, confirm_override } = req.body;
    const { data: prop } = await supabase.from('properties').select('id,deposit_suggested_total,deposit_total,deposit_source').eq('id', req.params.id).eq('user_id', req.userId).is('deleted_at', null).single();
    if (!prop) return res.status(404).json({ error: 'Property not found' });
    let total, source;
    if (accept_suggestion) {
      if (!prop.deposit_suggested_total) return res.status(400).json({ error: 'No AI-suggested deposit to accept for this property' });
      total = prop.deposit_suggested_total; source = 'agreement_ai';
    } else {
      total = parseFloat(deposit_total);
      if (!total || total <= 0) return res.status(400).json({ error: 'A positive deposit_total is required' });
      if (total > 100000000) return res.status(400).json({ error: 'deposit_total is implausibly large' });
      source = 'manual';
    }
    // An explicit source in the body overrides the derived default above --
    // needed for the deterministic (non-AI) agreement-attach flow, which must
    // never be recorded under the legacy AI-only 'agreement_ai' label, and by
    // the WhatsApp deposit-agreed apply form so a chat-derived figure is never
    // recorded indistinguishably from a genuinely manual entry.
    if (requestedSource !== undefined) {
      if (!['manual', 'agreement', 'agreement_ai', 'whatsapp'].includes(requestedSource)) {
        return res.status(400).json({ error: 'source must be manual, agreement, agreement_ai, or whatsapp' });
      }
      source = requestedSource;
    }

    // A signed-agreement figure is stronger provenance than a WhatsApp chat
    // inference -- a WhatsApp-sourced apply that would silently change an
    // already agreement-sourced total is blocked as a reviewable discrepancy
    // instead, unless the caller explicitly confirms the override (the owner
    // has been shown both values and chose to proceed anyway).
    if (source === 'whatsapp' && prop.deposit_source === 'agreement' && prop.deposit_total != null
      && Number(prop.deposit_total) !== total && !confirm_override) {
      return res.status(409).json({
        error: 'discrepancy',
        message: 'This property already has an agreement-sourced deposit on record. Applying this WhatsApp figure would overwrite it.',
        current_total: prop.deposit_total, current_source: prop.deposit_source, incoming_total: total
      });
    }

    // Scoped assignment: only when the caller resolves specific tenant IDs
    // (e.g. the agreement-attach flow, which knows exactly which tenant(s)
    // this declaration is for). Validated against this property+owner before
    // any write happens -- a foreign/invalid ID rejects the whole request.
    let scopedTenants = null;
    if (tenant_ids !== undefined) {
      if (!Array.isArray(tenant_ids) || tenant_ids.length === 0) {
        return res.status(400).json({ error: 'tenant_ids must be a non-empty array' });
      }
      const { data: owned, error: tErr } = await supabase.from('tenants').select('id, deposit_paid_date')
        .eq('property_id', req.params.id).eq('user_id', req.userId).in('id', tenant_ids);
      if (tErr) throw tErr;
      const ownedIds = new Set((owned || []).map(t => t.id));
      const missing = tenant_ids.filter(id => !ownedIds.has(id));
      if (missing.length > 0) {
        return res.status(400).json({ error: `tenant_ids includes IDs that don't belong to this property: ${missing.join(', ')}` });
      }
      scopedTenants = owned;
    }

    const { data: updated, error } = await supabase.from('properties')
      .update({ deposit_total: total, deposit_source: source, deposit_confirmed_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;

    let tenantCount, perTenant, assignedCount, skippedConfirmedCount;
    if (scopedTenants) {
      // Never overwrite a tenant whose deposit is already confirmed received
      // -- excluded from the split entirely, not just from being touched.
      const assignable = scopedTenants.filter(t => !t.deposit_paid_date);
      skippedConfirmedCount = scopedTenants.length - assignable.length;
      tenantCount = assignable.length;
      perTenant = tenantCount > 0 ? Math.round((total / tenantCount) * 100) / 100 : null;
      assignedCount = tenantCount;
      if (tenantCount > 0) {
        const { error: uErr } = await supabase.from('tenants').update({ deposit_amount: perTenant }).in('id', assignable.map(t => t.id));
        if (uErr) throw uErr;
      }
    } else {
      // Legacy fallback (tenant_ids omitted): unchanged from before this
      // change -- every active tenant on the property, exactly as older
      // callers (new-property creation, the plain TenantsPage confirm flow)
      // already depend on.
      const { data: tenants } = await supabase.from('tenants').select('id').eq('property_id', req.params.id).eq('is_active', true);
      tenantCount = tenants?.length || 0;
      perTenant = tenantCount > 0 ? Math.round((total / tenantCount) * 100) / 100 : total;
      assignedCount = tenantCount;
      skippedConfirmedCount = 0;
      if (tenantCount > 0) {
        await supabase.from('tenants').update({ deposit_amount: perTenant }).eq('property_id', req.params.id).eq('is_active', true);
      }
    }
    res.json({ property: updated, per_tenant: perTenant, tenant_count: tenantCount, assigned_count: assignedCount, skipped_confirmed_count: skippedConfirmedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function detectFileType(filename, mimetype) {
  const ext = filename.toLowerCase().split('.').pop();
  return {
    isPDF: ext === 'pdf' || mimetype === 'application/pdf',
    isWord: ext.includes('doc') || mimetype.includes('word'),
    isImage: mimetype.includes('image')
  };
}

async function tryPDFTextExtraction(buffer) {
  try {
    const uint8Array = new Uint8Array(buffer);
    const pdf = await pdfjsLib.getDocument({data: uint8Array, isEvalSupported: false}).promise;
    let totalText = '';
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      totalText += textContent.items.map(item => item.str || '').join('');
    }
    return { isTextBased: totalText.length > 50, text: totalText };
  } catch (err) {
    return { isTextBased: false, text: '', error: err.message };
  }
}

async function extractTextFromImageBasedPDFWithImageMagick(buffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
  try {
    console.log('🔍 PDF is image-based, using ImageMagick + Tesseract.js for OCR...');
    const pdfPath = path.join(tempDir, 'input.pdf');
    fs.writeFileSync(pdfPath, buffer);
    console.log('🖼️  Converting PDF pages to PNG with ImageMagick...');
    const pngPattern = path.join(tempDir, 'page.png');
    try {
      execSync(`convert -density 150 "${pdfPath}" "${pngPattern}"`, { maxBuffer: 10 * 1024 * 1024 });
    } catch (err) {
      throw new Error(`ImageMagick conversion failed: ${err.message}`);
    }
    const files = fs.readdirSync(tempDir).filter(f => f.startsWith('page') && f.endsWith('.png')).sort();
    if (files.length === 0) throw new Error('ImageMagick failed to generate PNG files');
    console.log(`✅ Generated ${files.length} PNG files`);
    let allText = '';
    const maxPages = Math.min(files.length, 3);
    for (let i = 0; i < maxPages; i++) {
      const pngFile = path.join(tempDir, files[i]);
      console.log(`📖 Processing ${files[i]}...`);
      const result = await Tesseract.recognize(pngFile, 'eng');
      allText += result.data.text + '\n';
    }
    return allText;
  } catch (err) {
    throw new Error(`Image-based PDF extraction failed: ${err.message}`);
  } finally {
    try {
      const files = fs.readdirSync(tempDir);
      files.forEach(f => fs.unlinkSync(path.join(tempDir, f)));
      fs.rmdirSync(tempDir);
    } catch (err) {
      console.warn('Cleanup warning:', err.message);
    }
  }
}

async function extractDocumentText(buffer, filename, mimetype) {
  try {
    const fileType = detectFileType(filename, mimetype);
    if (fileType.isPDF) {
      console.log('📄 PDF detected, analyzing content...');
      const analysis = await tryPDFTextExtraction(buffer);
      if (analysis.isTextBased && analysis.text.length > 50) {
        console.log(`✅ PDF is text-based, extracted ${analysis.text.length} characters`);
        return analysis.text;
      } else {
        console.log('⚠️ PDF is image-based, falling back to ImageMagick + Tesseract.js');
        return await extractTextFromImageBasedPDFWithImageMagick(buffer);
      }
    }
    if (fileType.isWord) throw new Error('Word document extraction not yet implemented');
    if (fileType.isImage) {
      console.log('🖼️ Image detected, using Tesseract.js OCR...');
      const result = await Tesseract.recognize(buffer, 'eng');
      return result.data.text;
    }
    throw new Error('Unsupported file type');
  } catch (err) {
    throw new Error(`Document extraction failed: ${err.message}`);
  }
}

const { parsePropertyFromText, parseTenantsFromText, parsePaymentProof, parseApplianceFromText, parseAgreementFactsFromText } = require('./parsers');
const { summarizeAgreement, extractAgreementFacts, compareMoveInOut } = require('./llm');

app.post('/api/extract/property', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const text = await extractDocumentText(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!text || text.trim().length < 50) return res.status(400).json({ error: 'Could not extract text from document', textLength: text.length });
    const propertyData = parsePropertyFromText(text);
    // One gateway call now covers both the narrative summary's source data and
    // the structured clause facts below -- summarizeAgreement is a second call
    // for the prose text only (extractAgreementFacts can't produce that).
    const { summary } = await summarizeAgreement(text);
    const aiFacts = await extractAgreementFacts(text);
    // Deterministic regex extraction (parsers.js) runs unconditionally --
    // unlike aiFacts above, it has no dependency on the AI gateway (confirmed
    // dormant since 2026-08-03; see CLAUDE.md). Regex values win wherever
    // present since they carry a verifiable source snippet (regexFacts.evidence);
    // the AI facts fill in only what regex has no pattern for (painting_clause)
    // or when the gateway happens to be configured and regex found nothing.
    const regexFacts = parseAgreementFactsFromText(text);

    const rentAmount = regexFacts.rent_amount ?? (aiFacts.skipped ? null : aiFacts.rent_amount);
    const maintenancePayer = regexFacts.maintenance_payer ?? (aiFacts.skipped ? null : aiFacts.maintenance_payer);
    const electricityPayer = regexFacts.electricity_payer ?? (aiFacts.skipped ? null : aiFacts.electricity_payer);
    const depositTotal = regexFacts.deposit_total ?? (aiFacts.skipped ? null : aiFacts.deposit_total);
    // AI fixtures (plain strings, no quantity) only ever fill in when regex
    // found nothing at all -- never merged item-by-item with regex fixtures,
    // to avoid a duplicate entry for the same physical item under two names.
    const fixtures = regexFacts.fixtures.length > 0
      ? regexFacts.fixtures
      : (aiFacts.skipped ? [] : (aiFacts.fixtures || []).map(name => ({ name, quantity: 1 })));
    const paintingClause = aiFacts.skipped ? null : aiFacts.painting_clause;

    const hasAnyFact = rentAmount !== null || regexFacts.rent_due_day !== null || depositTotal !== null
      || maintenancePayer !== null || electricityPayer !== null || paintingClause !== null || fixtures.length > 0;

    res.json({
      success: true, extractedData: propertyData, agreementSummary: summary,
      // skipped=true (missing key, short/unparsable text, or a failed call) simply
      // means no suggestion -- the frontend falls back to manual-only deposit entry.
      depositSuggestion: depositTotal === null ? null : {
        total: depositTotal, tenantCount: aiFacts.skipped ? null : aiFacts.tenant_count, refundable: regexFacts.deposit_refundable
      },
      // Additive: clause-level facts for the review step to show as verifiable,
      // editable suggestions -- never auto-written anywhere; the owner's
      // review-and-approve step (frontend) is what turns these into real
      // tenant/deposit/obligation/appliance records, not this route.
      agreementFacts: hasAnyFact ? {
        rentAmount, rentDueDay: regexFacts.rent_due_day,
        durationMonths: propertyData.agreement_months ?? (aiFacts.skipped ? null : aiFacts.duration_months),
        maintenancePayer, electricityPayer, paintingClause,
        depositTotal, depositRefundable: regexFacts.deposit_refundable,
        // Reference-only: a written continuation/escalation clause (e.g. "7%
        // increase after the written term if continued"). Never used to
        // compute a rent figure anywhere server-side -- the frontend shows
        // it purely as historical context alongside the written rent when
        // the owner is asked to confirm the PRESENT rent for a still-current
        // tenancy on an expired written term.
        rentEscalationPercent: regexFacts.rent_escalation_percent,
        // Fittings/fixtures/appliances explicitly listed in the agreement --
        // maps to the move-in/appliances/handover area; the review step offers
        // a one-tap "add these to the appliance registry" action, never silent.
        fixtures,
        // Exact source-text snippet per regex-found fact, for the review
        // screen to show provenance ("why do we think this"). AI-sourced
        // facts (when regex found nothing) have no snippet, since the AI
        // gateway doesn't return one.
        evidence: regexFacts.evidence
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract: ' + err.message });
  }
});

app.post('/api/extract/tenants', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const text = await extractDocumentText(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!text || text.trim().length < 50) return res.status(400).json({ error: 'Could not extract text from document', textLength: text.length });
    const tenants = parseTenantsFromText(text);
    res.json({ success: true, extractedData: { tenants } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract: ' + err.message });
  }
});

// Both tenant-creation routes below previously had NO property-ownership
// check at all -- a valid JWT for ANY owner could POST a tenant against
// ANY propertyId (only the inserted row's own user_id was ever set to the
// caller, the property_id itself was never verified as theirs). Fixed the
// same way as the precedented POST /api/properties/:propertyId/maintenance
// fix above: a maybeSingle() ownership lookup (also excluding soft-deleted
// properties) before any tenant read/write, and the shared notFound() helper
// (a generic 404, no "not yours" distinction) so a cross-owner probe can't
// learn whether a given property id exists at all, let alone what tenants
// are on it.
app.post('/api/properties/:propertyId/tenants', verifyToken, async (req, res) => {
  try {
    const { name, personal_email, personal_phone, date_of_move_in, aadhar_card } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const { data: property } = await supabase.from('properties').select('id').eq('id', req.params.propertyId).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
    if (!property) return notFound(res);
    const { data, error } = await supabase.from('tenants').insert([{ property_id: req.params.propertyId, user_id: req.userId, name: name.trim(), personal_email: personal_email ? personal_email.trim().toLowerCase() : '', personal_phone: personal_phone ? personal_phone.trim() : '', aadhar_card: aadhar_card || null, date_of_move_in: date_of_move_in || new Date().toISOString().split('T')[0], occupancy_type: 'single', is_active: true }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties/:propertyId/tenants/bulk', verifyToken, async (req, res) => {
  try {
    const { tenants } = req.body;
    if (!Array.isArray(tenants) || tenants.length === 0) return res.status(400).json({ error: 'Tenants array required' });
    const { data: property } = await supabase.from('properties').select('id').eq('id', req.params.propertyId).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
    if (!property) return notFound(res);
    const candidates = tenants.map(t => ({
      property_id: req.params.propertyId,
      user_id: req.userId,
      name: (t.name || '').trim(),
      personal_email: t.personal_email ? t.personal_email.trim().toLowerCase() : '',
      personal_phone: (t.personal_phone || '').trim(),
      aadhar_card: t.aadhar_card || null,
      date_of_move_in: t.date_of_move_in || new Date().toISOString().split('T')[0],
      occupancy_type: 'single',
      // Defaults to an active/current tenant, same as always. A caller may
      // explicitly pass is_active:false (with actual_date_of_move_out) to
      // save an already-expired agreement as a historical record instead --
      // e.g. AttachAgreementPanel, when the extracted lease term has already
      // ended and the owner hasn't confirmed the tenancy is still current.
      is_active: t.is_active === false ? false : true,
      actual_date_of_move_out: t.is_active === false ? (t.actual_date_of_move_out || null) : null
    })).filter(t => t.name);
    if (candidates.length === 0) return res.status(400).json({ error: 'No valid tenants: each tenant needs at least a name' });

    // Idempotency: a retried request (e.g. the client's first attempt
    // actually reached the server and inserted rows, but the response was
    // lost to a network drop, so the client retries the identical payload)
    // must not create duplicate tenant rows. An exact case-insensitive name
    // match against an already-active tenant on this same property is
    // linked instead of re-inserted -- the frontend already makes this same
    // new-vs-existing decision before the request is ever sent
    // (AttachAgreementPanel's tenantChoices pre-resolution), so this is
    // strictly a server-side safety net for the retry case, not a new
    // decision point or a weakening of owner isolation (still scoped to
    // this property_id + req.userId).
    const { data: existing, error: existingErr } = await supabase.from('tenants')
      .select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId).eq('is_active', true);
    if (existingErr) throw existingErr;
    const byName = new Map((existing || []).map(t => [t.name.trim().toLowerCase(), t]));

    const toInsert = [];
    const insertPositions = [];
    const results = new Array(candidates.length).fill(null);
    candidates.forEach((c, i) => {
      const match = byName.get(c.name.toLowerCase());
      if (match) results[i] = match;
      else { toInsert.push(c); insertPositions.push(i); }
    });

    let inserted = [];
    if (toInsert.length > 0) {
      const { data, error } = await supabase.from('tenants').insert(toInsert).select();
      if (error) throw error;
      inserted = data || [];
      insertPositions.forEach((pos, j) => { results[pos] = inserted[j]; });
    }

    res.status(201).json({ success: true, count: inserted.length, linked_count: candidates.length - inserted.length, tenants: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/tenants', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('tenants').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties/:propertyId/documents/deed', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const validation = uploadValidation.validateUploadedFile(req.file, uploadValidation.DOCUMENT_UPLOAD_RULE);
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    // The original filename is encoded straight into the storage key (Supabase
    // Storage's .list() doesn't reliably surface custom upload metadata) so the
    // listing route below can recover a real title instead of a bare timestamp.
    const safeName = (req.file.originalname || 'document').replace(/[^a-zA-Z0-9.\-_ ]/g, '_').slice(0, 100);
    const fileName = `properties/${req.params.propertyId}/deed_${Date.now()}_${safeName}`;
    const { error } = await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: req.file.mimetype, metadata: { user_id: req.userId } });
    if (error) throw error;
    const { data: signed } = await supabase.storage.from('documents').createSignedUrl(fileName, 3600);
    res.json({ success: true, url: signed?.signedUrl || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/documents', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.storage.from('documents').list(`properties/${req.params.propertyId}`, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
    if (error) throw error;
    const files = [];
    for (const f of (data || [])) {
      const path = `properties/${req.params.propertyId}/${f.name}`;
      const { data: signed } = await supabase.storage.from('documents').createSignedUrl(path, 3600);
      // Recover the readable filename encoded into the key at upload time.
      // Older files (uploaded before this) won't match and fall back to a
      // plain label rather than showing the raw storage key (a timestamp).
      const m = f.name.match(/^deed_\d+_(.+)$/);
      files.push({
        name: f.name, title: m ? m[1] : 'Property document', type: 'deed',
        created_at: f.created_at, size: f.metadata?.size, url: signed?.signedUrl || null
      });
    }
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties/:propertyId/tenants/:tenantId/documents/:docType', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!['aadhar', 'pan', 'id_proof'].includes(req.params.docType)) return res.status(400).json({ error: 'Invalid doc type' });
    const validation = uploadValidation.validateUploadedFile(req.file, uploadValidation.DOCUMENT_UPLOAD_RULE);
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    const fileName = `tenants/${req.params.tenantId}/${req.params.docType}_${Date.now()}`;
    const { error } = await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: req.file.mimetype, metadata: { user_id: req.userId, tenant_id: req.params.tenantId } });
    if (error) throw error;
    const { data: signed } = await supabase.storage.from('documents').createSignedUrl(fileName, 3600);
    res.json({ success: true, url: signed?.signedUrl || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties/:propertyId/payments', verifyToken, async (req, res) => {
  try {
    const { tenant_id, amount, payment_date, status, obligation_id, period } = req.body;
    if (!amount || (!tenant_id && !obligation_id)) return res.status(400).json({ error: 'Amount plus a tenant or an obligation required' });
    const { data, error } = await supabase.from('payments').insert([{
      property_id: req.params.propertyId,
      tenant_id: tenant_id || null,
      user_id: req.userId,
      obligation_id: obligation_id || null,
      period: /^\d{4}-\d{2}$/.test(period || '') ? `${period}-01` : null,
      amount: parseFloat(amount),
      payment_date: payment_date || new Date().toISOString().split('T')[0],
      payment_type: 'rent',
      payment_method: 'upi',
      status: status || 'paid'
    }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Razorpay's own webhook, not gated by the shared x-*-secret pattern used
// elsewhere in this file -- Razorpay itself is the caller, authenticated by
// its own HMAC signature (razorpayClient.verifyWebhookSignature), the
// standard mechanism for third-party webhooks. Returns 503 while
// RAZORPAY_WEBHOOK_SECRET is unset (today): nobody legitimate can be
// calling this yet, since no real webhook has ever been pointed at it.
// req.rawBody comes from the express.json() verify hook above -- signature
// verification must run against the exact raw bytes Razorpay sent, not the
// parsed-then-reserialized req.body.
//
// reference_id on the Payment Link (set at creation time, once
// razorpayClient.createPaymentLink() has a real implementation) is expected
// to be "<obligation_id>:<period>" -- this webhook only ever needs to
// resolve which obligation/period a payment belongs to, not carry any other
// state, so that's the whole design of the reference format.
app.post('/api/webhooks/razorpay', async (req, res) => {
  if (!razorpayClient.webhooksConfigured()) {
    return res.status(503).json({ error: 'Razorpay webhooks not configured' });
  }
  if (!razorpayClient.verifyWebhookSignature(req.rawBody, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    if (req.body.event !== 'payment_link.paid') {
      // Acknowledged, not an error -- Razorpay retries on non-2xx, and this
      // integration only acts on the one event type it's built around.
      return res.status(200).json({ ok: true, ignored: req.body.event });
    }
    const paymentEntity = req.body.payload?.payment?.entity;
    const linkEntity = req.body.payload?.payment_link?.entity;
    const [obligationId, period] = (linkEntity?.reference_id || '').split(':');
    if (!paymentEntity?.id || !obligationId || !/^\d{4}-\d{2}-01$/.test(period || '')) {
      return res.status(400).json({ error: 'Malformed payload' });
    }

    const { data: obligation, error: obErr } = await supabase.from('obligations')
      .select('id, property_id, user_id').eq('id', obligationId).maybeSingle();
    if (obErr) throw obErr;
    if (!obligation) return res.status(200).json({ ok: true, ignored: 'unknown obligation reference' });

    const { data, error } = await supabase.from('payments')
      .upsert([{
        property_id: obligation.property_id, user_id: obligation.user_id, obligation_id: obligation.id,
        period, amount: paymentEntity.amount / 100, payment_date: new Date().toISOString().slice(0, 10),
        payment_type: 'rent', payment_method: 'razorpay', status: 'paid',
        razorpay_payment_id: paymentEntity.id, razorpay_payment_link_id: linkEntity.id
      }], { onConflict: 'razorpay_payment_id', ignoreDuplicates: true })
      .select('id');
    if (error) throw error;

    res.status(200).json({ ok: true, created: (data || []).length > 0 });
  } catch (err) {
    console.error('razorpay webhook failed:', err.message);
    res.status(500).json({ ok: false, error: 'Webhook processing failed' });
  }
});

app.get('/api/properties/:propertyId/payments', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('payments').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId).order('payment_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OWNER: create a maintenance record directly (not via a tenant report).
// requireOwner + an explicit property-ownership check were both missing
// before this slice -- a non-owner token could previously insert a row
// against any propertyId with no verification at all.
app.post('/api/properties/:propertyId/maintenance', verifyToken, requireOwner, async (req, res) => {
  try {
    const { description, amount, cost_date, paid_by, vendor_name, vendor_phone, vendor_id, appliance_id, category, tenant_id, urgency, request_status } = req.body;
    if (!description || !description.trim()) return badRequest(res, 'Description required');
    if (!mw.isValidPaidBy(paid_by)) return badRequest(res, 'paid_by must be owner, tenant, or shared');
    if (!mw.isValidOptionalNonNegativeAmount(amount)) return badRequest(res, 'amount must be a non-negative number');
    if (!mw.isValidUrgency(urgency)) return badRequest(res, 'urgency must be low, normal, or high');
    const status = request_status || 'resolved'; // owner-created entries default to already-decided, matching prior behavior
    if (!mw.isValidRequestStatus(status)) return badRequest(res, 'Invalid request_status');

    const { data: property } = await supabase.from('properties').select('id').eq('id', req.params.propertyId).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
    if (!property) return notFound(res);

    if (appliance_id) {
      const { data: appl } = await supabase.from('appliances').select('id').eq('id', appliance_id).eq('property_id', req.params.propertyId).eq('user_id', req.userId).maybeSingle();
      if (!appl) return badRequest(res, 'appliance_id does not belong to this property');
    }
    if (vendor_id) {
      const { data: v } = await supabase.from('vendors').select('id').eq('id', vendor_id).eq('user_id', req.userId).maybeSingle();
      if (!v) return badRequest(res, 'vendor_id not found');
    }

    const row = {
      property_id: req.params.propertyId, user_id: req.userId, description: description.trim(),
      amount: amount !== undefined && amount !== null && amount !== '' ? parseFloat(amount) : 0,
      cost_date: cost_date || new Date().toISOString().split('T')[0],
      paid_by, status: 'pending', request_status: status, reported_by: 'owner',
      vendor_name: vendor_name ? vendor_name.trim() : null,
      vendor_phone: vendor_phone ? vendor_phone.trim() : null,
      vendor_id: vendor_id || null,
      appliance_id: appliance_id || null,
      category: category ? category.trim() : null,
      tenant_id: tenant_id || null,
      urgency: urgency || null,
      decided_by: req.userId,
      approved_at: ['approved', 'in_progress', 'resolved'].includes(status) ? new Date().toISOString() : null,
      resolved_at: status === 'resolved' ? new Date().toISOString() : null
    };
    const { data, error } = await supabase.from('maintenance_costs').insert([row]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    unexpectedError('POST /api/properties/:propertyId/maintenance', err, res);
  }
});

app.get('/api/properties/:propertyId/maintenance', verifyToken, requireOwner, async (req, res) => {
  try {
    const { data, error } = await supabase.from('maintenance_costs').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId).order('cost_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    unexpectedError('GET /api/properties/:propertyId/maintenance', err, res);
  }
});

// OWNER: approve/reject/progress/resolve a maintenance request, and/or edit
// its cost/vendor/appliance details. evidence_urls is intentionally NOT in
// this allowlist -- there is no owner-side upload endpoint in this slice, so
// evidence stays immutable through this route (tenant-uploaded only). A
// terminal record (resolved/rejected) is fully locked: no field on it may
// change through this route, not just request_status.
app.patch('/api/properties/:propertyId/maintenance/:maintenanceId', verifyToken, requireOwner, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('maintenance_costs').select('*').eq('id', req.params.maintenanceId).eq('property_id', req.params.propertyId).eq('user_id', req.userId).maybeSingle();
    if (!existing) return notFound(res);
    if (mw.isTerminalRequestStatus(existing.request_status)) {
      return badRequest(res, 'This maintenance request is already finalized and cannot be modified.');
    }

    const { request_status, amount, paid_by, vendor_id, vendor_name, vendor_phone, appliance_id, category, owner_decision_note, urgency } = req.body;
    const allowed = {};

    if (request_status !== undefined) {
      if (!mw.canTransitionRequestStatus(existing.request_status, request_status)) {
        return badRequest(res, `Cannot move a "${existing.request_status}" request to "${request_status}"`);
      }
      allowed.request_status = request_status;
      allowed.decided_by = req.userId;
      if (['approved', 'rejected'].includes(request_status)) allowed.approved_at = new Date().toISOString();
      if (request_status === 'resolved') allowed.resolved_at = new Date().toISOString();
    }
    if (amount !== undefined) {
      if (!mw.isValidOptionalNonNegativeAmount(amount)) return badRequest(res, 'amount must be a non-negative number');
      allowed.amount = parseFloat(amount);
    }
    if (paid_by !== undefined) {
      if (!mw.isValidPaidBy(paid_by)) return badRequest(res, 'paid_by must be owner, tenant, or shared');
      allowed.paid_by = paid_by;
    }
    if (urgency !== undefined) {
      if (!mw.isValidUrgency(urgency)) return badRequest(res, 'urgency must be low, normal, or high');
      allowed.urgency = urgency;
    }
    if (vendor_id !== undefined) {
      if (vendor_id) {
        const { data: v } = await supabase.from('vendors').select('id').eq('id', vendor_id).eq('user_id', req.userId).maybeSingle();
        if (!v) return badRequest(res, 'vendor_id not found');
      }
      allowed.vendor_id = vendor_id || null;
    }
    if (appliance_id !== undefined) {
      if (appliance_id) {
        const { data: a } = await supabase.from('appliances').select('id').eq('id', appliance_id).eq('property_id', req.params.propertyId).eq('user_id', req.userId).maybeSingle();
        if (!a) return badRequest(res, 'appliance_id does not belong to this property');
      }
      allowed.appliance_id = appliance_id || null;
    }
    if (vendor_name !== undefined) allowed.vendor_name = vendor_name ? vendor_name.trim() : null;
    if (vendor_phone !== undefined) allowed.vendor_phone = vendor_phone ? vendor_phone.trim() : null;
    if (category !== undefined) allowed.category = category ? category.trim() : null;
    if (owner_decision_note !== undefined) allowed.owner_decision_note = owner_decision_note ? owner_decision_note.trim() : null;

    // When request_status is changing, condition the write on the exact
    // status just read -- if a concurrent request already transitioned this
    // row, zero rows come back instead of silently applying a transition
    // that was validated against a status that's no longer current.
    let updateQuery = supabase.from('maintenance_costs').update(allowed).eq('id', req.params.maintenanceId);
    if (request_status !== undefined) {
      updateQuery = updateQuery.eq('request_status', existing.request_status);
    }
    const { data, error } = await updateQuery.select();
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(409).json({ error: 'This maintenance request was already updated. Refresh and try again.' });
    }
    res.json(data[0]);
  } catch (err) {
    unexpectedError('PATCH /api/properties/:propertyId/maintenance/:maintenanceId', err, res);
  }
});

// ===== RENT CREDITS / REIMBURSEMENTS (migration 014) =====
// Only a tenant-paid, owner-decided maintenance event can be settled -- this
// route never auto-approves anything; the maintenance record must already
// carry a real amount and paid_by='tenant' before a settlement can exist.

app.post('/api/maintenance/:id/settlement', verifyToken, requireOwner, async (req, res) => {
  try {
    const { data: maintenance } = await supabase.from('maintenance_costs').select('id, property_id, tenant_id, paid_by, amount').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
    if (!maintenance) return notFound(res);
    if (maintenance.paid_by !== 'tenant') {
      return badRequest(res, 'Only a tenant-paid maintenance expense can be settled with a reimbursement or rent credit.');
    }

    const { type, amount, applicable_period, notes } = req.body;
    if (!mw.isValidSettlementType(type)) return badRequest(res, 'type must be rent_credit or reimbursement');
    if (!mw.isValidPositiveAmount(amount)) return badRequest(res, 'amount must be a positive number');

    let normalizedPeriod = null;
    if (type === 'rent_credit') {
      if (!maintenance.tenant_id) {
        return badRequest(res, 'A rent credit requires a maintenance record linked to a tenant.');
      }
      if (!req.body.applicable_period) return badRequest(res, 'applicable_period is required for a rent credit');
      const periodResult = mw.normalizeApplicablePeriod(applicable_period);
      if (periodResult.error) return badRequest(res, periodResult.error);
      normalizedPeriod = periodResult.value;
    }

    const row = {
      property_id: maintenance.property_id, tenant_id: maintenance.tenant_id, user_id: req.userId,
      maintenance_cost_id: maintenance.id, type, amount: parseFloat(amount),
      status: 'pending', applicable_period: normalizedPeriod, notes: notes ? notes.trim() : null
    };
    const { data, error } = await supabase.from('rent_credits').insert([row]).select();
    if (error) {
      // The DB is the final authority on "at most one active settlement per
      // maintenance event" (uq_rent_credits_active_per_maintenance) -- this
      // is the one place a raw Postgres error code maps to a specific,
      // friendly response rather than falling through to the generic 500.
      if (error.code === '23505') {
        return res.status(409).json({ error: 'This maintenance event already has an active settlement. Cancel it first if you need to change the settlement type.' });
      }
      throw error;
    }
    res.status(201).json(data[0]);
  } catch (err) {
    unexpectedError('POST /api/maintenance/:id/settlement', err, res);
  }
});

app.get('/api/properties/:propertyId/rent-credits', verifyToken, requireOwner, async (req, res) => {
  try {
    const { data: property } = await supabase.from('properties').select('id').eq('id', req.params.propertyId).eq('user_id', req.userId).maybeSingle();
    if (!property) return notFound(res);
    const { data, error } = await supabase.from('rent_credits').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    unexpectedError('GET /api/properties/:propertyId/rent-credits', err, res);
  }
});

// OWNER: apply or cancel a pending settlement. Closed transition set --
// pending->applied and pending->cancelled are the only two legal writes
// through this route; applied/cancelled rows are immutable here.
app.patch('/api/rent-credits/:id', verifyToken, requireOwner, async (req, res) => {
  try {
    const { data: credit } = await supabase.from('rent_credits').select('*').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
    if (!credit) return notFound(res);

    const { status } = req.body;
    if (!mw.canTransitionSettlementStatus(credit.status, status)) {
      return badRequest(res, `Cannot move a "${credit.status}" settlement to "${status || 'that state'}"`);
    }

    if (status === 'cancelled') {
      // Conditioned on the 'pending' status just read -- if a concurrent
      // request already moved this row, zero rows come back instead of
      // silently overwriting whatever that other request just did.
      const { data, error } = await supabase.from('rent_credits').update({ status: 'cancelled' }).eq('id', credit.id).eq('status', 'pending').select();
      if (error) throw error;
      if (!data || data.length === 0) {
        return res.status(409).json({ error: 'This settlement was already updated. Refresh and try again.' });
      }
      return res.json(data[0]);
    }

    // status === 'applied'
    const { settlement_method, settlement_reference, applied_payment_id } = req.body;
    if (!mw.isValidSettlementMethod(settlement_method) || !settlement_method) {
      return badRequest(res, 'settlement_method is required to apply a settlement');
    }
    if (!settlement_reference || !String(settlement_reference).trim()) {
      return badRequest(res, 'settlement_reference is required to apply a settlement');
    }

    let paymentId = null;
    if (credit.type === 'rent_credit') {
      if (!applied_payment_id) return badRequest(res, 'applied_payment_id is required to apply a rent credit');
      const { data: payment } = await supabase.from('payments').select('id, property_id, tenant_id, period').eq('id', applied_payment_id).eq('user_id', req.userId).maybeSingle();
      if (!mw.paymentReconciles({ payment, propertyId: credit.property_id, tenantId: credit.tenant_id, applicablePeriod: credit.applicable_period })) {
        return badRequest(res, 'applied_payment_id does not match this credit\'s property, tenant, and period');
      }
      paymentId = payment.id;
    }

    // Same conditional-write guard as the cancel branch above.
    const { data, error } = await supabase.from('rent_credits').update({
      status: 'applied', settlement_method, settlement_reference: String(settlement_reference).trim(),
      settled_by: req.userId, settled_at: new Date().toISOString(),
      applied_payment_id: paymentId
    }).eq('id', credit.id).eq('status', 'pending').select();
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(409).json({ error: 'This settlement was already updated. Refresh and try again.' });
    }
    res.json(data[0]);
  } catch (err) {
    unexpectedError('PATCH /api/rent-credits/:id', err, res);
  }
});

// OWNER: read-only aggregation for the year-end/property maintenance
// summary -- grouped in JS from the same maintenance_costs/rent_credits rows
// already scoped to this property, no new schema.
app.get('/api/properties/:propertyId/maintenance/summary', verifyToken, requireOwner, async (req, res) => {
  try {
    const { data: property } = await supabase.from('properties').select('id').eq('id', req.params.propertyId).eq('user_id', req.userId).maybeSingle();
    if (!property) return notFound(res);
    const [{ data: costs }, { data: credits }] = await Promise.all([
      supabase.from('maintenance_costs').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId),
      supabase.from('rent_credits').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId)
    ]);
    const byYear = {};
    const byCategory = {};
    const byVendor = {};
    let totalSpend = 0, tenantPaid = 0, ownerPaid = 0, openCount = 0;
    for (const c of (costs || [])) {
      const year = (c.cost_date || c.created_at || '').slice(0, 4) || 'unknown';
      byYear[year] = (byYear[year] || 0) + Number(c.amount || 0);
      const cat = c.category || 'uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + Number(c.amount || 0);
      const vendorKey = c.vendor_id || c.vendor_name || 'unspecified';
      byVendor[vendorKey] = (byVendor[vendorKey] || 0) + Number(c.amount || 0);
      totalSpend += Number(c.amount || 0);
      if (c.paid_by === 'tenant') tenantPaid += Number(c.amount || 0);
      if (c.paid_by === 'owner') ownerPaid += Number(c.amount || 0);
      if (!mw.isTerminalRequestStatus(c.request_status)) openCount++;
    }
    const pendingCredits = (credits || []).filter(c => c.status === 'pending');
    res.json({
      totalSpend, tenantPaid, ownerPaid,
      reimbursed: (credits || []).filter(c => c.type === 'reimbursement' && c.status === 'applied').reduce((s, c) => s + Number(c.amount), 0),
      byYear, byCategory, byVendor,
      pendingCreditsTotal: pendingCredits.reduce((s, c) => s + Number(c.amount), 0),
      pendingCreditsCount: pendingCredits.length,
      openIssueCount: openCount
    });
  } catch (err) {
    unexpectedError('GET /api/properties/:propertyId/maintenance/summary', err, res);
  }
});

// ===== NOTIFICATIONS (Phase 1B) =====
// Rows are written exclusively by jobs/runReminders.js (a standalone script,
// not any HTTP route -- there is no "create notification" endpoint here by
// design). Every query below is scoped to (recipient_user_id = req.userId
// AND recipient_role = '<owner|tenant>') -- never accepts a recipient id
// from the client. Default lists/counts exclude dismissed/snoozed/
// invalidated; a snoozed row only becomes visible again once the daily job
// flips it back to unread (see reminders.js) -- no route re-derives that
// decision independently. The selected column list on every read
// deliberately excludes source_type/source_id/dedupe_key/invalidation_
// reason/invalidated_at/recipient_user_id/recipient_role -- internal
// bookkeeping the recipient doesn't need and shouldn't see.
const NOTIFICATION_SAFE_COLUMNS = 'id, property_id, category, title, body, deep_link, status, event_date, scheduled_for, offset_label, created_at, read_at, dismissed_at, snoozed_until';

app.get('/api/notifications', verifyToken, requireOwner, async (req, res) => {
  try {
    const { data, error } = await supabase.from('notifications').select(NOTIFICATION_SAFE_COLUMNS)
      .eq('recipient_user_id', req.userId).eq('recipient_role', 'owner')
      .in('status', ['unread', 'read'])
      .order('scheduled_for', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    unexpectedError('GET /api/notifications', err, res);
  }
});

app.get('/api/notifications/unread-count', verifyToken, requireOwner, async (req, res) => {
  try {
    const { count, error } = await supabase.from('notifications').select('id', { count: 'exact', head: true })
      .eq('recipient_user_id', req.userId).eq('recipient_role', 'owner').eq('status', 'unread');
    if (error) throw error;
    res.json({ unread_count: count || 0 });
  } catch (err) {
    unexpectedError('GET /api/notifications/unread-count', err, res);
  }
});

app.get('/api/tenant/notifications', verifyToken, async (req, res) => {
  try {
    const tenant = await resolveOwnTenant(req);
    if (!tenant) return res.status(403).json({ error: 'No tenancy linked to this login' });
    const { data, error } = await supabase.from('notifications').select(NOTIFICATION_SAFE_COLUMNS)
      .eq('recipient_user_id', req.userId).eq('recipient_role', 'tenant')
      .in('status', ['unread', 'read'])
      .order('scheduled_for', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    unexpectedError('GET /api/tenant/notifications', err, res);
  }
});

app.get('/api/tenant/notifications/unread-count', verifyToken, async (req, res) => {
  try {
    const tenant = await resolveOwnTenant(req);
    if (!tenant) return res.status(403).json({ error: 'No tenancy linked to this login' });
    const { count, error } = await supabase.from('notifications').select('id', { count: 'exact', head: true })
      .eq('recipient_user_id', req.userId).eq('recipient_role', 'tenant').eq('status', 'unread');
    if (error) throw error;
    res.json({ unread_count: count || 0 });
  } catch (err) {
    unexpectedError('GET /api/tenant/notifications/unread-count', err, res);
  }
});

// Shared by both roles -- ownership is enforced by recipient_user_id =
// req.userId alone (a user's own id already belongs to exactly one role's
// rows, so no separate role check is needed here). Closed transition set:
// unread/read -> read|dismissed|snoozed only; dismissed and invalidated are
// terminal; no client request can ever set status to 'invalidated' (it's
// not in the accepted values below at all).
app.patch('/api/notifications/:id', verifyToken, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('notifications').select('*').eq('id', req.params.id).eq('recipient_user_id', req.userId).maybeSingle();
    if (!existing) return notFound(res);

    const { status, snoozed_until } = req.body;
    if (!['read', 'dismissed', 'snoozed'].includes(status)) {
      return badRequest(res, 'status must be read, dismissed, or snoozed');
    }
    if (!['unread', 'read'].includes(existing.status)) {
      return badRequest(res, `Cannot move a "${existing.status}" notification to "${status}"`);
    }

    const allowed = { status };
    if (status === 'read') {
      allowed.read_at = new Date().toISOString();
    } else if (status === 'dismissed') {
      allowed.dismissed_at = new Date().toISOString();
    } else {
      const todayIST = todayISOInTimezone();
      if (!snoozed_until || !/^\d{4}-\d{2}-\d{2}$/.test(snoozed_until) || snoozed_until <= todayIST) {
        return badRequest(res, 'snoozed_until must be a future date (YYYY-MM-DD, Asia/Kolkata)');
      }
      allowed.snoozed_until = snoozed_until;
    }

    const { data, error } = await supabase.from('notifications').update(allowed).eq('id', existing.id).select(NOTIFICATION_SAFE_COLUMNS);
    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    unexpectedError('PATCH /api/notifications/:id', err, res);
  }
});

// ===== TENANT-FACING MAINTENANCE REPORTING =====
// Identity is always resolved server-side via login_user_id -- the same
// pattern as every other /api/tenant/* route in this file. tenant_id,
// property_id, and user_id (the landlord) are never accepted from the
// request body on any of these three routes.

async function resolveOwnTenant(req) {
  const { data: tenant } = await supabase.from('tenants').select('id, property_id, user_id').eq('login_user_id', req.userId).eq('is_active', true).maybeSingle();
  return tenant || null;
}

// Uploads a validated evidence batch, tracking every path it successfully
// writes so a later failure (another file, or the final DB write) can clean
// up everything from this request rather than leaving orphaned objects.
async function uploadEvidenceBatch(files, { propertyId, maintenanceId }) {
  const uploaded = [];
  for (const f of files) {
    const path = mw.buildEvidencePath({ propertyId, maintenanceId, uniqueId: crypto.randomUUID(), filename: f.originalname });
    const { error } = await supabase.storage.from('documents').upload(path, f.buffer, { contentType: f.mimetype });
    if (error) {
      await cleanupEvidence(uploaded);
      throw Object.assign(new Error('Evidence upload failed'), { isUploadFailure: true });
    }
    uploaded.push({ path, mimetype: f.mimetype, original_name: mw.sanitizeFilename(f.originalname), uploaded_at: new Date().toISOString() });
  }
  return uploaded;
}

async function cleanupEvidence(entries) {
  if (!entries || entries.length === 0) return;
  try {
    await supabase.storage.from('documents').remove(entries.map(e => e.path));
  } catch (cleanupErr) {
    // Never surfaced to the client -- the original error is what the caller
    // reports; this is a best-effort background cleanup.
    console.error('[evidence cleanup] failed to remove orphaned objects:', cleanupErr);
  }
}

// Same best-effort-only posture as cleanupEvidence above, for the F1
// single-file upload routes (payment proof, handover item photo): if the
// storage upload succeeds but the subsequent database write fails, this
// removes the just-uploaded object so the request's honest failure never
// leaves an orphaned file with nothing in the DB referencing it. Never
// surfaced to the client -- the original DB error is what gets reported.
async function rollbackUploadedFile(path) {
  try {
    await supabase.storage.from('documents').remove([path]);
  } catch (cleanupErr) {
    console.error('[upload rollback] failed to remove orphaned object:', cleanupErr);
  }
}

// Upload-first: evidence is uploaded to Storage BEFORE the maintenance_costs
// row is inserted, using a maintenanceId generated up front. This guarantees
// a failed upload never leaves a maintenance record behind with missing/
// partial evidence -- there is nothing to compensate/delete, because nothing
// is written to the DB until every file has already succeeded.
app.post('/api/tenant/maintenance', verifyToken, upload.array('files', mw.MAX_EVIDENCE_FILES), handleUploadErrors, async (req, res) => {
  let uploaded = [];
  try {
    const tenant = await resolveOwnTenant(req);
    if (!tenant) return res.status(403).json({ error: 'No tenancy linked to this login' });

    const { description, appliance_id, urgency, requested_amount } = req.body;
    if (!description || !description.trim()) return badRequest(res, 'Description required');
    if (!mw.isValidUrgency(urgency)) return badRequest(res, 'urgency must be low, normal, or high');
    if (!mw.isValidOptionalPositiveAmount(requested_amount)) return badRequest(res, 'requested_amount must be a positive number');
    if (appliance_id) {
      const { data: appl } = await supabase.from('appliances').select('id').eq('id', appliance_id).eq('property_id', tenant.property_id).eq('user_id', tenant.user_id).maybeSingle();
      if (!appl) return badRequest(res, 'appliance_id does not belong to your property');
    }

    const batchCheck = mw.validateEvidenceBatch(req.files);
    if (!batchCheck.valid) return badRequest(res, batchCheck.error);

    const maintenanceId = crypto.randomUUID();

    if (req.files && req.files.length > 0) {
      uploaded = await uploadEvidenceBatch(req.files, { propertyId: tenant.property_id, maintenanceId });
    }

    const row = {
      id: maintenanceId,
      property_id: tenant.property_id, user_id: tenant.user_id, tenant_id: tenant.id,
      description: description.trim(), amount: 0, paid_by: 'tenant', status: 'pending',
      request_status: requested_amount ? 'awaiting_approval' : 'reported',
      reported_by: 'tenant',
      appliance_id: appliance_id || null,
      urgency: urgency || null,
      requested_amount: requested_amount ? parseFloat(requested_amount) : null,
      evidence_urls: uploaded
    };
    const { data: created, error } = await supabase.from('maintenance_costs').insert([row]).select();
    if (error) { await cleanupEvidence(uploaded); throw error; }

    res.status(201).json(created[0]);
  } catch (err) {
    if (err && err.isUploadFailure) return badRequest(res, 'Could not upload one or more evidence files');
    unexpectedError('POST /api/tenant/maintenance', err, res);
  }
});

app.get('/api/tenant/maintenance', verifyToken, async (req, res) => {
  try {
    const tenant = await resolveOwnTenant(req);
    if (!tenant) return res.status(403).json({ error: 'No tenancy linked to this login' });
    const { data, error } = await supabase.from('maintenance_costs').select('*').eq('tenant_id', tenant.id).order('cost_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    unexpectedError('GET /api/tenant/maintenance', err, res);
  }
});

// TENANT: edit description and/or append evidence to their OWN report,
// only while it's still 'reported' or 'awaiting_approval' (once the owner
// has acted on it, it's locked from the tenant's side too -- same
// terminal-lock posture as the owner route, just gated on a different set
// of statuses since the tenant shouldn't edit something already decided).
app.patch('/api/tenant/maintenance/:id', verifyToken, upload.array('files', mw.MAX_EVIDENCE_FILES), handleUploadErrors, async (req, res) => {
  let uploaded = [];
  try {
    const tenant = await resolveOwnTenant(req);
    if (!tenant) return res.status(403).json({ error: 'No tenancy linked to this login' });

    // Ownership lookup happens before any Storage call. Multer has already
    // parsed the multipart body into req.files by this point (that's
    // unavoidable middleware ordering) -- but no supabase.storage upload
    // has been attempted yet, and none will be if this check fails.
    const { data: existing } = await supabase.from('maintenance_costs').select('*').eq('id', req.params.id).eq('tenant_id', tenant.id).maybeSingle();
    if (!existing) return notFound(res);
    if (!['reported', 'awaiting_approval'].includes(existing.request_status)) {
      return badRequest(res, 'This request has already been reviewed and can no longer be edited.');
    }

    const batchCheck = mw.validateEvidenceBatch(req.files);
    if (!batchCheck.valid) return badRequest(res, batchCheck.error);

    const allowed = {};
    if (req.body.description !== undefined) {
      if (!req.body.description.trim()) return badRequest(res, 'Description cannot be empty');
      allowed.description = req.body.description.trim();
    }

    if (req.files && req.files.length > 0) {
      uploaded = await uploadEvidenceBatch(req.files, { propertyId: existing.property_id, maintenanceId: existing.id });
      // Append, never overwrite, existing evidence entries.
      allowed.evidence_urls = [...(existing.evidence_urls || []), ...uploaded];
    }

    if (Object.keys(allowed).length === 0) return badRequest(res, 'Nothing to update');
    const { data, error } = await supabase.from('maintenance_costs').update(allowed).eq('id', existing.id).select();
    if (error) { await cleanupEvidence(uploaded); throw error; }
    res.json(data[0]);
  } catch (err) {
    if (err && err.isUploadFailure) return badRequest(res, 'Could not upload one or more evidence files');
    unexpectedError('PATCH /api/tenant/maintenance/:id', err, res);
  }
});

// ===== PHASE 1: RENT & BILLS (obligations = recurring dues per property) =====

app.post('/api/properties/:propertyId/obligations', verifyToken, async (req, res) => {
  try {
    const { type, label, amount, due_day, paid_by } = req.body;
    if (!label) return res.status(400).json({ error: 'Label required (e.g. Rent, Electricity)' });
    if (paid_by && !['owner', 'tenant'].includes(paid_by)) return res.status(400).json({ error: 'paid_by must be owner or tenant' });
    // Idempotency guard: creating an obligation with the same type+label for
    // a property it's already active on (e.g. re-approving an agreement's
    // rent/maintenance/electricity clauses) returns the existing row instead
    // of a duplicate -- a no-op success, not an error, since re-approving the
    // same fact isn't a mistake the owner needs to be told about.
    const { data: dupe } = await supabase.from('obligations').select('*')
      .eq('property_id', req.params.propertyId).eq('user_id', req.userId).eq('active', true)
      .eq('type', type || 'other').ilike('label', (label || '').trim());
    if (dupe && dupe.length > 0) return res.status(200).json(dupe[0]);
    const day = parseInt(due_day, 10);
    const { data, error } = await supabase.from('obligations').insert([{
      property_id: req.params.propertyId,
      user_id: req.userId,
      type: type || 'other',
      label: label.trim(),
      amount: amount ? parseFloat(amount) : null,
      due_day: (day >= 1 && day <= 31) ? day : 5,
      paid_by: paid_by || 'tenant',
      active: true
    }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/obligations', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('obligations').select('*')
      .eq('property_id', req.params.propertyId).eq('user_id', req.userId).eq('active', true)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/obligations/:id', verifyToken, async (req, res) => {
  try {
    const allowed = {};
    for (const k of ['label', 'amount', 'due_day', 'paid_by', 'type', 'active']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    const { data, error } = await supabase.from('obligations').update(allowed)
      .eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dues for a month: each active obligation with its payment status (paid / pending / due / overdue)
// TODO(Phase 3b): once a scheduled-job mechanism exists (none does today — no
// cron/queue infra in this codebase), wire notifications.rentDueReminderEmail()
// here for 'due'/'overdue' rows. Template already exists in notifications.js.
app.get('/api/properties/:propertyId/dues', verifyToken, async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
    const period = `${month}-01`;
    const [{ data: obligations, error: e1 }, { data: payments, error: e2 }] = await Promise.all([
      supabase.from('obligations').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId).eq('active', true),
      supabase.from('payments').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId).eq('period', period)
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    const today = new Date().toISOString().slice(0, 10);
    const items = (obligations || []).map(o => {
      // Canonical due-date computation (real last-day-of-month clamp) --
      // also used by GET /api/tenant/home below, so both call sites agree.
      const dueDate = dueDateForExplicitMonth(month, o.due_day);
      // Payment-status decision extracted to reminders.computeDueStatus --
      // byte-for-byte the same logic as before, now shared with the reminder
      // job so both draw on one implementation, never two interpretations.
      const { status, payment } = reminders.computeDueStatus({ obligationId: o.id, payments, dueDate, today });
      return { obligation: o, payment, status, due_date: dueDate };
    });
    res.json({ month, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== FINANCIAL COMMAND CENTER (Cash Flow slice) =====

// Settled-only operating cash flow (received/paid/net), a 2-month "upcoming/
// awaiting confirmation" window (reusing reminders.computeDueStatus -- no new
// due-date logic), open maintenance issues, and deposit status read from the
// existing tenant deposit columns (no new table). Property-aware: property_id
// is ownership-checked server-side before any aggregation runs; omitted ->
// portfolio-wide across every property this owner owns.
app.get('/api/cashflow', verifyToken, async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
    const propertyId = req.query.property_id || null;
    if (propertyId) {
      const { data: prop } = await supabase.from('properties').select('id')
        .eq('id', propertyId).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    const [year, monthNum] = month.split('-').map(Number);
    const period = `${month}-01`;
    const monthStart = period;
    const monthEnd = `${month}-${String(daysInMonth(year, monthNum)).padStart(2, '0')}`;
    // monthNum (1-12) passed as JS Date's 0-indexed month arg lands on the
    // 1st of the NEXT month -- also correctly rolls the year at December.
    const nextMonthDate = new Date(Date.UTC(year, monthNum, 1));
    const nextMonth = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const nextPeriod = `${nextMonth}-01`;
    const [nyear, nmonthNum] = nextMonth.split('-').map(Number);
    const nextMonthEnd = `${nextMonth}-${String(daysInMonth(nyear, nmonthNum)).padStart(2, '0')}`;

    const scopeFilter = (q) => propertyId ? q.eq('property_id', propertyId) : q.eq('user_id', req.userId);

    const [{ data: properties }, { data: obligations, error: e1 }, { data: payments, error: e2 }, { data: maintenance, error: e3 }, { data: tenants, error: e4 }] = await Promise.all([
      supabase.from('properties').select('id, property_name').eq('user_id', req.userId).is('deleted_at', null),
      scopeFilter(supabase.from('obligations').select('id, property_id, paid_by, label, type, amount, due_day').eq('user_id', req.userId).eq('active', true)),
      scopeFilter(supabase.from('payments').select('id, property_id, amount, payment_date, period, status, tenant_id, obligation_id').eq('user_id', req.userId)),
      scopeFilter(supabase.from('maintenance_costs').select('id, property_id, amount, cost_date, status, paid_by, description, vendor_name, request_status').eq('user_id', req.userId)),
      scopeFilter(supabase.from('tenants').select('id, property_id, name, deposit_amount, deposit_paid_date, deposit_details, deposit_refunded_amount, deposit_refunded_date').eq('user_id', req.userId).eq('is_active', true))
    ]);
    if (e1) throw e1; if (e2) throw e2; if (e3) throw e3; if (e4) throw e4;

    const propertyName = (id) => (properties || []).find(p => p.id === id)?.property_name || '';
    const obligationsById = new Map((obligations || []).map(o => [o.id, o]));

    // Settled-cash classification (status='paid' only -- pending/
    // pending_confirmation/rejected never counted), parameterized by date
    // range so the identical rule set drives both the current-month view and
    // the year-to-date view below -- no duplicated classification logic
    // between them, and nothing in the frontend re-derives this.
    // classifySettled extracted to cashflow.js (2026-08-28) so the CA
    // export routes below can reuse the identical rule set -- byte-for-byte
    // the same logic, only the closure captures became explicit params.
    const monthResult = cashflow.classifySettled({ rangeStart: monthStart, rangeEnd: monthEnd, payments, maintenance, obligationsById, propertyName });
    const { cashReceived, expensesPaid, netCashFlow, transactions, categoryTotals } = monthResult;

    // Year-to-date: always the real current calendar year through today,
    // independent of whichever month is being browsed (navigating to a past
    // or future month via the Cash Flow page's month picker must not change
    // what "this year so far" means).
    const today = todayISOInTimezone();
    const ytdYear = today.slice(0, 4);
    const ytdStart = `${ytdYear}-01-01`;
    const ytdResult = cashflow.classifySettled({ rangeStart: ytdStart, rangeEnd: today, payments, maintenance, obligationsById, propertyName });

    // Tenant-paid responsibilities (maintenance/electricity/etc. the tenant
    // pays directly, e.g. from an agreement's responsibility clause) are
    // informational only -- reused straight from the obligations already
    // fetched above, never counted in expensesPaid/categoryTotals above
    // unless an actual owner-paid transaction exists for it. Rent is excluded
    // here since a tenant-paid rent obligation is income, not a "responsibility".
    const tenantResponsibilities = (obligations || [])
      .filter(o => o.paid_by === 'tenant' && o.type !== 'rent')
      .map(o => ({ label: o.label, type: o.type, property_name: propertyName(o.property_id) }));

    // ---- Upcoming / awaiting confirmation: this month + next month only, never further ----
    const buildUpcoming = (m, per, start, end) => {
      const monthPayments = (payments || []).filter(p => cashflow.paymentInRange(p, start, end));
      return (obligations || []).map(o => {
        const dueDate = dueDateForExplicitMonth(m, o.due_day);
        const { status, payment } = reminders.computeDueStatus({ obligationId: o.id, payments: monthPayments, dueDate, today });
        return { obligation: o, payment, status, due_date: dueDate, month: m, property_name: propertyName(o.property_id) };
      }).filter(item => item.status !== 'paid'); // already in the settled section above
    };
    const upcoming = [...buildUpcoming(month, period, monthStart, monthEnd), ...buildUpcoming(nextMonth, nextPeriod, nextPeriod, nextMonthEnd)];

    // ---- Open maintenance: unresolved, shown regardless of month -- these
    // aren't due-dated, so they don't belong blended into the month-based
    // upcoming list above. ----
    const openMaintenance = (maintenance || [])
      .filter(m => m.request_status && !['resolved', 'rejected'].includes(m.request_status))
      .map(m => ({ id: m.id, property_id: m.property_id, property_name: propertyName(m.property_id), amount: m.amount, cost_date: m.cost_date, description: m.description, vendor_name: m.vendor_name, request_status: m.request_status }));

    // ---- Deposits held: existing tenants.deposit_* columns only, no ledger table ----
    const deposits = cashflow.computeDeposits({ tenants, propertyName });

    res.json({
      month, nextMonth, propertyId,
      cashReceived, expensesPaid, netCashFlow, categoryTotals,
      transactions: transactions.slice(0, 10),
      ytd: { year: ytdYear, from: ytdStart, through: today, cashReceived: ytdResult.cashReceived, expensesPaid: ytdResult.expensesPaid, netCashFlow: ytdResult.netCashFlow, categoryTotals: ytdResult.categoryTotals },
      tenantResponsibilities,
      upcoming, openMaintenance, deposits
    });
  } catch (err) {
    console.error('[GET /api/cashflow]', err);
    res.status(500).json({ error: 'Unable to load cash flow.' });
  }
});

// ===== CA EXPORT (read-only year-end summary for a chartered accountant) =====
// Deliberately no new login/auth surface -- the owner downloads/prints this
// themselves and hands it to their CA directly, rather than the CA getting
// their own account. Reuses cashflow.js's classification (same rules as the
// Cash Flow page) over a full financial year instead of a single month.

async function buildCaExportData(userId, startYear) {
  const fy = cashflow.fiscalYearRange(startYear);
  const [{ data: properties }, { data: obligations, error: e1 }, { data: payments, error: e2 }, { data: maintenance, error: e3 }, { data: tenants, error: e4 }] = await Promise.all([
    supabase.from('properties').select('id, property_name').eq('user_id', userId).is('deleted_at', null),
    supabase.from('obligations').select('id, property_id, paid_by, label, type, amount, due_day').eq('user_id', userId).eq('active', true),
    supabase.from('payments').select('id, property_id, amount, payment_date, period, status, tenant_id, obligation_id').eq('user_id', userId),
    supabase.from('maintenance_costs').select('id, property_id, amount, cost_date, status, paid_by, description, vendor_name').eq('user_id', userId),
    supabase.from('tenants').select('id, property_id, name, deposit_amount, deposit_paid_date, deposit_details, deposit_refunded_amount, deposit_refunded_date').eq('user_id', userId).eq('is_active', true)
  ]);
  if (e1) throw e1; if (e2) throw e2; if (e3) throw e3; if (e4) throw e4;

  const propertyName = (id) => (properties || []).find(p => p.id === id)?.property_name || '';
  const obligationsById = new Map((obligations || []).map(o => [o.id, o]));

  const result = cashflow.classifySettled({ rangeStart: fy.start, rangeEnd: fy.end, payments, maintenance, obligationsById, propertyName });
  const deposits = cashflow.computeDeposits({ tenants, propertyName });
  const tds = cashflow.tdsFlags({ obligations, propertyName });

  // Per-property subtotals derived from the same transaction list the
  // ledger below shows -- no second classification pass, so the two
  // sections can never disagree with each other.
  const byProperty = new Map();
  for (const t of result.transactions) {
    const key = t.property_name || '(unassigned)';
    if (!byProperty.has(key)) byProperty.set(key, { property_name: key, income: 0, expenses: 0 });
    const row = byProperty.get(key);
    if (t.direction === 'income') row.income += t.amount; else row.expenses += t.amount;
  }
  const propertyBreakdown = [...byProperty.values()].map(r => ({ ...r, net: r.income - r.expenses })).sort((a, b) => b.income - a.income);

  return { fy, ...result, deposits, tds, propertyBreakdown };
}

app.get('/api/reports/ca-export/print', verifyToken, requireOwner, async (req, res) => {
  try {
    const startYear = /^\d{4}$/.test(req.query.year || '') ? Number(req.query.year) : cashflow.currentFiscalYearStart(todayISOInTimezone());
    const [{ data: owner }, data] = await Promise.all([
      supabase.from('users').select('full_name,email').eq('id', req.userId).single(),
      buildCaExportData(req.userId, startYear)
    ]);
    const { fy, cashReceived, expensesPaid, netCashFlow, transactions, propertyBreakdown, deposits, tds } = data;

    const rows = transactions.map(t => `<tr><td>${escapeHtml(t.date)}</td><td>${escapeHtml(t.property_name)}</td><td>${escapeHtml(t.label)}</td><td style="text-align:right;color:${t.direction === 'income' ? '#166534' : '#991b1b'}">${t.direction === 'income' ? '+' : '−'}₹${t.amount.toLocaleString('en-IN')}</td></tr>`).join('');
    const propRows = propertyBreakdown.map(p => `<tr><td>${escapeHtml(p.property_name)}</td><td style="text-align:right">₹${p.income.toLocaleString('en-IN')}</td><td style="text-align:right">₹${p.expenses.toLocaleString('en-IN')}</td><td style="text-align:right;font-weight:600">₹${p.net.toLocaleString('en-IN')}</td></tr>`).join('');
    const depositRows = deposits.map(d => `<tr><td>${escapeHtml(d.tenant_name)}</td><td>${escapeHtml(d.property_name)}</td><td style="text-align:right">₹${d.agreed_amount.toLocaleString('en-IN')}</td><td>${escapeHtml(d.status.replace(/_/g, ' '))}</td></tr>`).join('');
    const tdsNote = tds.length ? `<div class="box" style="border-color:#f59e0b;background:#fffbeb"><b>Note</b><ul>${tds.map(t => `<li>${escapeHtml(t.property_name)}: ₹${t.monthly_rent.toLocaleString('en-IN')}/mo — ${escapeHtml(t.note)}</li>`).join('')}</ul></div>` : '';

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>OMniNivas — CA Export ${fy.label}</title>
<style>
body{font-family:Georgia,serif;max-width:800px;margin:2.5rem auto;color:#1f2937;padding:0 1rem}
h1{color:#1e3a5f;font-size:1.5rem;border-bottom:2px solid #f97316;padding-bottom:.5rem}
h2{color:#1e3a5f;font-size:1.05rem;margin-top:2rem}
.box{border:1px solid #d1d5db;border-radius:8px;padding:1rem 1.25rem;margin-top:.75rem}
table{width:100%;border-collapse:collapse;margin-top:.5rem;font-size:.85rem}
th{text-align:left;border-bottom:1px solid #9ca3af;padding:.4rem}
td{padding:.35rem .4rem;border-bottom:1px solid #e5e7eb}
.summary{display:flex;gap:1.5rem;margin-top:.75rem}
.summary div{flex:1;text-align:center;border:1px solid #d1d5db;border-radius:8px;padding:.75rem}
.summary .n{font-size:1.3rem;font-weight:bold}
.foot{margin-top:2rem;font-size:.78rem;color:#6b7280}
@media print{.noprint{display:none}}
</style></head><body>
<h1>OMniNivas — Financial Summary for Your Chartered Accountant</h1>
<p>Owner: ${escapeHtml(owner ? (owner.full_name || owner.email) : '')} · Financial Year: ${fy.label} (${fy.start} to ${fy.end}) · Generated ${new Date().toLocaleDateString('en-IN')}</p>

<div class="summary">
  <div><div>Rent &amp; income received</div><div class="n" style="color:#166534">₹${cashReceived.toLocaleString('en-IN')}</div></div>
  <div><div>Expenses paid</div><div class="n" style="color:#991b1b">₹${expensesPaid.toLocaleString('en-IN')}</div></div>
  <div><div>Net cash flow</div><div class="n">₹${netCashFlow.toLocaleString('en-IN')}</div></div>
</div>

${tdsNote}

<h2>By property</h2>
<table><tr><th>Property</th><th style="text-align:right">Income</th><th style="text-align:right">Expenses</th><th style="text-align:right">Net</th></tr>${propRows || '<tr><td colspan="4">No properties with recorded transactions this year.</td></tr>'}</table>

<h2>Security deposits held</h2>
<table><tr><th>Tenant</th><th>Property</th><th style="text-align:right">Agreed amount</th><th>Status</th></tr>${depositRows || '<tr><td colspan="4">No deposits on record.</td></tr>'}</table>

<h2>Transaction ledger (${transactions.length})</h2>
<table><tr><th>Date</th><th>Property</th><th>Description</th><th style="text-align:right">Amount</th></tr>${rows || '<tr><td colspan="4">No transactions this year.</td></tr>'}</table>

<p class="foot">Generated by OMniNivas on ${new Date().toLocaleDateString('en-IN')}. This is an arithmetic summary of transactions recorded in OMniNivas — not tax or accounting advice. Verify all figures, including any TDS note above, with your chartered accountant.</p>
<p class="noprint" style="text-align:center;margin-top:1rem"><button onclick="window.print()" style="padding:.6rem 2rem;font-size:1rem;cursor:pointer">Print / Save as PDF</button></p>
</body></html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/ca-export/csv', verifyToken, requireOwner, async (req, res) => {
  try {
    const startYear = /^\d{4}$/.test(req.query.year || '') ? Number(req.query.year) : cashflow.currentFiscalYearStart(todayISOInTimezone());
    const data = await buildCaExportData(req.userId, startYear);
    const { fy, transactions, propertyBreakdown, cashReceived, expensesPaid, netCashFlow } = data;

    // A property/label value starting with =, +, -, @, tab, or CR can be
    // interpreted as a formula by Excel/Sheets when this CSV is opened --
    // classic CSV/formula-injection. Prefixing with a leading single quote
    // forces spreadsheet apps to treat it as literal text; it's invisible
    // in the rendered cell, not a visible artifact in the data.
    const esc = (s) => {
      let v = String(s ?? '');
      if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
      return `"${v.replace(/"/g, '""')}"`;
    };
    const lines = [];
    lines.push(esc(`OMniNivas CA Export — ${fy.label} (${fy.start} to ${fy.end})`));
    lines.push('');
    lines.push(esc('Summary'));
    lines.push(`${esc('Income')},${cashReceived}`);
    lines.push(`${esc('Expenses')},${expensesPaid}`);
    lines.push(`${esc('Net')},${netCashFlow}`);
    lines.push('');
    lines.push(esc('By property'));
    lines.push(['Property', 'Income', 'Expenses', 'Net'].map(esc).join(','));
    for (const p of propertyBreakdown) lines.push([p.property_name, p.income, p.expenses, p.net].map(esc).join(','));
    lines.push('');
    lines.push(esc('Transactions'));
    lines.push(['Date', 'Property', 'Description', 'Direction', 'Amount'].map(esc).join(','));
    for (const t of transactions) lines.push([t.date, t.property_name, t.label, t.direction, t.amount].map(esc).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="omninivas-ca-export-${fy.label.replace(/\s+/g, '-')}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read-only aggregation of everything currently awaiting an explicit owner
// decision. Deliberately NOT a new approval engine: every actual mutation
// still goes through its own existing, already-authorized endpoint (PATCH
// /api/payments/:id, PATCH .../maintenance/:maintenanceId, PATCH+apply
// /api/whatsapp/facts/:id, PATCH /api/tenants/:id). This route only merges
// four already-existing "pending" states into one list for display.
app.get('/api/approvals', verifyToken, async (req, res) => {
  try {
    const propertyId = req.query.property_id || null;
    if (propertyId) {
      const { data: prop } = await supabase.from('properties').select('id')
        .eq('id', propertyId).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    const scopeFilter = (q) => propertyId ? q.eq('property_id', propertyId) : q.eq('user_id', req.userId);

    const [{ data: properties }, { data: tenants, error: e1 }, { data: obligations, error: e2 }, { data: pendingPayments, error: e3 }, { data: pendingMaintenance, error: e4 }, { data: imports, error: e5 }] = await Promise.all([
      supabase.from('properties').select('id, property_name').eq('user_id', req.userId).is('deleted_at', null),
      scopeFilter(supabase.from('tenants').select('id, property_id, name, deposit_amount, deposit_paid_date').eq('user_id', req.userId).eq('is_active', true)),
      scopeFilter(supabase.from('obligations').select('id, label').eq('user_id', req.userId)),
      scopeFilter(supabase.from('payments').select('id, property_id, amount, payment_date, tenant_id, obligation_id').eq('user_id', req.userId).eq('status', 'pending_confirmation')),
      scopeFilter(supabase.from('maintenance_costs').select('id, property_id, amount, description, cost_date, vendor_name, request_status').eq('user_id', req.userId).in('request_status', ['reported', 'awaiting_approval'])),
      supabase.from('whatsapp_imports').select('id, property_id').eq('user_id', req.userId)
    ]);
    if (e1) throw e1; if (e2) throw e2; if (e3) throw e3; if (e4) throw e4; if (e5) throw e5;

    const propertyName = (id) => (properties || []).find(p => p.id === id)?.property_name || '';
    const tenantsById = new Map((tenants || []).map(t => [t.id, t.name]));
    const obligationLabel = (id) => (obligations || []).find(o => o.id === id)?.label || null;

    const relevantImportIds = (imports || []).filter(i => !propertyId || i.property_id === propertyId).map(i => i.id);
    let whatsappFacts = [];
    // import_id -> seq -> raw message ts. One query for every relevant
    // import (relevantImportIds is already owner/property-scoped above),
    // not one query per fact -- avoids an N+1 pattern for what could be a
    // long approval queue.
    let messageTsByKey = {};
    if (relevantImportIds.length > 0) {
      const { data: facts, error: e6 } = await supabase.from('whatsapp_extracted_facts')
        .select('id, import_id, category, fact_type, value, confidence, evidence, status, owner_edited_value, applied_at, message_seq, owner_corrected_category, owner_corrected_fact_type, property_id, participant_role, participant_ref')
        .in('import_id', relevantImportIds)
        .in('category', ['payment', 'deposit', 'maintenance', 'utility_cost']);
      if (e6) throw e6;
      // Not yet reviewed, or reviewed but not yet written into a real record.
      whatsappFacts = (facts || []).filter(f => f.status === 'pending' || (['approved', 'edited'].includes(f.status) && !f.applied_at));

      if (whatsappFacts.length > 0) {
        const { data: msgs, error: e7 } = await supabase.from('whatsapp_messages')
          .select('import_id, seq, ts')
          .in('import_id', relevantImportIds);
        if (e7) throw e7;
        messageTsByKey = Object.fromEntries((msgs || []).map(m => [`${m.import_id}:${m.seq}`, m.ts]));
      }
    }
    const importPropertyById = new Map((imports || []).map(i => [i.id, i.property_id]));

    const items = [
      ...(pendingPayments || []).map(p => ({
        type: 'payment_confirmation', id: p.id, property_name: propertyName(p.property_id),
        tenant_name: p.tenant_id ? (tenantsById.get(p.tenant_id) || null) : null,
        label: obligationLabel(p.obligation_id) || 'Payment', amount: p.amount, date: p.payment_date
      })),
      ...(pendingMaintenance || []).map(m => ({
        type: 'maintenance_approval', id: m.id, property_id: m.property_id, property_name: propertyName(m.property_id),
        vendor_name: m.vendor_name || null, label: m.description, amount: m.amount, date: m.cost_date, request_status: m.request_status
      })),
      ...(tenants || []).filter(t => t.deposit_amount && !t.deposit_paid_date).map(t => ({
        type: 'deposit_confirmation', id: t.id, tenant_id: t.id, tenant_name: t.name,
        property_name: propertyName(t.property_id), amount: t.deposit_amount
      })),
      // Raw fields (value/owner_edited_value/applied_at), not pre-merged --
      // this shape is passed straight into the existing FactCard component
      // (src/index.jsx), which already knows how to render edited/pending
      // state correctly and already owns the Approve/Edit/Reject/Apply
      // actions against their real endpoints. Reusing it here, not
      // reimplementing its logic.
      ...whatsappFacts.map(f => ({
        type: 'whatsapp_fact', id: f.id, property_name: propertyName(f.property_id || importPropertyById.get(f.import_id)),
        category: f.category, fact_type: f.fact_type, value: f.value, owner_edited_value: f.owner_edited_value,
        // Owner-correction fields, passed straight through so FactCard can
        // show both what was originally extracted and what will actually be
        // used on approval (effective_category/effective_fact_type below).
        owner_corrected_category: f.owner_corrected_category, owner_corrected_fact_type: f.owner_corrected_fact_type,
        effective_category: f.owner_corrected_category || f.category, effective_fact_type: f.owner_corrected_fact_type || f.fact_type,
        property_id: f.property_id || null, participant_role: f.participant_role || 'unknown', participant_ref: f.participant_ref || null,
        confidence: f.confidence, evidence: f.evidence, status: f.status, applied_at: f.applied_at || null,
        // null when the source message row can't be found (e.g. deleted) --
        // the card omits the date line entirely rather than showing a gap.
        message_ts: f.message_seq != null ? (messageTsByKey[`${f.import_id}:${f.message_seq}`] || null) : null
      }))
    ];

    res.json({ items });
  } catch (err) {
    console.error('[GET /api/approvals]', err);
    res.status(500).json({ error: 'Unable to load approvals.' });
  }
});

// Upload payment proof (screenshot/PDF): stores file, OCRs amount/date/UTR, creates a pending payment
app.post('/api/properties/:propertyId/obligations/:obligationId/proof', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const validation = uploadValidation.validateUploadedFile(req.file, uploadValidation.DOCUMENT_UPLOAD_RULE);
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : new Date().toISOString().slice(0, 7);
    const { data: obligation, error: oErr } = await supabase.from('obligations').select('*')
      .eq('id', req.params.obligationId).eq('user_id', req.userId).single();
    if (oErr || !obligation) return res.status(404).json({ error: 'Obligation not found' });

    const fileName = `proofs/${req.params.propertyId}/${req.params.obligationId}_${month}_${Date.now()}`;
    const { error: upErr } = await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) throw upErr;

    let extracted = { amount: null, date: null, utr: null };
    try {
      const text = await extractDocumentText(req.file.buffer, req.file.originalname, req.file.mimetype);
      extracted = parsePaymentProof(text);
    } catch (err) {
      console.warn('Proof OCR failed (keeping upload):', err.message);
    }

    const { data, error } = await supabase.from('payments').insert([{
      property_id: req.params.propertyId,
      user_id: req.userId,
      obligation_id: obligation.id,
      tenant_id: req.body.tenant_id || null,
      amount: extracted.amount || obligation.amount || 0,
      payment_date: extracted.date || new Date().toISOString().slice(0, 10),
      period: `${month}-01`,
      status: 'pending',
      proof_url: fileName,
      utr_number: extracted.utr || null
    }]).select();
    if (error) { await rollbackUploadedFile(fileName); throw error; }
    res.status(201).json({ payment: data[0], extracted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirm or reject a payment (owner reviews the proof)
app.patch('/api/payments/:id', verifyToken, async (req, res) => {
  try {
    const allowed = {};
    for (const k of ['status', 'amount', 'payment_date', 'notes']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    const { data: before, error: beforeErr } = await supabase.from('payments').select('status,amount')
      .eq('id', req.params.id).eq('user_id', req.userId).single();
    if (beforeErr || !before) return res.status(404).json({ error: 'Payment not found' });
    const { data, error } = await supabase.from('payments').update(allowed)
      .eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    // Audit trail: log every status/amount edit for deposit/payment dispute evidence.
    // Never blocks the response -- an audit-write failure shouldn't fail the edit itself.
    if (allowed.status !== undefined || allowed.amount !== undefined) {
      // supabase-js query builders are PromiseLike (only .then()), not real
      // Promises -- .catch() doesn't exist on them directly and throws. await
      // inside try/catch consumes the thenable correctly instead.
      try {
        await supabase.from('payment_history').insert([{
          payment_id: req.params.id,
          changed_by: req.userId,
          previous_status: before.status,
          new_status: data[0].status,
          previous_amount: before.amount,
          new_amount: data[0].amount,
          notes: allowed.notes || null
        }]);
      } catch (_) {}
    }
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit trail for a payment's status/amount edits (deposit/payment dispute evidence)
app.get('/api/payments/:id/history', verifyToken, async (req, res) => {
  try {
    const { data: payment } = await supabase.from('payments').select('id')
      .eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const { data, error } = await supabase.from('payment_history').select('*')
      .eq('payment_id', req.params.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Printable rent receipt (HTML)
app.get('/api/payments/:id/receipt', verifyToken, async (req, res) => {
  try {
    const { data: p, error } = await supabase.from('payments').select('*').eq('id', req.params.id).eq('user_id', req.userId).single();
    if (error || !p) return res.status(404).json({ error: 'Payment not found' });
    const [{ data: prop }, { data: owner }, { data: tenant }] = await Promise.all([
      supabase.from('properties').select('*').eq('id', p.property_id).single(),
      supabase.from('users').select('full_name,email').eq('id', p.user_id).single(),
      p.tenant_id ? supabase.from('tenants').select('name').eq('id', p.tenant_id).single() : Promise.resolve({ data: null })
    ]);
    const period = p.period ? new Date(p.period).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : '';
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Rent Receipt</title>
<style>body{font-family:Georgia,serif;max-width:640px;margin:3rem auto;color:#1f2937;padding:0 1rem}
.box{border:2px solid #1e3a5f;border-radius:8px;padding:2rem}h1{color:#1e3a5f;font-size:1.4rem;border-bottom:2px solid #f97316;padding-bottom:.5rem}
table{width:100%;margin-top:1rem;border-collapse:collapse}td{padding:.4rem 0;vertical-align:top}td:first-child{color:#6b7280;width:40%}
.amount{font-size:1.3rem;font-weight:bold;color:#1e3a5f}.foot{margin-top:2rem;font-size:.8rem;color:#6b7280}
@media print{.noprint{display:none}}</style></head><body>
<div class="box"><h1>RENT RECEIPT ${period ? '— ' + period : ''}</h1><table>
<tr><td>Receipt No.</td><td>${p.id.slice(0, 8).toUpperCase()}</td></tr>
<tr><td>Received from</td><td>${escapeHtml(tenant ? tenant.name : '—')}</td></tr>
<tr><td>Amount</td><td class="amount">₹${Number(p.amount).toLocaleString('en-IN')}</td></tr>
<tr><td>Towards</td><td>Rent for ${escapeHtml(prop ? prop.property_name : '')}${period ? ', ' + period : ''}</td></tr>
<tr><td>Property</td><td>${escapeHtml(prop ? [prop.street_address, prop.city, prop.state, prop.pincode].filter(Boolean).join(', ') : '')}</td></tr>
<tr><td>Payment date</td><td>${p.payment_date || ''}</td></tr>
${p.utr_number ? `<tr><td>UTR / Ref</td><td>${escapeHtml(p.utr_number)}</td></tr>` : ''}
<tr><td>Received by (Owner)</td><td>${escapeHtml(owner ? (owner.full_name || owner.email) : '')}</td></tr>
</table><p class="foot">Generated by OMniNivas on ${new Date().toLocaleDateString('en-IN')}. This receipt can be used for HRA claims.</p></div>
<p class="noprint" style="text-align:center;margin-top:1rem"><button onclick="window.print()" style="padding:.6rem 2rem;font-size:1rem;cursor:pointer">Print / Save as PDF</button></p>
</body></html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PHASE 5 SPIKE: LOANS (manual mortgage/EMI tracking) =====
// Deliberately manual-only -- see supabase/migrations/023_loans.sql for why
// a live bank connection is a separate, much larger undertaking (RBI
// Account Aggregator / FIU registration), not something this spike attempts.
// Owner-only: a tenant has no legitimate reason to see their landlord's
// loan terms.

app.post('/api/properties/:propertyId/loans', verifyToken, requireOwner, async (req, res) => {
  try {
    const { lender_name, principal, interest_rate, tenure_months, emi_amount, start_date } = req.body;
    if (!lender_name || !principal || !interest_rate || !tenure_months || !emi_amount || !start_date) {
      return res.status(400).json({ error: 'lender_name, principal, interest_rate, tenure_months, emi_amount, and start_date are all required' });
    }
    const { data: property } = await supabase.from('properties').select('id').eq('id', req.params.propertyId).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
    if (!property) return notFound(res);

    const { data, error } = await supabase.from('loans').insert([{
      property_id: req.params.propertyId, user_id: req.userId,
      lender_name: String(lender_name).trim(), principal: parseFloat(principal),
      interest_rate: parseFloat(interest_rate), tenure_months: parseInt(tenure_months, 10),
      emi_amount: parseFloat(emi_amount), start_date
    }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/loans', verifyToken, requireOwner, async (req, res) => {
  try {
    const { data: property } = await supabase.from('properties').select('id').eq('id', req.params.propertyId).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
    if (!property) return notFound(res);

    const { data, error } = await supabase.from('loans').select('*')
      .eq('property_id', req.params.propertyId).eq('user_id', req.userId).eq('active', true)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const today = todayISOInTimezone();
    const enriched = (data || []).map(loan => {
      const elapsed = loanMath.monthsElapsed(loan.start_date, today);
      const projection = loanMath.projectOutstandingBalance({
        principal: Number(loan.principal), annualRatePercent: Number(loan.interest_rate),
        emiAmount: Number(loan.emi_amount), monthsElapsed: elapsed, tenureMonths: loan.tenure_months
      });
      return { ...loan, months_elapsed: elapsed, ...projection };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/loans/:id', verifyToken, requireOwner, async (req, res) => {
  try {
    const allowed = {};
    for (const k of ['lender_name', 'principal', 'interest_rate', 'tenure_months', 'emi_amount', 'start_date', 'active']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    const { data, error } = await supabase.from('loans').update(allowed)
      .eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    if (!data || data.length === 0) return notFound(res);
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PHASE 2: APPLIANCES (asset registry) =====

const addWarrantyEnd = (a) => {
  if (a.purchase_date && a.warranty_months && !a.warranty_end) {
    const d = new Date(a.purchase_date);
    d.setMonth(d.getMonth() + a.warranty_months);
    a.warranty_end = d.toISOString().slice(0, 10);
  }
  delete a.warranty_months;
  return a;
};

app.post('/api/properties/:propertyId/appliances', verifyToken, async (req, res) => {
  try {
    const b = req.body;
    if (!b.name) return res.status(400).json({ error: 'Name required (e.g. Geyser - bathroom)' });
    const source = b.source === 'agreement' ? 'agreement' : 'manual';
    // Idempotency guard, opt-in only: an agreement can be approved more than
    // once (e.g. a retried/duplicate submit) without creating a second row
    // for the same fixture. Scoped to source='agreement' specifically -- a
    // manual add (AssetsPage) never sends this flag, so two legitimately
    // separate appliances that happen to share a plain name (e.g. two rooms
    // each with a "Fan") are never silently merged.
    if (source === 'agreement') {
      const { data: existing } = await supabase.from('appliances').select('*')
        .eq('property_id', req.params.propertyId).eq('user_id', req.userId)
        .eq('source', 'agreement').ilike('name', b.name.trim());
      if (existing && existing.length > 0) return res.status(200).json(existing[0]);
    }
    const row = addWarrantyEnd({
      property_id: req.params.propertyId, user_id: req.userId,
      name: b.name.trim(), category: b.category || 'other', brand: b.brand || null,
      model: b.model || null, serial_number: b.serial_number || null,
      purchase_date: b.purchase_date || null, warranty_end: b.warranty_end || null,
      warranty_months: b.warranty_months || null, amc_provider: b.amc_provider || null,
      service_phone: b.service_phone || null, bill_url: b.bill_url || null, notes: b.notes || null,
      quantity: (Number.isInteger(b.quantity) || /^\d+$/.test(b.quantity || '')) && parseInt(b.quantity, 10) > 0 ? parseInt(b.quantity, 10) : 1,
      source
    });
    const { data, error } = await supabase.from('appliances').insert([row]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/properties/:propertyId/appliances', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('appliances').select('*')
      .eq('property_id', req.params.propertyId).eq('user_id', req.userId).order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// condition_status changes only ever happen here -- explicitly, by the
// owner -- never automatically from a maintenance-request state change.
app.patch('/api/appliances/:id', verifyToken, requireOwner, async (req, res) => {
  try {
    if (req.body.condition_status !== undefined && !mw.isValidConditionStatus(req.body.condition_status)) {
      return badRequest(res, 'Invalid condition_status');
    }
    const allowed = {};
    for (const k of ['name', 'category', 'brand', 'model', 'serial_number', 'purchase_date', 'warranty_end', 'amc_provider', 'service_phone', 'notes', 'condition_status', 'quantity']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    if (allowed.quantity !== undefined) {
      const q = parseInt(allowed.quantity, 10);
      if (!(q > 0)) return badRequest(res, 'quantity must be a positive integer');
      allowed.quantity = q;
    }
    const { data, error } = await supabase.from('appliances').update(allowed).eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    if (!data || data.length === 0) return notFound(res);
    res.json(data[0]);
  } catch (err) { unexpectedError('PATCH /api/appliances/:id', err, res); }
});

app.delete('/api/appliances/:id', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase.from('appliances').delete().eq('id', req.params.id).eq('user_id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// OCR a purchase bill -> suggested appliance fields (owner reviews before saving)
app.post('/api/properties/:propertyId/appliances/scan', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const validation = uploadValidation.validateUploadedFile(req.file, uploadValidation.DOCUMENT_UPLOAD_RULE);
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    const fileName = `appliances/${req.params.propertyId}/bill_${Date.now()}`;
    // Previously .catch(() => {}) swallowed a storage failure and still
    // returned bill_url as if the file existed. A failed save is now an
    // honest failure -- the OCR-suggestion feature isn't worth returning
    // fields that reference a bill image that was never actually stored.
    const { error: upErr } = await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) throw upErr;
    let extracted = {};
    try {
      const text = await extractDocumentText(req.file.buffer, req.file.originalname, req.file.mimetype);
      extracted = parseApplianceFromText(text);
    } catch (err) { console.warn('Appliance OCR failed:', err.message); }
    res.json({ extracted, bill_url: fileName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== PHASE 4: APPLIANCE/FIXTURE HANDOVER (move-in + move-out) =====

// Best-effort email fan-out for handover events — never throws into the route;
// callers fire-and-forget these (`.catch(() => {})`) so a mail failure can never
// fail the request that triggered it.
async function notifyHandoverCreated(handover) {
  const [{ data: prop }, { data: tenant }, { data: owner }] = await Promise.all([
    supabase.from('properties').select('property_name').eq('id', handover.property_id).single(),
    supabase.from('tenants').select('name, personal_email, login_user_id').eq('id', handover.tenant_id).single(),
    supabase.from('users').select('email, email_enabled').eq('id', handover.user_id).single()
  ]);
  if (!prop || !tenant) return;
  const body = notifications.handoverCreatedEmail({ tenantName: tenant.name, propertyName: prop.property_name });
  if (tenant.personal_email && await notifications.getTenantEmailPreference(tenant)) {
    await notifications.sendEmail({ to: tenant.personal_email, ...body });
  }
  if (owner && owner.email && owner.email_enabled !== false) {
    await notifications.sendEmail({ to: owner.email, ...body });
  }
}

async function notifyHandoverCompleted(handover) {
  const [{ data: prop }, { data: tenant }, { data: owner }] = await Promise.all([
    supabase.from('properties').select('property_name').eq('id', handover.property_id).single(),
    supabase.from('tenants').select('name, personal_email, login_user_id').eq('id', handover.tenant_id).single(),
    supabase.from('users').select('email, email_enabled').eq('id', handover.user_id).single()
  ]);
  if (!prop || !tenant) return;
  const tenantOk = tenant.personal_email && await notifications.getTenantEmailPreference(tenant);
  if (handover.type === 'move_in') {
    const body = notifications.handoverCompletedEmail({ tenantName: tenant.name, propertyName: prop.property_name });
    if (tenantOk) await notifications.sendEmail({ to: tenant.personal_email, ...body });
  } else if (handover.type === 'move_out') {
    const body = notifications.moveOutCompletedEmail({ tenantName: tenant.name, propertyName: prop.property_name });
    if (tenantOk) await notifications.sendEmail({ to: tenant.personal_email, ...body });
    if (owner && owner.email && owner.email_enabled !== false) await notifications.sendEmail({ to: owner.email, ...body });
  }
}

app.post('/api/properties/:propertyId/handover', verifyToken, async (req, res) => {
  try {
    const b = req.body;
    if (!b.tenant_id) return res.status(400).json({ error: 'tenant_id required' });
    if (!['move_in', 'move_out'].includes(b.type)) return res.status(400).json({ error: "type must be 'move_in' or 'move_out'" });
    const { data: prop, error: propErr } = await supabase.from('properties').select('id')
      .eq('id', req.params.propertyId).eq('user_id', req.userId).single();
    if (propErr || !prop) return res.status(403).json({ error: 'Property not found or not yours' });
    const row = {
      property_id: req.params.propertyId, tenant_id: b.tenant_id, user_id: req.userId,
      type: b.type, conducted_date: b.conducted_date || null, notes: b.notes || null
    };
    const { data, error } = await supabase.from('handovers').insert([row]).select();
    if (error) throw error;
    const created = data[0];
    if (created.type === 'move_in') notifyHandoverCreated(created).catch(() => {});
    res.status(201).json(created);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/properties/:propertyId/handover', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('handovers').select('*, handover_items(*)')
      .eq('property_id', req.params.propertyId).eq('user_id', req.userId).order('created_at', { ascending: false });
    if (error) throw error;
    const handovers = data || [];
    for (const h of handovers) {
      for (const item of (h.handover_items || [])) {
        if (item.photo_url) {
          const { data: signed } = await supabase.storage.from('documents').createSignedUrl(item.photo_url, 3600);
          item.photo_signed_url = signed?.signedUrl || null;
        }
      }
    }
    res.json(handovers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/handover/:id/items', verifyToken, upload.single('photo'), async (req, res) => {
  try {
    const { data: handover, error: hErr } = await supabase.from('handovers').select('id, property_id')
      .eq('id', req.params.id).eq('user_id', req.userId).single();
    if (hErr || !handover) return res.status(404).json({ error: 'Handover not found' });
    const b = req.body;
    if (!b.item_name) return res.status(400).json({ error: 'item_name required' });
    let photo_url = null;
    if (req.file) {
      const validation = uploadValidation.validateUploadedFile(req.file, uploadValidation.PHOTO_UPLOAD_RULE);
      if (!validation.valid) return res.status(400).json({ error: validation.error });
      photo_url = `handover/${handover.property_id}/${handover.id}/${Date.now()}`;
      // Previously .catch(() => {}) swallowed a storage failure and still
      // created the handover_items row with a photo_url pointing at nothing
      // -- exactly the false-success record this slice exists to prevent.
      const { error: upErr } = await supabase.storage.from('documents').upload(photo_url, req.file.buffer, { contentType: req.file.mimetype });
      if (upErr) throw upErr;
    }
    const row = {
      handover_id: handover.id, appliance_id: b.appliance_id || null,
      item_name: b.item_name.trim(), condition: b.condition || 'good',
      photo_url, notes: b.notes || null
    };
    const { data, error } = await supabase.from('handover_items').insert([row]).select();
    if (error) { if (photo_url) await rollbackUploadedFile(photo_url); throw error; }
    const item = data[0];
    if (item.photo_url) {
      const { data: signed } = await supabase.storage.from('documents').createSignedUrl(item.photo_url, 3600);
      item.photo_signed_url = signed?.signedUrl || null;
    }
    res.status(201).json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Smart checklist prefill: bulk-add items in one call (move-in from the
// property's appliance registry, move-out from the move-in record) so the
// owner reviews/adjusts condition per row instead of retyping every item name.
// Text-only, no photos -- photos stay on the existing single-item endpoint.
app.post('/api/handover/:id/items/bulk', verifyToken, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
    const { data: handover } = await supabase.from('handovers').select('id').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const rows = items.filter(i => i.item_name).map(i => ({
      handover_id: req.params.id, appliance_id: i.appliance_id || null,
      item_name: String(i.item_name).trim(), condition: i.condition || 'good', notes: i.notes || null
    }));
    if (rows.length === 0) return res.status(400).json({ error: 'No valid items' });
    const { data, error } = await supabase.from('handover_items').insert(rows).select();
    if (error) throw error;
    res.status(201).json({ success: true, count: data.length, items: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/handover/:id', verifyToken, async (req, res) => {
  try {
    const allowed = {};
    for (const k of ['status', 'notes', 'conducted_date']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    const { data, error } = await supabase.from('handovers').update(allowed).eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    const updated = data[0];
    if (allowed.status === 'completed' && updated.status === 'completed') notifyHandoverCompleted(updated).catch(() => {});
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Owner edits one handover item's deduction (pre-filled from AI accept, manually
// typed, or left blank to ignore AI entirely). handover_items has no user_id of
// its own, so ownership is checked via the !inner-joined parent handover's
// user_id -- PostgREST filters the top-level rows down to only those whose
// embedded handovers row matches.
app.patch('/api/handover-items/:id', verifyToken, async (req, res) => {
  try {
    const { deduction_amount, deduction_reason } = req.body;
    const { data: existing } = await supabase.from('handover_items').select('id, handovers!inner(user_id)')
      .eq('id', req.params.id).eq('handovers.user_id', req.userId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Item not found' });
    const allowed = {};
    if (deduction_amount !== undefined) allowed.deduction_amount = deduction_amount === null || deduction_amount === '' ? null : parseFloat(deduction_amount);
    if (deduction_reason !== undefined) allowed.deduction_reason = deduction_reason || null;
    const { data, error } = await supabase.from('handover_items').update(allowed).eq('id', req.params.id).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Owner-triggered (no cron infra in this codebase): compares this move_out
// handover's items against the same tenant's most recent move_in handover and
// stores the raw AI output on the handover row. Raw ai_summary_json is never
// returned to tenants (see GET /api/tenant/home) -- only owner-confirmed
// per-item deduction_amount/reason ever reaches them.
app.post('/api/handover/:id/ai-review', verifyToken, async (req, res) => {
  try {
    const { data: moveOut } = await supabase.from('handovers').select('id,property_id,tenant_id,type,handover_items(item_name,condition,notes)')
      .eq('id', req.params.id).eq('user_id', req.userId).eq('type', 'move_out').single();
    if (!moveOut) return res.status(404).json({ error: 'Move-out handover not found' });
    const { data: moveIns } = await supabase.from('handovers').select('handover_items(item_name,condition,notes)')
      .eq('property_id', moveOut.property_id).eq('tenant_id', moveOut.tenant_id).eq('user_id', req.userId).eq('type', 'move_in')
      .order('created_at', { ascending: false }).limit(1);
    const moveInItems = moveIns?.[0]?.handover_items || [];
    const result = await compareMoveInOut(moveInItems, moveOut.handover_items || []);
    if (result.skipped) return res.json({ skipped: true, summary: null });
    await supabase.from('handovers').update({ ai_summary_json: result.summary, ai_run_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ skipped: false, summary: result.summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== PHASE 2: VENDORS (reusable contact book across properties) =====

app.post('/api/vendors', verifyToken, async (req, res) => {
  try {
    const { name, trade, phone, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const { data, error } = await supabase.from('vendors').insert([{ user_id: req.userId, name: name.trim(), trade: trade || 'other', phone: phone || null, notes: notes || null }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vendors', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('vendors').select('*').eq('user_id', req.userId).order('trade', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/vendors/:id', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase.from('vendors').delete().eq('id', req.params.id).eq('user_id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// OWNER: approve/revoke a vendor. approved_at is server-stamped, never
// accepted from the request -- true when approved flips to true, cleared
// when it flips back to false.
app.patch('/api/vendors/:id', verifyToken, requireOwner, async (req, res) => {
  try {
    const allowed = {};
    for (const k of ['name', 'trade', 'phone', 'notes']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    if (req.body.approved !== undefined) {
      allowed.approved = !!req.body.approved;
      allowed.approved_at = allowed.approved ? new Date().toISOString() : null;
    }
    const { data, error } = await supabase.from('vendors').update(allowed).eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    if (!data || data.length === 0) return notFound(res);
    res.json(data[0]);
  } catch (err) { unexpectedError('PATCH /api/vendors/:id', err, res); }
});

// ===== PHASE 2: TENANT SELF-SERVICE LINK (tenant fills their own details) =====

app.post('/api/tenants/:tenantId/invite', verifyToken, async (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    const { data, error } = await supabase.from('tenants').update({ share_token: token }).eq('id', req.params.tenantId).eq('user_id', req.userId).select();
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ share_token: token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUBLIC (no auth): tenant opens their invite link
app.get('/api/invite/:token', async (req, res) => {
  try {
    const { data, error } = await supabase.from('tenants').select('id,name,personal_phone,personal_email,emergency_contact_name,emergency_contact_phone,emergency_contact_relationship,permanent_address,vehicle_number,alternate_phone').eq('share_token', req.params.token).single();
    if (error || !data) return res.status(404).json({ error: 'Invalid or expired link' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUBLIC (no auth): tenant submits their own details
app.post('/api/invite/:token', async (req, res) => {
  try {
    const { data: tenant, error: e0 } = await supabase.from('tenants').select('id').eq('share_token', req.params.token).single();
    if (e0 || !tenant) return res.status(404).json({ error: 'Invalid or expired link' });
    const allowed = {};
    for (const k of ['personal_phone', 'personal_email', 'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship', 'permanent_address', 'vehicle_number', 'alternate_phone']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    const { error } = await supabase.from('tenants').update(allowed).eq('id', tenant.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUBLIC: tenant sets a password on their invite link -> creates their login account
app.post('/api/invite/:token/register', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const { data: tenant, error: e0 } = await supabase.from('tenants').select('id,name,personal_email,personal_phone,login_user_id').eq('share_token', req.params.token).single();
    if (e0 || !tenant) return res.status(404).json({ error: 'Invalid or expired link' });
    const email = (tenant.personal_email && tenant.personal_email.trim()) || `tenant+${tenant.id.slice(0, 8)}@omninivas.app`;
    const password_hash = await bcrypt.hash(password, 10);
    let loginId = tenant.login_user_id;
    if (loginId) {
      await supabase.from('users').update({ password_hash }).eq('id', loginId);
    } else {
      const { data: existing } = await supabase.from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
      if (existing) return res.status(409).json({ error: 'An account with this email already exists. Ask your landlord to use a different email.' });
      const { data: u, error: e1 } = await supabase.from('users').insert([{ email: email.toLowerCase(), full_name: tenant.name, role: 'tenant', password_hash, whatsapp_webhook_token: crypto.randomBytes(16).toString('hex') }]).select();
      if (e1) throw e1;
      loginId = u[0].id;
      await supabase.from('tenants').update({ login_user_id: loginId }).eq('id', tenant.id);
    }
    const token = jwt.sign({ sub: loginId, email: email.toLowerCase(), role: 'tenant' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, role: 'tenant', email: email.toLowerCase() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// TENANT PORTAL: everything a logged-in tenant sees about their own tenancy
app.get('/api/tenant/home', verifyToken, async (req, res) => {
  try {
    const { data: tenant, error } = await supabase.from('tenants').select('*').eq('login_user_id', req.userId).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!tenant) return res.status(404).json({ error: 'No tenancy linked to this login' });
    const { data: property } = await supabase.from('properties').select('property_name,street_address,city,state,pincode,flat_number,society_name,society_contact_name,society_contact_phone,agreement_summary,agreement_start_date,agreement_months,deposit_total,deposit_source,deposit_confirmed_at').eq('id', tenant.property_id).single();
    const month = new Date().toISOString().slice(0, 7);
    const period = `${month}-01`;
    const [{ data: obligations }, { data: monthPayments }, { data: history }, { data: appliances }, { data: vendors }, { data: moveIn }, { data: moveOut }] = await Promise.all([
      supabase.from('obligations').select('*').eq('property_id', tenant.property_id).eq('active', true).eq('paid_by', 'tenant'),
      supabase.from('payments').select('*').eq('property_id', tenant.property_id).eq('period', period),
      supabase.from('payments').select('id,amount,payment_date,status,period,obligation_id').eq('property_id', tenant.property_id).order('payment_date', { ascending: false }).limit(24),
      // Read-only tenant view: appliances/vendors are owner-scoped (user_id), not
      // tenant-scoped, so filter by tenant.user_id (the landlord) -- safe because
      // tenant.user_id/property_id both came from the tenant row already matched
      // to this login above, not from client input.
      supabase.from('appliances').select('name,category,brand,model,amc_provider,service_phone').eq('property_id', tenant.property_id).eq('user_id', tenant.user_id).order('name', { ascending: true }),
      supabase.from('vendors').select('name,trade,phone').eq('user_id', tenant.user_id).order('trade', { ascending: true }),
      supabase.from('handovers').select('*, handover_items(item_name,condition)').eq('property_id', tenant.property_id).eq('user_id', tenant.user_id).eq('type', 'move_in').order('created_at', { ascending: false }).limit(1),
      // Only this tenant's own COMPLETED move-out -- deductions are only "owner-
      // confirmed" once finalized, and only deduction_amount/reason are exposed
      // here, never ai_summary_json (that stays owner-only, see the handover route).
      supabase.from('handovers').select('ai_run_at, handover_items(item_name,condition,deduction_amount,deduction_reason)').eq('property_id', tenant.property_id).eq('user_id', tenant.user_id).eq('tenant_id', tenant.id).eq('type', 'move_out').eq('status', 'completed').order('created_at', { ascending: false }).limit(1)
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const dues = (obligations || []).map(o => {
      // Now uses the same canonical due-date computation as /dues above
      // (real last-day-of-month clamp) -- this call site previously
      // hardcoded 28, which was silently wrong for due_day 29-31 in any
      // month longer than February. The `|| 5` defensive default for a
      // null due_day is preserved unchanged.
      const dueDate = dueDateForExplicitMonth(month, o.due_day || 5);
      const { status, payment } = reminders.computeDueStatus({ obligationId: o.id, payments: monthPayments, dueDate, today });
      return { obligation: o, payment, status, due_date: dueDate };
    });
    // Tenant Command Center: lease-end reminder, mirroring the owner dashboard's
    // renewals calc -- reuses the property row already fetched above, no new query.
    let leaseEnd = null;
    if (property?.agreement_start_date) {
      const end = new Date(property.agreement_start_date);
      end.setMonth(end.getMonth() + (property.agreement_months || 11));
      leaseEnd = { date: end.toISOString().slice(0, 10), days_left: Math.ceil((end - new Date()) / 86400000) };
    }
    res.json({
      tenant: {
        name: tenant.name, personal_phone: tenant.personal_phone, personal_email: tenant.personal_email,
        alternate_phone: tenant.alternate_phone, vehicle_number: tenant.vehicle_number,
        emergency_contact_name: tenant.emergency_contact_name, emergency_contact_phone: tenant.emergency_contact_phone,
        emergency_contact_relationship: tenant.emergency_contact_relationship, permanent_address: tenant.permanent_address,
        date_of_move_in: tenant.date_of_move_in, deposit_amount: tenant.deposit_amount
      },
      property, month, dues, history: history || [], leaseEnd,
      appliances: appliances || [], vendors: vendors || [],
      moveInItems: moveIn?.[0]?.handover_items || [],
      moveOutSummary: moveOut?.[0] ? {
        items: (moveOut[0].handover_items || []).map(it => ({ item_name: it.item_name, condition: it.condition, deduction_amount: it.deduction_amount, deduction_reason: it.deduction_reason })),
        totalDeduction: (moveOut[0].handover_items || []).reduce((s, it) => s + (Number(it.deduction_amount) || 0), 0),
        aiAssisted: !!moveOut[0].ai_run_at
      } : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// TENANT: update their own contact/emergency-contact details (self-service,
// mirrors what the invite-link flow collects). Only the logged-in tenant's own
// row, matched via login_user_id -- same isolation pattern as GET /api/tenant/home.
app.patch('/api/tenant/me', verifyToken, async (req, res) => {
  try {
    const { data: tenant } = await supabase.from('tenants').select('id').eq('login_user_id', req.userId).eq('is_active', true).maybeSingle();
    if (!tenant) return res.status(404).json({ error: 'No tenancy linked to this login' });
    const allowed = {};
    for (const k of ['personal_phone', 'alternate_phone', 'vehicle_number', 'emergency_contact_name', 'emergency_contact_phone', 'permanent_address']) {
      if (req.body[k] !== undefined) allowed[k] = (req.body[k] || '').toString().trim();
    }
    const phoneOk = (v) => !v || /^[0-9+()\-\s]{7,15}$/.test(v);
    if (!phoneOk(allowed.personal_phone)) return res.status(400).json({ error: 'Phone number looks invalid' });
    if (!phoneOk(allowed.alternate_phone)) return res.status(400).json({ error: 'Alternate phone looks invalid' });
    if (!phoneOk(allowed.emergency_contact_phone)) return res.status(400).json({ error: 'Emergency contact phone looks invalid' });
    allowed.last_updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('tenants').update(allowed).eq('id', tenant.id).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// TENANT: upload a payment proof for one of their own bills
app.post('/api/tenant/obligations/:obligationId/proof', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const validation = uploadValidation.validateUploadedFile(req.file, uploadValidation.DOCUMENT_UPLOAD_RULE);
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    const { data: tenant } = await supabase.from('tenants').select('id,property_id,user_id').eq('login_user_id', req.userId).maybeSingle();
    if (!tenant) return res.status(403).json({ error: 'No tenancy linked to this login' });
    const { data: obligation } = await supabase.from('obligations').select('*').eq('id', req.params.obligationId).eq('property_id', tenant.property_id).single();
    if (!obligation) return res.status(404).json({ error: 'Bill not found' });
    const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : new Date().toISOString().slice(0, 7);
    const fileName = `proofs/${tenant.property_id}/${obligation.id}_${month}_${Date.now()}`;
    // Previously .catch(() => {}) swallowed a storage failure and still
    // inserted a payments row with proof_url pointing at nothing -- the same
    // false-success bug fixed on the owner-side sibling route above.
    const { error: upErr } = await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) throw upErr;
    let extracted = { amount: null, date: null, utr: null };
    try { extracted = parsePaymentProof(await extractDocumentText(req.file.buffer, req.file.originalname, req.file.mimetype)); } catch (e) {}
    const { data, error } = await supabase.from('payments').insert([{
      property_id: tenant.property_id, user_id: tenant.user_id, tenant_id: tenant.id,
      obligation_id: obligation.id, period: `${month}-01`,
      amount: extracted.amount || obligation.amount || 0,
      payment_date: extracted.date || new Date().toISOString().slice(0, 10),
      status: 'pending', proof_url: fileName, utr_number: extracted.utr || null
    }]).select();
    if (error) { await rollbackUploadedFile(fileName); throw error; }
    res.status(201).json({ payment: data[0], extracted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// OWNER: update tenant details (deposit, screening, move-out, etc.)
app.patch('/api/tenants/:id', verifyToken, requireOwner, async (req, res) => {
  try {
    const allowed = {};
    for (const k of ['name', 'personal_email', 'personal_phone', 'age', 'gender', 'profession', 'employer', 'permanent_address', 'deposit_amount', 'deposit_paid_date', 'deposit_details', 'deposit_refunded_amount', 'deposit_refunded_date', 'police_verification_status', 'date_of_move_in', 'expected_date_of_move_out', 'actual_date_of_move_out', 'is_active', 'document_log', 'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    // Narrow sanity check on the two deposit currency fields only -- this
    // route was previously a completely unvalidated passthrough for them
    // (name/email/etc. above are unaffected). Blank/null still clears the
    // field as before; only an implausible non-blank value is rejected. The
    // 500 floor matches parsers.js's own rent_amount lower bound -- a raw
    // "4" (a "Deposit: 4 months" basis clause misread as a rupee figure,
    // the real failure mode this guards against) is nowhere near a real
    // Indian security deposit, and this route is a real WhatsApp apply-form
    // destination (ApplyDepositEvent).
    for (const k of ['deposit_amount', 'deposit_refunded_amount']) {
      if (allowed[k] === undefined || allowed[k] === null || allowed[k] === '') continue;
      const v = parseFloat(allowed[k]);
      if (!(v >= 500) || v > 100000000) return res.status(400).json({ error: `${k} must be a positive, plausible amount` });
    }
    const { data, error } = await supabase.from('tenants').update(allowed).eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// OWNER: co-occupants (other people living with a tenant)
app.post('/api/tenants/:tenantId/occupants', verifyToken, requireOwner, async (req, res) => {
  try {
    const { name, relationship, age, phone, id_type, id_number } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const { data, error } = await supabase.from('co_occupants').insert([{ tenant_id: req.params.tenantId, user_id: req.userId, name: name.trim(), relationship: relationship || null, age: age ? parseInt(age, 10) : null, phone: phone || null, id_type: id_type || null, id_number: id_number || null }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tenants/:tenantId/occupants', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('co_occupants').select('*').eq('tenant_id', req.params.tenantId).eq('user_id', req.userId).order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/occupants/:id', verifyToken, requireOwner, async (req, res) => {
  try {
    const { error } = await supabase.from('co_occupants').delete().eq('id', req.params.id).eq('user_id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const period = `${month}-01`;
    const today = new Date().toISOString().slice(0, 10);
    const [{ data: props }, { data: tenants }, { data: payments }, { data: maintenance }, { data: obligations }, { data: monthPayments }] = await Promise.all([
      supabase.from('properties').select('id,property_name').eq('user_id', req.userId).is('deleted_at', null),
      supabase.from('tenants').select('id,name,property_id,date_of_move_in,expected_date_of_move_out,actual_date_of_move_out,police_verification_status').eq('user_id', req.userId).eq('is_active', true),
      supabase.from('payments').select('amount').eq('user_id', req.userId).eq('status', 'paid'),
      supabase.from('maintenance_costs').select('amount').eq('user_id', req.userId).eq('status', 'pending'),
      supabase.from('obligations').select('*').eq('user_id', req.userId).eq('active', true),
      supabase.from('payments').select('obligation_id,status').eq('user_id', req.userId).eq('period', period)
    ]);
    const totalRentPaid = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
    const pendingMaintenance = maintenance?.reduce((sum, m) => sum + (m.amount || 0), 0) || 0;
    let duesPaid = 0, duesPending = 0, duesOverdue = 0;
    for (const o of (obligations || [])) {
      const pay = (monthPayments || []).find(p => p.obligation_id === o.id && p.status !== 'rejected');
      if (pay && pay.status === 'paid') duesPaid++;
      else if (pay) duesPending++;
      else {
        const dueDate = `${month}-${String(Math.min(o.due_day || 5, 28)).padStart(2, '0')}`;
        if (dueDate < today) duesOverdue++; else duesPending++;
      }
    }
    // Reminders: agreement renewals (within 60 days) and warranties expiring (within 30 days)
    const [{ data: fullProps }, { data: appliances }] = await Promise.all([
      supabase.from('properties').select('id,property_name,agreement_start_date,agreement_months').eq('user_id', req.userId).is('deleted_at', null),
      supabase.from('appliances').select('name,warranty_end,property_id').eq('user_id', req.userId).not('warranty_end', 'is', null)
    ]);
    const now = new Date();
    const daysUntil = (d) => Math.ceil((new Date(d) - now) / 86400000);
    const renewals = [];
    for (const p of (fullProps || [])) {
      if (!p.agreement_start_date) continue;
      const end = new Date(p.agreement_start_date);
      end.setMonth(end.getMonth() + (p.agreement_months || 11));
      const days = daysUntil(end.toISOString().slice(0, 10));
      if (days <= 60) renewals.push({ property: p.property_name, property_id: p.id, expires_on: end.toISOString().slice(0, 10), days_left: days });
    }
    const warranties = (appliances || [])
      .map(a => ({ name: a.name, warranty_end: a.warranty_end, property_id: a.property_id, days_left: daysUntil(a.warranty_end) }))
      .filter(a => a.days_left <= 30);

    // Owner Command Center "Now" panel: upcoming move-in/move-out within 14 days,
    // reusing the tenants row already fetched above (no extra query).
    const movements = [];
    for (const t of (tenants || [])) {
      if (t.date_of_move_in) {
        const days = daysUntil(t.date_of_move_in);
        if (days >= 0 && days <= 14) movements.push({ type: 'move-in', tenant: t.name, property_id: t.property_id, date: t.date_of_move_in, days_left: days });
      }
      if (t.expected_date_of_move_out && !t.actual_date_of_move_out) {
        const days = daysUntil(t.expected_date_of_move_out);
        if (days <= 14) movements.push({ type: 'move-out', tenant: t.name, property_id: t.property_id, date: t.expected_date_of_move_out, days_left: days });
      }
    }

    // Police verification pending -- Karnataka-mandatory for the Bengaluru
    // first wave (competitor gap #1, 2026-08-28 research). Flagged once a
    // tenant has been moved in for 7+ days and still isn't marked 'done';
    // the field itself has existed since before this feature (tenants.
    // police_verification_status), this is the first time it's ever
    // surfaced as an actionable "Now" item rather than just an edit-form
    // dropdown nobody is prompted to look at.
    const policeVerificationPending = (tenants || [])
      .filter(t => t.police_verification_status !== 'done' && t.date_of_move_in)
      .map(t => ({ tenant: t.name, property_id: t.property_id, days_since_move_in: -daysUntil(t.date_of_move_in) }))
      .filter(t => t.days_since_move_in >= 7);

    // Portfolio Overview occupancy: a property counts as occupied when it has
    // at least one active tenant. Reuses the `tenants` rows already fetched
    // above (active-only) -- no extra query, dedup via Set since one property
    // can have multiple active tenants.
    const occupiedProperties = new Set((tenants || []).map(t => t.property_id)).size;

    res.json({
      totalProperties: props?.length || 0,
      totalTenants: tenants?.length || 0,
      totalRentPaid,
      occupiedProperties,
      pendingMaintenanceCosts: pendingMaintenance,
      duesThisMonth: { month, total: (obligations || []).length, paid: duesPaid, pending: duesPending, overdue: duesOverdue },
      renewals: renewals.sort((a, b) => a.days_left - b.days_left),
      warrantyAlerts: warranties.sort((a, b) => a.days_left - b.days_left),
      movements: movements.sort((a, b) => a.days_left - b.days_left),
      policeVerificationPending: policeVerificationPending.sort((a, b) => b.days_since_move_in - a.days_since_move_in)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== WHATSAPP IMPORT v1: upload + parse + AI-assisted review, no auto-linking =====

const { parseWhatsAppExport } = require('./whatsapp');
const AdmZip = require('adm-zip');

// Real WhatsApp exports are often a .zip (iOS "with media" and some Android
// share-sheet paths always zip; media-only text export sometimes doesn't).
// Finds the chat transcript inside and returns its text -- any media entries
// inside the zip are read but never stored (out of scope, same as v1: text
// review only, no photo/video handling).
function extractChatTextFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory && /\.txt$/i.test(e.entryName));
  if (entries.length === 0) return null;
  // Prefer an entry that looks like the actual chat transcript (iOS: _chat.txt,
  // Android: "WhatsApp Chat with X.txt") over any other stray .txt in the zip.
  const chatEntry = entries.find(e => /chat/i.test(e.entryName)) || entries[0];
  return chatEntry.getData().toString('utf8');
}
const { extractWhatsAppFacts, WHATSAPP_CATEGORIES, WHATSAPP_FACT_TYPES } = require('./llm');
const {
  PARTICIPANT_ROLES, withEffectiveFields, applyDepositFirstSafetyNet, applyRepairOffsetSafetyNet, applyDepositBasisSafetyNet
} = require('./whatsappFactResolution');

// Defense-in-depth alongside the extraction prompt's own instruction: mask any
// 10+ digit run (Aadhaar/PAN-length numbers) before a fact ever reaches the DB,
// in case the model doesn't follow the prompt's redaction rule.
const redactLongDigitRuns = (s) => (s || '').replace(/\d{10,}/g, (m) => `${m.slice(0, 2)}${'*'.repeat(m.length - 2)}`);

// Identifies a message by its own content rather than by import-local seq
// (which resets to 0 per import) -- sender+body is stable and byte-identical
// across overlapping re-exports of the same conversation, unlike the AI's
// worded-differently-each-call "value" text, which is too unreliable to
// dedup facts against directly.
const messageSignature = (sender, body) => `${(sender || '').trim().toLowerCase()}::${(body || '').trim().toLowerCase()}`;

// Owner uploads a WhatsApp .txt export. Parses synchronously (no queue/cron infra
// in this codebase) into whatsapp_messages, then runs AI extraction into
// whatsapp_extracted_facts. An AI failure/absence only downgrades status to
// extraction_unavailable -- the parsed timeline is still saved and browsable.
app.post('/api/whatsapp/import', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const isZip = /\.zip$/i.test(req.file.originalname || '') || req.file.mimetype === 'application/zip';
    let text;
    if (isZip) {
      try {
        text = extractChatTextFromZip(req.file.buffer);
      } catch (err) {
        return res.status(400).json({ error: 'Could not open this zip file.' });
      }
      if (!text) return res.status(400).json({ error: "This zip doesn't contain a WhatsApp chat text file." });
    } else {
      text = req.file.buffer.toString('utf8');
    }
    if (!text || text.trim().length < 10) return res.status(400).json({ error: 'File looks empty' });

    const propertyId = req.body.property_id || null;
    if (propertyId) {
      const { data: prop } = await supabase.from('properties').select('id').eq('id', propertyId).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }

    const { data: importRow, error: importErr } = await supabase.from('whatsapp_imports').insert([{
      user_id: req.userId, property_id: propertyId, file_name: req.file.originalname, status: 'uploaded'
    }]).select().single();
    if (importErr) throw importErr;

    let messages;
    try {
      messages = parseWhatsAppExport(text);
    } catch (err) {
      await supabase.from('whatsapp_imports').update({ status: 'failed', error: 'Could not parse this file' }).eq('id', importRow.id);
      return res.status(400).json({ error: 'Could not parse this file. Make sure it is a WhatsApp .txt chat export.' });
    }
    if (messages.length === 0) {
      await supabase.from('whatsapp_imports').update({ status: 'failed', error: 'No messages found' }).eq('id', importRow.id);
      return res.status(400).json({ error: "We couldn't find any WhatsApp messages in this file." });
    }

    const rows = messages.map(m => ({ import_id: importRow.id, seq: m.seq, ts: m.ts, sender: m.sender, body: m.body, is_system: m.is_system }));
    await supabase.from('whatsapp_messages').insert(rows);
    await supabase.from('whatsapp_imports').update({ status: 'parsed', message_count: messages.length }).eq('id', importRow.id);

    const nonSystem = messages.filter(m => !m.is_system);
    const extraction = await extractWhatsAppFacts(nonSystem);
    let finalStatus = 'extraction_unavailable';
    let duplicateCount = 0;
    if (!extraction.skipped) {
      let candidateFacts = extraction.facts.map(f => {
        const row = {
          import_id: importRow.id, category: f.category, fact_type: f.fact_type || null,
          value: redactLongDigitRuns(String(f.value)), confidence: typeof f.confidence === 'number' ? f.confidence : null,
          evidence: redactLongDigitRuns(f.evidence || ''), message_seq: typeof f.message_seq === 'number' ? f.message_seq : null,
          // Property-context inheritance: when the owner picked a property
          // before/at import time, every fact from this import starts
          // already linked to it -- never starts unlinked just because no
          // per-fact choice has been made yet. Still fully overridable
          // afterward via PATCH /api/whatsapp/facts/:id (property_id).
          property_id: propertyId
        };
        // Deterministic safety net (server.js, not AI): never changes
        // category/fact_type above, only pre-fills owner_corrected_* (and,
        // for a months-basis deposit clause, basis_value/basis_unit) on the
        // same insert when applicable -- see applyDepositFirstSafetyNet/
        // applyRepairOffsetSafetyNet/applyDepositBasisSafetyNet for why.
        // Basis runs last so month-basis phrasing always wins over the
        // generic deposit-first default.
        return applyDepositBasisSafetyNet(applyRepairOffsetSafetyNet(applyDepositFirstSafetyNet(row)));
      });

      // Merge into the same property's history instead of creating duplicate
      // parallel facts: when this import is attached to a property, skip any
      // new fact whose SOURCE MESSAGE (by content, not import-local seq) was
      // already extracted from in an earlier import for that same property --
      // common when an owner re-exports an overlapping/extended chat. Dedup by
      // source message rather than by the fact's own wording because the AI
      // doesn't reproduce identical "value" text for the same fact across
      // separate calls, so comparing fact values directly misses most real
      // duplicates. Raw messages are never deduped or dropped -- only this
      // derived-facts layer is.
      if (propertyId) {
        const { data: priorImports } = await supabase.from('whatsapp_imports').select('id').eq('property_id', propertyId).eq('user_id', req.userId).neq('id', importRow.id);
        const priorImportIds = (priorImports || []).map(i => i.id);
        if (priorImportIds.length > 0) {
          const [{ data: priorFacts }, { data: priorMessages }] = await Promise.all([
            supabase.from('whatsapp_extracted_facts').select('import_id, message_seq').in('import_id', priorImportIds).not('message_seq', 'is', null).neq('status', 'rejected'),
            supabase.from('whatsapp_messages').select('import_id, seq, sender, body').in('import_id', priorImportIds)
          ]);
          const priorMsgByKey = new Map((priorMessages || []).map(m => [`${m.import_id}::${m.seq}`, m]));
          const alreadyExtractedFrom = new Set();
          for (const f of priorFacts || []) {
            const msg = priorMsgByKey.get(`${f.import_id}::${f.message_seq}`);
            if (msg) alreadyExtractedFrom.add(messageSignature(msg.sender, msg.body));
          }
          const currentMsgBySeq = new Map(nonSystem.map(m => [m.seq, m]));
          const before = candidateFacts.length;
          candidateFacts = candidateFacts.filter(f => {
            const srcMsg = currentMsgBySeq.get(f.message_seq);
            // No resolvable source message -- keep it rather than risk
            // dropping a legitimate fact on an unrelated technicality.
            if (!srcMsg) return true;
            return !alreadyExtractedFrom.has(messageSignature(srcMsg.sender, srcMsg.body));
          });
          duplicateCount = before - candidateFacts.length;
        }
      }

      if (candidateFacts.length > 0) {
        await supabase.from('whatsapp_extracted_facts').insert(candidateFacts);
      }
      finalStatus = 'extracted';
    }
    const { data: updated } = await supabase.from('whatsapp_imports').update({ status: finalStatus }).eq('id', importRow.id).select().single();
    res.status(201).json({
      import: updated, message_count: messages.length,
      fact_count: extraction.skipped ? 0 : extraction.facts.length - duplicateCount,
      duplicate_fact_count: duplicateCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/imports', verifyToken, async (req, res) => {
  try {
    let q = supabase.from('whatsapp_imports').select('*').eq('user_id', req.userId).order('created_at', { ascending: false });
    if (req.query.property_id) q = q.eq('property_id', req.query.property_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/whatsapp/imports/:id', verifyToken, async (req, res) => {
  try {
    const { data: importRow } = await supabase.from('whatsapp_imports').select('*').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
    if (!importRow) return res.status(404).json({ error: 'Import not found' });
    const [{ data: messages }, { data: facts }, { data: owner }] = await Promise.all([
      supabase.from('whatsapp_messages').select('*').eq('import_id', req.params.id).order('seq', { ascending: true }),
      supabase.from('whatsapp_extracted_facts').select('*').eq('import_id', req.params.id).order('created_at', { ascending: true }),
      // The logged-in owner's own name -- this app has no multi-owner concept,
      // so "the property's known owner" is always just the account itself.
      // Used by the frontend to suggest (never auto-apply) participant_role
      // 'owner' for a person-category fact whose text matches this name.
      supabase.from('users').select('full_name').eq('id', req.userId).maybeSingle()
    ]);
    res.json({ import: importRow, messages: messages || [], facts: facts || [], owner_name: owner?.full_name || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Attach/detach an import to a property after the fact (e.g. create the property
// from the review, then link the import to it).
app.patch('/api/whatsapp/imports/:id', verifyToken, async (req, res) => {
  try {
    const { property_id } = req.body;
    if (property_id) {
      const { data: prop } = await supabase.from('properties').select('id').eq('id', property_id).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    const { data, error } = await supabase.from('whatsapp_imports').update({ property_id: property_id || null }).eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Import not found' });
    // Backfill inheritance: a fact that has never had its own property_id set
    // (still null -- distinct from one an owner deliberately corrected) picks
    // up this import's property the moment it's attached, same as facts
    // extracted after a property was already chosen at upload time. Only
    // still-null facts are touched -- an owner's own per-fact correction
    // (including an explicit unlink) is never overwritten.
    if (property_id) {
      await supabase.from('whatsapp_extracted_facts').update({ property_id }).eq('import_id', req.params.id).is('property_id', null);
    }
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Owner review action on one extracted fact. This ONLY changes the fact's own
// status/value -- it never writes to properties/tenants/obligations. Applying an
// approved fact into core records is intentionally deferred to a later phase.
app.patch('/api/whatsapp/facts/:id', verifyToken, async (req, res) => {
  try {
    const { status, owner_edited_value, owner_corrected_category, owner_corrected_fact_type, property_id, participant_role } = req.body;
    if (status && !['pending', 'approved', 'edited', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    // Bounded lists only -- never arbitrary free text. null is allowed for
    // owner_corrected_category/fact_type to explicitly clear a prior
    // correction back to "use the original extraction".
    if (owner_corrected_category !== undefined && owner_corrected_category !== null && !WHATSAPP_CATEGORIES.includes(owner_corrected_category)) {
      return res.status(400).json({ error: 'owner_corrected_category must be one of ' + WHATSAPP_CATEGORIES.join(', ') });
    }
    if (owner_corrected_fact_type !== undefined && owner_corrected_fact_type !== null && !WHATSAPP_FACT_TYPES.includes(owner_corrected_fact_type)) {
      return res.status(400).json({ error: 'owner_corrected_fact_type must be one of ' + WHATSAPP_FACT_TYPES.join(', ') });
    }
    if (participant_role !== undefined && !PARTICIPANT_ROLES.includes(participant_role)) {
      return res.status(400).json({ error: 'participant_role must be one of ' + PARTICIPANT_ROLES.join(', ') });
    }
    const { data: existing } = await supabase.from('whatsapp_extracted_facts').select('id, applied_at, whatsapp_imports!inner(user_id)')
      .eq('id', req.params.id).eq('whatsapp_imports.user_id', req.userId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Fact not found' });

    // Corrections are for pending/unapplied facts only -- once a fact has
    // actually been applied into a real record, changing what it "would
    // have meant" retroactively has no safe, audited path in this slice.
    // status/owner_edited_value are unaffected (unchanged pre-existing
    // behavior); only the four new correction fields are gated here.
    const correctingFields = [owner_corrected_category, owner_corrected_fact_type, property_id, participant_role].some(v => v !== undefined);
    if (existing.applied_at && correctingFields) {
      return res.status(400).json({ error: 'This fact has already been applied -- corrections are only allowed before applying.' });
    }

    if (property_id !== undefined && property_id !== null) {
      const { data: prop } = await supabase.from('properties').select('id').eq('id', property_id).eq('user_id', req.userId).is('deleted_at', null).maybeSingle();
      if (!prop) return res.status(400).json({ error: 'property_id must be one of your own properties' });
    }

    const allowed = {};
    if (status !== undefined) allowed.status = status;
    if (owner_edited_value !== undefined) allowed.owner_edited_value = owner_edited_value;
    if (owner_corrected_category !== undefined) allowed.owner_corrected_category = owner_corrected_category;
    if (owner_corrected_fact_type !== undefined) allowed.owner_corrected_fact_type = owner_corrected_fact_type;
    if (property_id !== undefined) allowed.property_id = property_id;
    if (participant_role !== undefined) allowed.participant_role = participant_role;
    const { data, error } = await supabase.from('whatsapp_extracted_facts').update(allowed).eq('id', req.params.id).select();
    if (error) throw error;
    // effective_category/effective_fact_type make "what will actually be
    // used on approval" unambiguous for the frontend, without it needing to
    // reimplement the fallback-to-original logic itself.
    res.json(withEffectiveFields(data[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// WhatsApp v2: everything the frontend needs to render a fact's apply/diff
// panel -- the property it could apply to (with current field values), that
// property's active tenants (for person-link / date targets), and its active
// obligations (for a payment target). Read-only; no writes happen here.
app.get('/api/whatsapp/facts/:id/apply-context', verifyToken, async (req, res) => {
  try {
    const { data: fact } = await supabase.from('whatsapp_extracted_facts').select('*, whatsapp_imports!inner(user_id, property_id)')
      .eq('id', req.params.id).eq('whatsapp_imports.user_id', req.userId).maybeSingle();
    if (!fact) return res.status(404).json({ error: 'Fact not found' });
    // Effective property: fact-level override when present, else the
    // import-level fallback (unchanged behavior for every fact that has
    // never had a per-fact property set). Ownership is re-checked below via
    // the same .eq('user_id', req.userId) regardless of which one it came
    // from, so a corrected property can never leak another owner's data.
    const propertyId = fact.property_id || fact.whatsapp_imports.property_id;
    // The fact's own original source-message timestamp (never the import/
    // row-insert time) -- resolved via message_seq, same join the Approvals
    // list already does. null when message_seq doesn't resolve to a stored
    // message; the frontend renders "Message date unavailable" for that
    // case rather than silently showing nothing or substituting import time.
    let messageTs = null;
    if (fact.message_seq != null) {
      const { data: msg } = await supabase.from('whatsapp_messages').select('ts').eq('import_id', fact.import_id).eq('seq', fact.message_seq).maybeSingle();
      messageTs = msg?.ts || null;
    }
    let property = null, tenants = [], obligations = [];
    if (propertyId) {
      const [{ data: p }, { data: t }, { data: o }] = await Promise.all([
        supabase.from('properties').select('*').eq('id', propertyId).eq('user_id', req.userId).is('deleted_at', null).maybeSingle(),
        // '*' rather than an explicit column list: requesting document_log by
        // name here errors the ENTIRE query (PostgREST rejects unknown
        // columns) until migration 013 is applied, and the destructuring
        // below doesn't check .error, so that failure was silently emptying
        // the tenants list for every fact type, not just document_reference.
        // '*' returns whatever columns currently exist either way, and picks
        // up document_log automatically the moment the migration lands.
        supabase.from('tenants').select('*').eq('property_id', propertyId).eq('user_id', req.userId).eq('is_active', true),
        supabase.from('obligations').select('id,label,type,amount,paid_by').eq('property_id', propertyId).eq('user_id', req.userId).eq('active', true)
      ]);
      property = p; tenants = t || []; obligations = o || [];
    }
    delete fact.whatsapp_imports;
    res.json({ fact: withEffectiveFields(fact), property, tenants, obligations, message_ts: messageTs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// WhatsApp v2: marks a fact as applied AFTER the frontend has already written
// the value via the normal existing endpoint (PATCH tenants/properties/
// properties/:id/deposit/obligations, or POST tenants/maintenance/vendors) --
// this route performs NO writes to any other table, it is bookkeeping only.
// Only approved/edited facts are eligible, enforced here too (not just hidden
// in the UI), and a fact can only be applied once.
app.patch('/api/whatsapp/facts/:id/apply', verifyToken, async (req, res) => {
  try {
    const { applied_to, applied_payload } = req.body;
    if (!applied_to) return res.status(400).json({ error: 'applied_to is required' });
    const { data: fact } = await supabase.from('whatsapp_extracted_facts').select('id, status, applied_at, whatsapp_imports!inner(user_id)')
      .eq('id', req.params.id).eq('whatsapp_imports.user_id', req.userId).maybeSingle();
    if (!fact) return res.status(404).json({ error: 'Fact not found' });
    if (!['approved', 'edited'].includes(fact.status)) return res.status(400).json({ error: 'Only approved or edited facts can be applied' });
    if (fact.applied_at) return res.status(400).json({ error: 'This fact has already been applied' });
    const { data, error } = await supabase.from('whatsapp_extracted_facts').update({
      applied_at: new Date().toISOString(), applied_to, applied_payload: applied_payload || null, applied_by: req.userId
    }).eq('id', req.params.id).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

const PORT = process.env.PORT || 3000;
// Guarded so `require('./server')` from a test file (module.exports below)
// never binds a real port or double-starts the server -- only `node
// server.js` directly (the normal run path, unchanged) triggers listen().
if (require.main === module) {
  app.listen(PORT, () => { console.log(`✅ OMniNivas Backend running on port ${PORT}`); });
}

module.exports = app;
