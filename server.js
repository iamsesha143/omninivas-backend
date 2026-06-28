require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const multer = require('multer');
const ws = require('ws');
const vision = require('@google-cloud/vision');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || '',
  { realtime: { transport: ws } }
);

// Initialize Google Vision Client
let visionClient;
try {
  const credentials = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS || '{}');
  visionClient = new vision.ImageAnnotatorClient({ credentials });
} catch (err) {
  console.warn('⚠️  Google Vision not configured. Text extraction will be disabled.');
  visionClient = null;
}

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
  res.json({ status: 'ok', version: 'MVP2-GoogleVision', time: new Date().toISOString(), googleVisionReady: !!visionClient });
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

// ===== GOOGLE VISION TEXT EXTRACTION =====

const extractTextFromDocument = async (buffer, mimeType) => {
  if (!visionClient) throw new Error('Google Vision API not configured');

  try {
    let result;
    
    // Use documentTextDetection for PDFs, textDetection for images
    if (mimeType === 'application/pdf') {
      const request = {
        image: {
          content: buffer.toString('base64')
        }
      };
      [result] = await visionClient.documentTextDetection(request);
    } else {
      const request = {
        image: {
          content: buffer.toString('base64')
        }
      };
      [result] = await visionClient.textDetection(request);
    }

    const detections = result.textAnnotations;
    if (!detections || detections.length === 0) {
      return '';
    }

    // First element contains all text
    return detections[0].description || '';
  } catch (err) {
    console.error('Vision API error:', err);
    throw err;
  }
};

// ===== EXTRACT PROPERTY DATA =====

const parsePropertyFromText = (text) => {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const textLower = text.toLowerCase();

  // Try to find city
  let city = null;
  const cityPatterns = [
    /(?:city|municipality|loc|location)[\s:]*([A-Za-z\s]+?)(?:\n|,|india)/i,
    /(?:bengaluru|bangalore|mumbai|delhi|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur)/i
  ];
  for (const pattern of cityPatterns) {
    const match = text.match(pattern);
    if (match) {
      city = match[1] ? match[1].trim() : match[0];
      if (city.length > 50) city = city.substring(0, 50);
      break;
    }
  }

  // Try to find address
  let address = null;
  const addressPatterns = [
    /(?:address|location|premises|property|flat|apt)[\s:]*([^\n]+)/i,
    /(\d+[A-Za-z\s,\-\.]*(?:road|street|lane|avenue|circle|plot|building|block))/i
  ];
  for (const pattern of addressPatterns) {
    const match = text.match(pattern);
    if (match) {
      address = match[1] ? match[1].trim() : match[0];
      if (address.length > 100) address = address.substring(0, 100);
      break;
    }
  }

  // Try to find property name
  let propertyName = address ? address.substring(0, 50) : (city ? `${city} Property` : 'Property');

  return {
    property_name: propertyName,
    street_address: address || '',
    city: city || '',
    property_type: textLower.includes('commercial') ? 'commercial' : 'residential'
  };
};

app.post('/api/extract/property', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!visionClient) return res.status(503).json({ error: 'Google Vision API not configured' });

    const extractedText = await extractTextFromDocument(req.file.buffer, req.file.mimetype);
    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({ error: 'Could not extract text from document. Please ensure file is clear and readable.' });
    }

    const propertyData = parsePropertyFromText(extractedText);
    res.json({ success: true, extractedData: propertyData, extractedText });
  } catch (err) {
    console.error('Property extraction error:', err);
    res.status(500).json({ error: 'Failed to extract property data: ' + err.message });
  }
});

// ===== EXTRACT MULTIPLE TENANTS FROM DOCUMENT =====

const parseTenantsFromText = (text) => {
  const tenants = [];

  // Email pattern
  const emailRegex = /[\w\.\-]+@[\w\.\-]+\.\w+/gi;
  const emails = [...new Set(text.match(emailRegex) || [])];

  // Phone patterns (Indian)
  const phoneRegex = /(?:\+91|0)?[\s\-]?[6-9]\d{2}[\s\-]?\d{3}[\s\-]?\d{4}|[6-9]\d{9}/g;
  const phones = [...new Set(text.match(phoneRegex) || [])];

  // Name patterns - look for names after keywords
  const nameRegex = /(?:tenant|lessee|party|lessees|person|occupant|occupier|applicant)[\s:]*([A-Z][A-Za-z\s]{2,40}?)(?:\n|,|email|phone|mob|\()/gi;
  const names = [];
  let nameMatch;
  while ((nameMatch = nameRegex.exec(text)) !== null) {
    const name = nameMatch[1].trim();
    if (name.length > 2 && name.length < 50 && !name.match(/^\d+$/)) {
      names.push(name);
    }
  }

  // Remove duplicates
  const uniqueNames = [...new Set(names)];

  // Create tenants - match emails/phones with names
  const maxTenants = Math.max(uniqueNames.length, emails.length, phones.length);
  
  for (let i = 0; i < maxTenants; i++) {
    const tenant = {
      name: uniqueNames[i] || `Tenant ${i + 1}`,
      personal_email: emails[i] || null,
      personal_phone: phones[i] || null,
      date_of_move_in: null
    };
    tenants.push(tenant);
  }

  // Filter: must have name AND (email OR phone)
  return tenants.filter(t => t.name && t.name !== `Tenant ${tenants.indexOf(t) + 1}` && (t.personal_email || t.personal_phone));
};

app.post('/api/extract/tenants', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!visionClient) return res.status(503).json({ error: 'Google Vision API not configured' });

    const extractedText = await extractTextFromDocument(req.file.buffer, req.file.mimetype);
    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({ error: 'Could not extract text from document. Please ensure file is clear and readable.' });
    }

    const tenantsList = parseTenantsFromText(extractedText);
    res.json({ success: true, extractedData: { tenants: tenantsList }, extractedText });
  } catch (err) {
    console.error('Tenant extraction error:', err);
    res.status(500).json({ error: 'Failed to extract tenant data: ' + err.message });
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

// ===== DOCUMENTS (Store any file type) =====

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

// ===== MAINTENANCE COSTS =====

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

// ===== DASHBOARD STATS =====

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
app.listen(PORT, () => { console.log(`✅ OMniNivas Backend running on port ${PORT} with Google Vision enabled`); });
