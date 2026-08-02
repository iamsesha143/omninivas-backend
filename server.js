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

app.use(express.json({ limit: '50mb' }));
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

// Works for both owner and tenant logins — both are rows in `users`, distinguished by `role`.
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('id, email, full_name, role, email_enabled').eq('id', req.userId).single();
    if (error || !data) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/auth/me/preferences', verifyToken, async (req, res) => {
  try {
    const allowed = {};
    if (req.body.email_enabled !== undefined) allowed.email_enabled = req.body.email_enabled;
    const { data, error } = await supabase.from('users').update(allowed).eq('id', req.userId).select('id, email, full_name, role, email_enabled');
    if (error) throw error;
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/properties', verifyToken, async (req, res) => {
  try {
    const { property_name, city, state, street_address, pincode, property_type, agreement_summary, deposit_suggested_total, agreement_start_date, agreement_months } = req.body;

    if (!property_name || !city || !state || !pincode) {
      return res.status(400).json({ error: 'Property name, city, state, and pincode required' });
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
    const allowed = {};
    for (const k of ['property_name', 'street_address', 'city', 'state', 'pincode', 'flat_number', 'society_name', 'property_type', 'agreement_start_date', 'agreement_months']) {
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
    const { deposit_total, accept_suggestion } = req.body;
    const { data: prop } = await supabase.from('properties').select('id,deposit_suggested_total').eq('id', req.params.id).eq('user_id', req.userId).single();
    if (!prop) return res.status(404).json({ error: 'Property not found' });
    let total, source;
    if (accept_suggestion) {
      if (!prop.deposit_suggested_total) return res.status(400).json({ error: 'No AI-suggested deposit to accept for this property' });
      total = prop.deposit_suggested_total; source = 'agreement_ai';
    } else {
      total = parseFloat(deposit_total);
      if (!total || total <= 0) return res.status(400).json({ error: 'A positive deposit_total is required' });
      source = 'manual';
    }
    const { data: updated, error } = await supabase.from('properties')
      .update({ deposit_total: total, deposit_source: source, deposit_confirmed_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    const { data: tenants } = await supabase.from('tenants').select('id').eq('property_id', req.params.id).eq('is_active', true);
    const tenantCount = tenants?.length || 0;
    const perTenant = tenantCount > 0 ? Math.round((total / tenantCount) * 100) / 100 : total;
    if (tenantCount > 0) {
      await supabase.from('tenants').update({ deposit_amount: perTenant }).eq('property_id', req.params.id).eq('is_active', true);
    }
    res.json({ property: updated, per_tenant: perTenant, tenant_count: tenantCount });
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

const { parsePropertyFromText, parseTenantsFromText, parsePaymentProof, parseApplianceFromText } = require('./parsers');
const { summarizeAgreement, extractDeposit, compareMoveInOut } = require('./llm');

app.post('/api/extract/property', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const text = await extractDocumentText(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!text || text.trim().length < 50) return res.status(400).json({ error: 'Could not extract text from document', textLength: text.length });
    const propertyData = parsePropertyFromText(text);
    const { summary } = await summarizeAgreement(text);
    const deposit = await extractDeposit(text);
    res.json({
      success: true, extractedData: propertyData, agreementSummary: summary,
      // skipped=true (missing key, short/unparsable text, or a failed call) simply
      // means no suggestion -- the frontend falls back to manual-only deposit entry.
      depositSuggestion: deposit.skipped ? null : { total: deposit.total, tenantCount: deposit.tenantCount }
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

app.post('/api/properties/:propertyId/tenants', verifyToken, async (req, res) => {
  try {
    const { name, personal_email, personal_phone, date_of_move_in, aadhar_card } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
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
    const tenantsToInsert = tenants.map(t => ({
      property_id: req.params.propertyId,
      user_id: req.userId,
      name: (t.name || '').trim(),
      personal_email: t.personal_email ? t.personal_email.trim().toLowerCase() : '',
      personal_phone: (t.personal_phone || '').trim(),
      aadhar_card: t.aadhar_card || null,
      date_of_move_in: t.date_of_move_in || new Date().toISOString().split('T')[0],
      occupancy_type: 'single',
      is_active: true
    })).filter(t => t.name);
    if (tenantsToInsert.length === 0) return res.status(400).json({ error: 'No valid tenants: each tenant needs at least a name' });
    const { data, error } = await supabase.from('tenants').insert(tenantsToInsert).select();
    if (error) throw error;
    res.status(201).json({ success: true, count: data.length, tenants: data });
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
    // Duplicate guard: same filename + same byte size already present for this
    // property. Cheap and safe -- a real content hash would be more precise but
    // this catches the actual "uploaded it twice" case without extra deps.
    const { data: existing } = await supabase.storage.from('documents').list(`properties/${req.params.propertyId}`, { limit: 100 });
    const dupe = (existing || []).find(f => {
      const m = f.name.match(/^deed_\d+_(.+)$/);
      const title = m ? m[1] : null;
      return title && title.toLowerCase() === (req.file.originalname || '').toLowerCase() && f.metadata?.size === req.file.size;
    });
    if (dupe) return res.status(409).json({ error: 'This document appears to already be uploaded for this property.' });
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

app.get('/api/properties/:propertyId/payments', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('payments').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId).order('payment_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties/:propertyId/maintenance', verifyToken, async (req, res) => {
  try {
    const { description, amount, cost_date, paid_by, status } = req.body;
    if (!description || !amount) return res.status(400).json({ error: 'Description and amount required' });
    if (!['tenant', 'owner'].includes(paid_by)) return res.status(400).json({ error: 'paid_by must be tenant or owner' });
    const { data, error } = await supabase.from('maintenance_costs').insert([{ property_id: req.params.propertyId, user_id: req.userId, description: description.trim(), amount: parseFloat(amount), cost_date: cost_date || new Date().toISOString().split('T')[0], paid_by: paid_by, status: status || 'pending' }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/maintenance', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('maintenance_costs').select('*').eq('property_id', req.params.propertyId).eq('user_id', req.userId).order('cost_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/properties/:propertyId/maintenance/:maintenanceId', verifyToken, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase.from('maintenance_costs').update({ status }).eq('id', req.params.maintenanceId).eq('user_id', req.userId).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PHASE 1: RENT & BILLS (obligations = recurring dues per property) =====

app.post('/api/properties/:propertyId/obligations', verifyToken, async (req, res) => {
  try {
    const { type, label, amount, due_day, paid_by } = req.body;
    if (!label) return res.status(400).json({ error: 'Label required (e.g. Rent, Electricity)' });
    if (paid_by && !['owner', 'tenant'].includes(paid_by)) return res.status(400).json({ error: 'paid_by must be owner or tenant' });
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
      const payment = (payments || []).find(p => p.obligation_id === o.id && p.status !== 'rejected') || null;
      const lastDay = new Date(parseInt(month.slice(0, 4)), parseInt(month.slice(5, 7)), 0).getDate();
      const dueDate = `${month}-${String(Math.min(o.due_day, lastDay)).padStart(2, '0')}`;
      let status = 'due';
      if (payment && payment.status === 'paid') status = 'paid';
      else if (payment) status = 'pending_confirmation';
      else if (dueDate < today) status = 'overdue';
      return { obligation: o, payment, status, due_date: dueDate };
    });
    res.json({ month, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload payment proof (screenshot/PDF): stores file, OCRs amount/date/UTR, creates a pending payment
app.post('/api/properties/:propertyId/obligations/:obligationId/proof', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
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
    if (error) throw error;
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
<tr><td>Received from</td><td>${tenant ? tenant.name : '—'}</td></tr>
<tr><td>Amount</td><td class="amount">₹${Number(p.amount).toLocaleString('en-IN')}</td></tr>
<tr><td>Towards</td><td>Rent for ${prop ? prop.property_name : ''}${period ? ', ' + period : ''}</td></tr>
<tr><td>Property</td><td>${prop ? [prop.street_address, prop.city, prop.state, prop.pincode].filter(Boolean).join(', ') : ''}</td></tr>
<tr><td>Payment date</td><td>${p.payment_date || ''}</td></tr>
${p.utr_number ? `<tr><td>UTR / Ref</td><td>${p.utr_number}</td></tr>` : ''}
<tr><td>Received by (Owner)</td><td>${owner ? (owner.full_name || owner.email) : ''}</td></tr>
</table><p class="foot">Generated by OMniNivas on ${new Date().toLocaleDateString('en-IN')}. This receipt can be used for HRA claims.</p></div>
<p class="noprint" style="text-align:center;margin-top:1rem"><button onclick="window.print()" style="padding:.6rem 2rem;font-size:1rem;cursor:pointer">Print / Save as PDF</button></p>
</body></html>`);
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
    const row = addWarrantyEnd({
      property_id: req.params.propertyId, user_id: req.userId,
      name: b.name.trim(), category: b.category || 'other', brand: b.brand || null,
      model: b.model || null, serial_number: b.serial_number || null,
      purchase_date: b.purchase_date || null, warranty_end: b.warranty_end || null,
      warranty_months: b.warranty_months || null, amc_provider: b.amc_provider || null,
      service_phone: b.service_phone || null, bill_url: b.bill_url || null, notes: b.notes || null
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

app.patch('/api/appliances/:id', verifyToken, async (req, res) => {
  try {
    const allowed = {};
    for (const k of ['name', 'category', 'brand', 'model', 'serial_number', 'purchase_date', 'warranty_end', 'amc_provider', 'service_phone', 'notes']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    const { data, error } = await supabase.from('appliances').update(allowed).eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const fileName = `appliances/${req.params.propertyId}/bill_${Date.now()}`;
    await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: req.file.mimetype }).catch(() => {});
    let extracted = {};
    try {
      const text = await extractDocumentText(req.file.buffer, req.file.originalname, req.file.mimetype);
      extracted = parseApplianceFromText(text);
    } catch (err) { console.warn('Appliance OCR failed:', err.message); }
    res.json({ extracted, bill_url: fileName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== PHASE 4: APPLIANCE/FIXTURE HANDOVER (move-in + move-out) =====

const notifications = require('./notifications');

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
      photo_url = `handover/${handover.property_id}/${handover.id}/${Date.now()}`;
      await supabase.storage.from('documents').upload(photo_url, req.file.buffer, { contentType: req.file.mimetype }).catch(() => {});
    }
    const row = {
      handover_id: handover.id, appliance_id: b.appliance_id || null,
      item_name: b.item_name.trim(), condition: b.condition || 'good',
      photo_url, notes: b.notes || null
    };
    const { data, error } = await supabase.from('handover_items').insert([row]).select();
    if (error) throw error;
    const item = data[0];
    if (item.photo_url) {
      const { data: signed } = await supabase.storage.from('documents').createSignedUrl(item.photo_url, 3600);
      item.photo_signed_url = signed?.signedUrl || null;
    }
    res.status(201).json(item);
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
      const payment = (monthPayments || []).find(p => p.obligation_id === o.id && p.status !== 'rejected') || null;
      const dueDate = `${month}-${String(Math.min(o.due_day || 5, 28)).padStart(2, '0')}`;
      let status = 'due';
      if (payment && payment.status === 'paid') status = 'paid';
      else if (payment) status = 'pending_confirmation';
      else if (dueDate < today) status = 'overdue';
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
    const { data: tenant } = await supabase.from('tenants').select('id,property_id,user_id').eq('login_user_id', req.userId).maybeSingle();
    if (!tenant) return res.status(403).json({ error: 'No tenancy linked to this login' });
    const { data: obligation } = await supabase.from('obligations').select('*').eq('id', req.params.obligationId).eq('property_id', tenant.property_id).single();
    if (!obligation) return res.status(404).json({ error: 'Bill not found' });
    const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : new Date().toISOString().slice(0, 7);
    const fileName = `proofs/${tenant.property_id}/${obligation.id}_${month}_${Date.now()}`;
    await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: req.file.mimetype }).catch(() => {});
    let extracted = { amount: null, date: null, utr: null };
    try { extracted = parsePaymentProof(await extractDocumentText(req.file.buffer, req.file.originalname, req.file.mimetype)); } catch (e) {}
    const { data, error } = await supabase.from('payments').insert([{
      property_id: tenant.property_id, user_id: tenant.user_id, tenant_id: tenant.id,
      obligation_id: obligation.id, period: `${month}-01`,
      amount: extracted.amount || obligation.amount || 0,
      payment_date: extracted.date || new Date().toISOString().slice(0, 10),
      status: 'pending', proof_url: fileName, utr_number: extracted.utr || null
    }]).select();
    if (error) throw error;
    res.status(201).json({ payment: data[0], extracted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// OWNER: update tenant details (deposit, screening, move-out, etc.)
app.patch('/api/tenants/:id', verifyToken, requireOwner, async (req, res) => {
  try {
    const allowed = {};
    for (const k of ['name', 'personal_email', 'personal_phone', 'age', 'gender', 'profession', 'employer', 'permanent_address', 'deposit_amount', 'deposit_paid_date', 'deposit_details', 'deposit_refunded_amount', 'deposit_refunded_date', 'police_verification_status', 'date_of_move_in', 'expected_date_of_move_out', 'actual_date_of_move_out', 'is_active']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
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
      supabase.from('tenants').select('id,name,property_id,date_of_move_in,expected_date_of_move_out,actual_date_of_move_out').eq('user_id', req.userId).eq('is_active', true),
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

    res.json({
      totalProperties: props?.length || 0,
      totalTenants: tenants?.length || 0,
      totalRentPaid,
      pendingMaintenanceCosts: pendingMaintenance,
      duesThisMonth: { month, total: (obligations || []).length, paid: duesPaid, pending: duesPending, overdue: duesOverdue },
      renewals: renewals.sort((a, b) => a.days_left - b.days_left),
      warrantyAlerts: warranties.sort((a, b) => a.days_left - b.days_left),
      movements: movements.sort((a, b) => a.days_left - b.days_left)
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
const { extractWhatsAppFacts } = require('./llm');

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
      const { data: prop } = await supabase.from('properties').select('id').eq('id', propertyId).eq('user_id', req.userId).maybeSingle();
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
    if (!extraction.skipped) {
      if (extraction.facts.length > 0) {
        await supabase.from('whatsapp_extracted_facts').insert(extraction.facts.map(f => ({
          import_id: importRow.id, category: f.category, fact_type: f.fact_type || null,
          value: String(f.value), confidence: typeof f.confidence === 'number' ? f.confidence : null,
          evidence: f.evidence || null, message_seq: typeof f.message_seq === 'number' ? f.message_seq : null
        })));
      }
      finalStatus = 'extracted';
    }
    const { data: updated } = await supabase.from('whatsapp_imports').update({ status: finalStatus }).eq('id', importRow.id).select().single();
    res.status(201).json({ import: updated, message_count: messages.length, fact_count: extraction.skipped ? 0 : extraction.facts.length });
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
    const [{ data: messages }, { data: facts }] = await Promise.all([
      supabase.from('whatsapp_messages').select('*').eq('import_id', req.params.id).order('seq', { ascending: true }),
      supabase.from('whatsapp_extracted_facts').select('*').eq('import_id', req.params.id).order('created_at', { ascending: true })
    ]);
    res.json({ import: importRow, messages: messages || [], facts: facts || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Attach/detach an import to a property after the fact (e.g. create the property
// from the review, then link the import to it).
app.patch('/api/whatsapp/imports/:id', verifyToken, async (req, res) => {
  try {
    const { property_id } = req.body;
    if (property_id) {
      const { data: prop } = await supabase.from('properties').select('id').eq('id', property_id).eq('user_id', req.userId).maybeSingle();
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }
    const { data, error } = await supabase.from('whatsapp_imports').update({ property_id: property_id || null }).eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Import not found' });
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Owner review action on one extracted fact. This ONLY changes the fact's own
// status/value -- it never writes to properties/tenants/obligations. Applying an
// approved fact into core records is intentionally deferred to a later phase.
app.patch('/api/whatsapp/facts/:id', verifyToken, async (req, res) => {
  try {
    const { status, owner_edited_value } = req.body;
    if (status && !['pending', 'approved', 'edited', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { data: existing } = await supabase.from('whatsapp_extracted_facts').select('id, whatsapp_imports!inner(user_id)')
      .eq('id', req.params.id).eq('whatsapp_imports.user_id', req.userId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Fact not found' });
    const allowed = {};
    if (status !== undefined) allowed.status = status;
    if (owner_edited_value !== undefined) allowed.owner_edited_value = owner_edited_value;
    const { data, error } = await supabase.from('whatsapp_extracted_facts').update(allowed).eq('id', req.params.id).select();
    if (error) throw error;
    res.json(data[0]);
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
    const propertyId = fact.whatsapp_imports.property_id;
    let property = null, tenants = [], obligations = [];
    if (propertyId) {
      const [{ data: p }, { data: t }, { data: o }] = await Promise.all([
        supabase.from('properties').select('*').eq('id', propertyId).eq('user_id', req.userId).maybeSingle(),
        supabase.from('tenants').select('id,name,personal_phone,personal_email,permanent_address,date_of_move_in,expected_date_of_move_out').eq('property_id', propertyId).eq('user_id', req.userId).eq('is_active', true),
        supabase.from('obligations').select('id,label,type,amount,paid_by').eq('property_id', propertyId).eq('user_id', req.userId).eq('active', true)
      ]);
      property = p; tenants = t || []; obligations = o || [];
    }
    delete fact.whatsapp_imports;
    res.json({ fact, property, tenants, obligations });
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
app.listen(PORT, () => { console.log(`✅ OMniNivas Backend running on port ${PORT}`); });
