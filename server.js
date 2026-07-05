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

const app = express();

app.use(cors({
  origin: ['https://omninivas-frontend-production.up.railway.app', 'http://localhost:3000', 'http://localhost:4173'],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || '',
  { realtime: { transport: ws } }
);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.sub;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: 'MVP3.1-assets-vendors-invites-renewals',
    time: new Date().toISOString() 
  });
});

app.post('/api/auth/register', async (req, res) => {
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
    const token = jwt.sign({ sub: data[0].id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: data[0], token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
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
    const token = jwt.sign({ sub: data.id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: data, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties', verifyToken, async (req, res) => {
  try {
    const { property_name, city, state, street_address, pincode, property_type } = req.body;
    
    if (!property_name || !city || !state || !pincode) {
      return res.status(400).json({ error: 'Property name, city, state, and pincode required' });
    }

    const { data, error } = await supabase.from('properties').insert([{
      user_id: req.userId,
      property_name: property_name.trim(),
      city: city.trim(),
      state: state.trim(),
      street_address: street_address ? street_address.trim() : '',
      pincode: pincode.trim(),
      property_type: property_type || 'residential'
    }]).select();
    
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('properties').select('*').eq('user_id', req.userId);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('properties').select('*').eq('id', req.params.id).eq('user_id', req.userId).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/properties/:id', verifyToken, async (req, res) => {
  try {
    const allowed = {};
    for (const k of ['property_name', 'street_address', 'city', 'state', 'pincode', 'property_type', 'agreement_start_date', 'agreement_months']) {
      if (req.body[k] !== undefined) allowed[k] = req.body[k];
    }
    const { data, error } = await supabase.from('properties').update(allowed).eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    res.json(data[0]);
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
    const pdf = await pdfjsLib.getDocument({data: uint8Array}).promise;
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

app.post('/api/extract/property', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const text = await extractDocumentText(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!text || text.trim().length < 50) return res.status(400).json({ error: 'Could not extract text from document', textLength: text.length });
    const propertyData = parsePropertyFromText(text);
    res.json({ success: true, extractedData: propertyData });
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
    const fileName = `properties/${req.params.propertyId}/deed_${Date.now()}`;
    const { error } = await supabase.storage.from('documents').upload(fileName, req.file.buffer, { contentType: req.file.mimetype, metadata: { user_id: req.userId } });
    if (error) throw error;
    res.json({ success: true, url: fileName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/documents', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.storage.from('documents').list(`properties/${req.params.propertyId}`, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
    if (error) throw error;
    const files = (data || []).map(f => ({
      name: f.name,
      created_at: f.created_at,
      size: f.metadata?.size,
      url: `properties/${req.params.propertyId}/${f.name}`
    }));
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
    res.json({ success: true, url: fileName });
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
    const { data, error } = await supabase.from('payments').update(allowed)
      .eq('id', req.params.id).eq('user_id', req.userId).select();
    if (error) throw error;
    res.json(data[0]);
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

app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const period = `${month}-01`;
    const today = new Date().toISOString().slice(0, 10);
    const [{ data: props }, { data: tenants }, { data: payments }, { data: maintenance }, { data: obligations }, { data: monthPayments }] = await Promise.all([
      supabase.from('properties').select('id,property_name').eq('user_id', req.userId),
      supabase.from('tenants').select('id').eq('user_id', req.userId).eq('is_active', true),
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
      supabase.from('properties').select('id,property_name,agreement_start_date,agreement_months').eq('user_id', req.userId),
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
      if (days <= 60) renewals.push({ property: p.property_name, expires_on: end.toISOString().slice(0, 10), days_left: days });
    }
    const warranties = (appliances || [])
      .map(a => ({ name: a.name, warranty_end: a.warranty_end, days_left: daysUntil(a.warranty_end) }))
      .filter(a => a.days_left <= 30);

    res.json({
      totalProperties: props?.length || 0,
      totalTenants: tenants?.length || 0,
      totalRentPaid,
      pendingMaintenanceCosts: pendingMaintenance,
      duesThisMonth: { month, total: (obligations || []).length, paid: duesPaid, pending: duesPending, overdue: duesOverdue },
      renewals: renewals.sort((a, b) => a.days_left - b.days_left),
      warrantyAlerts: warranties.sort((a, b) => a.days_left - b.days_left)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`✅ OMniNivas Backend running on port ${PORT}`); });
