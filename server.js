require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// Multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Initialize Anthropic
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key';

// ============================================================================
// MIDDLEWARE
// ============================================================================

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

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: 'MVP 2', timestamp: new Date().toISOString() });
});

// ============================================================================
// AUTH ENDPOINTS
// ============================================================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, full_name, phone_number } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const whatsappToken = crypto.randomBytes(32).toString('hex');

    const { data, error } = await supabase
      .from('users')
      .insert([{ email, full_name, phone_number, whatsapp_webhook_token: whatsappToken }])
      .select();

    if (error) return res.status(400).json({ error: error.message });

    const token = jwt.sign({ sub: data[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user: data[0], token, whatsappToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !data) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ sub: data.id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user: data, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.userId)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// MVP 2: DOCUMENT EXTRACTION (Simplified - no Google Vision for now)
// ============================================================================

app.post('/api/extract/rental-agreement', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // For MVP 2, we'll use a simplified extraction
    // In production, integrate Google Vision API here
    const parsePrompt = `Extract tenant information from a rental agreement. Return ONLY valid JSON:
{
  "tenant_name": "string or null",
  "tenant_email": "string or null",
  "tenant_phone": "string or null",
  "monthly_rent": "number or null",
  "security_deposit": "number or null",
  "agreement_start_date": "YYYY-MM-DD or null",
  "agreement_end_date": "YYYY-MM-DD or null"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 256,
      messages: [
        { role: 'user', content: parsePrompt }
      ]
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(400).json({ error: 'Could not parse agreement' });
    }

    const extractedData = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      extractedData: extractedData
    });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PROPERTIES ENDPOINTS
// ============================================================================

app.post('/api/properties', verifyToken, async (req, res) => {
  try {
    const { property_name, property_type, flat_number, society_name, street_address, city, state, pincode } = req.body;

    const { data, error } = await supabase
      .from('properties')
      .insert([{
        user_id: req.userId,
        property_name,
        property_type,
        flat_number,
        society_name,
        street_address,
        city,
        state,
        pincode
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('properties')
      .select('*')
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('properties')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/properties/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('properties')
      .update(req.body)
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// TENANTS ENDPOINTS
// ============================================================================

app.post('/api/properties/:propertyId/tenants', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { name, age, gender, personal_email, personal_phone, date_of_move_in } = req.body;

    const { data, error } = await supabase
      .from('tenants')
      .insert([{
        property_id: propertyId,
        user_id: req.userId,
        name,
        age: parseInt(age || 0),
        gender,
        personal_email,
        personal_phone,
        date_of_move_in,
        is_active: true
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/tenants', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { data, error } = await supabase
      .from('tenants')
      .select('*')
      .eq('property_id', propertyId)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// RENTAL AGREEMENTS
// ============================================================================

app.post('/api/properties/:propertyId/rental-agreements', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { tenant_id, monthly_rent, security_deposit, agreement_start_date, agreement_end_date } = req.body;

    const { data, error } = await supabase
      .from('rental_agreements')
      .insert([{
        property_id: propertyId,
        tenant_id,
        user_id: req.userId,
        monthly_rent: parseFloat(monthly_rent),
        security_deposit: parseFloat(security_deposit || 0),
        agreement_start_date,
        agreement_end_date,
        is_active: true
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/rental-agreements', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { data, error } = await supabase
      .from('rental_agreements')
      .select('*')
      .eq('property_id', propertyId)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PAYMENTS
// ============================================================================

app.post('/api/properties/:propertyId/payments', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { tenant_id, amount, payment_date } = req.body;

    const { data, error } = await supabase
      .from('payments')
      .insert([{
        property_id: propertyId,
        tenant_id,
        user_id: req.userId,
        amount: parseFloat(amount),
        payment_date
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/payments', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('property_id', propertyId)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OMniNivas Backend (MVP 2) running on port ${PORT}`));
