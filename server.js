require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const multer = require('multer');
const ws = require('ws');
const pdfParse = require('pdf-parse');

const app = express();

// CORS - MUST be before routes
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
  res.json({ status: 'ok', version: 'MVP2-PDFSimple', time: new Date().toISOString() });
});

// ===== AUTH =====

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

// ===== PROPERTIES =====

app.post('/api/properties', verifyToken, async (req, res) => {
  try {
    const { property_name, city, street_address } = req.body;
    if (!property_name || !city) return res.status(400).json({ error: 'Property name and city required' });
    const { data, error } = await supabase.from('properties').insert([{ user_id: req.userId, property_name: property_name.trim(), city: city.trim(), street_address: street_address ? street_address.trim() : '' }]).select();
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

// ===== TEXT EXTRACTION =====

const extractTextFromPDF = async (buffer) => {
  const data = await pdfParse(buffer);
  return data.text || '';
};

const parsePropertyFromText = (text) => {
  const textLower = text.toLowerCase();
  let city = '', address = '', propertyName = 'Property';

  const cityMatch = text.match(/(?:city|location|bangalore|bengaluru|mumbai|delhi|pune|hyderabad|flat|wing)[\s:]*([A-Za-z\s,\-\d]+?)(?:\n|,|\d{6})/i);
  if (cityMatch) city = cityMatch[1].trim().substring(0, 50).replace(/\d{6}/, '');

  const addressMatch = text.match(/(?:flat|wing|address|road|main road|sentosa|panathur)[\s\#]*[\d\w\s,\-\.]*(?:bengaluru|bangalore)?/i);
  if (addressMatch) address = addressMatch[0].trim().substring(0, 100);

  if (address) propertyName = address.substring(0, 50);
  else if (city) propertyName = `${city} Property`;

  return {
    property_name: propertyName,
    street_address: address,
    city: city || 'Bengaluru',
    property_type: textLower.includes('commercial') ? 'commercial' : 'residential'
  };
};

app.post('/api/extract/property', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    let text = '';
    if (req.file.mimetype === 'application/pdf') {
      text = await extractTextFromPDF(req.file.buffer);
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Could not extract text from file' });
    }

    const propertyData = parsePropertyFromText(text);
    res.json({ success: true, extractedData: propertyData });
  } catch (err) {
    console.error('Property extraction error:', err);
    res.status(500).json({ error: 'Failed to extract: ' + err.message });
  }
});

// ===== PARSE TENANTS =====

const parseTenantsFromText = (text) => {
  const emails = [...new Set(text.match(/[\w\.\-]+@[\w\.\-]+\.\w+/gi) || [])];
  const phones = [...new Set(text.match(/(?:\+91)?[\s\-]?[6-9]\d{2}[\s\-]?\d{3}[\s\-]?\d{4}|[6-9]\d{9}/g) || [])];

  const nameRegex = /(?:tenant|lessee|shreya|shraddha|name|second party|lessor)[\s:]*([A-Z][A-Za-z\s]{2,50}?)(?:\n|aadhar|id|email|phone|d\/o|permanently)/gi;
  const names = [];
  let match;
  while ((match = nameRegex.exec(text)) !== null) {
    const name = match[1].trim().replace(/aadhar|id|email|phone/gi, '');
    if (name.length > 2 && name.length < 50 && !name.match(/^\d+$/)) {
      names.push(name);
    }
  }

  const uniqueNames = [...new Set(names)];
  const maxTenants = Math.max(uniqueNames.length, emails.length, phones.length);
  const tenants = [];

  for (let i = 0; i < maxTenants; i++) {
    tenants.push({
      name: uniqueNames[i] || `Tenant ${i + 1}`,
      personal_email: emails[i] || null,
      personal_phone: phones[i] || null,
      date_of_move_in: null
    });
  }

  return tenants.filter(t => t.name && (t.personal_email || t.personal_phone));
};

app.post('/api/extract/tenants', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    let text = '';
    if (req.file.mimetype === 'application/pdf') {
      text = await extractTextFromPDF(req.file.buffer);
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Could not extract text from file' });
    }

    const tenantsList = parseTenantsFromText(text);
    res.json({ success: true, extractedData: { tenants: tenantsList } });
  } catch (err) {
    console.error('Tenant extraction error:', err);
    res.status(500).json({ error: 'Failed to extract: ' + err.message });
  }
});

// ===== TENANTS =====

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

// ===== DOCUMENTS =====

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

// ===== PAYMENTS =====

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

// ===== MAINTENANCE =====

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

// ===== DASHBOARD =====

app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const { data: props } = await supabase.from('properties').select('id').eq('user_id', req.userId);
    const { data: tenants } = await supabase.from('tenants').select('id').eq('user_id', req.userId);
    const { data: payments } = await supabase.from('payments').select('amount').eq('user_id', req.userId).eq('status', 'paid');
    const { data: maintenance } = await supabase.from('maintenance_costs').select('amount').eq('user_id', req.userId).eq('status', 'pending');
    const totalRentPaid = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
    const pendingMaintenance = maintenance?.reduce((sum, m) => sum + (m.amount || 0), 0) || 0;
    res.json({
      totalProperties: props?.length || 0,
      totalTenants: tenants?.length || 0,
      totalRentPaid,
      pendingMaintenanceCosts: pendingMaintenance
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`✅ OMniNivas Backend running on port ${PORT}`); });
