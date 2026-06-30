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
  origin: ['https://omninivas-frontend-production.up.railway.app', 'http://localhost:3000'],
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
    version: 'MVP2-ImageMagick-Tesseract',
    time: new Date().toISOString() 
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, full_name, phone_number } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from('users').insert([{ email, full_name, phone_number, whatsapp_webhook_token: crypto.randomBytes(16).toString('hex') }]).select();
    if (error) throw error;
    const token = jwt.sign({ sub: data[0].id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: data[0], token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.from('users').select('*').eq('email', email).single();
    if (error || !data) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ sub: data.id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: data, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties', verifyToken, async (req, res) => {
  try {
    const { property_name, city, street_address, property_type } = req.body;
    if (!property_name || !city) return res.status(400).json({ error: 'Property name and city required' });
    const { data, error } = await supabase.from('properties').insert([{ 
      user_id: req.userId, 
      property_name: property_name.trim(), 
      city: city.trim(), 
      street_address: street_address ? street_address.trim() : '',
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

const parsePropertyFromText = (text) => {
  if (!text) text = '';
  let city = 'Bengaluru', address = '', propertyName = 'Property', propertyType = 'residential';
  const cityMatch = text.match(/(?:bengaluru|bangalore|mumbai|delhi|pune|hyderabad|chennai|kolkata)/i);
  if (cityMatch) city = cityMatch[0];
  const addressMatch = text.match(/(?:flat|wing|unit|address)[\s#:]*([A-Za-z0-9\s,\-\.]+?)(?:\n|,\s*[0-9]{6}|$)/i);
  if (addressMatch) address = addressMatch[1].trim().substring(0, 100);
  if (address) propertyName = address.substring(0, 50);
  else propertyName = `${city} Property`;
  if (text.toLowerCase().includes('commercial')) propertyType = 'commercial';
  return { property_name: propertyName || 'Property', street_address: address || '', city: city || 'Bengaluru', property_type: propertyType };
};

const parseTenantsFromText = (text) => {
  const emails = [...new Set(text.match(/[\w\.\-]+@[\w\.\-]+\.\w+/gi) || [])];
  const phones = [...new Set(text.match(/(?:\+91)?[\s\-]?[6-9]\d{2}[\s\-]?\d{3}[\s\-]?\d{4}|[6-9]\d{9}/g) || [])];
  const nameRegex = /(?:tenant|lessee|second party|name)[\s:]*([A-Z][A-Za-z\s]{2,50}?)(?:\n|aadhar|id|email|phone|d\/o|permanent|address)/gi;
  const names = [];
  let match;
  while ((match = nameRegex.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length > 2 && name.length < 50 && !name.match(/^\d+$/)) names.push(name);
  }
  const uniqueNames = [...new Set(names)];
  const maxTenants = Math.max(uniqueNames.length, emails.length, phones.length);
  const tenants = [];
  for (let i = 0; i < maxTenants; i++) {
    if (uniqueNames[i] || emails[i] || phones[i]) {
      tenants.push({
        name: uniqueNames[i] || `Tenant ${i + 1}`,
        personal_email: emails[i] || null,
        personal_phone: phones[i] || null,
        date_of_move_in: null
      });
    }
  }
  return tenants.filter(t => t.personal_email || t.personal_phone);
};

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
    const { name, personal_email, personal_phone, date_of_move_in } = req.body;
    if (!name || !personal_email) return res.status(400).json({ error: 'Name and email required' });
    const { data, error } = await supabase.from('tenants').insert([{ property_id: req.params.propertyId, user_id: req.userId, name: name.trim(), personal_email: personal_email.trim().toLowerCase(), personal_phone: personal_phone ? personal_phone.trim() : '', date_of_move_in: date_of_move_in || null, is_active: true }]).select();
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
      name: t.name?.trim() || '',
      personal_email: t.personal_email?.trim().toLowerCase() || '',
      personal_phone: t.personal_phone?.trim() || '',
      date_of_move_in: t.date_of_move_in || null,
      is_active: true
    })).filter(t => t.name && t.personal_email);
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
    const { tenant_id, amount, payment_date, status } = req.body;
    if (!tenant_id || !amount) return res.status(400).json({ error: 'Tenant and amount required' });
    const { data, error } = await supabase.from('payments').insert([{ property_id: req.params.propertyId, tenant_id, user_id: req.userId, amount: parseFloat(amount), payment_date: payment_date || new Date().toISOString().split('T')[0], status: status || 'paid' }]).select();
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

app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const { data: props } = await supabase.from('properties').select('id').eq('user_id', req.userId);
    const { data: tenants } = await supabase.from('tenants').select('id').eq('user_id', req.userId);
    const { data: payments } = await supabase.from('payments').select('amount').eq('user_id', req.userId).eq('status', 'paid');
    const { data: maintenance } = await supabase.from('maintenance_costs').select('amount').eq('user_id', req.userId).eq('status', 'pending');
    const totalRentPaid = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
    const pendingMaintenance = maintenance?.reduce((sum, m) => sum + (m.amount || 0), 0) || 0;
    res.json({ totalProperties: props?.length || 0, totalTenants: tenants?.length || 0, totalRentPaid, pendingMaintenanceCosts: pendingMaintenance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`✅ OMniNivas Backend running on port ${PORT}`); });
