require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const multer = require('multer');
const vision = require('@google-cloud/vision');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

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

// Initialize Google Vision and Anthropic
const visionClient = new vision.ImageAnnotatorClient();
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
// MVP 2: DOCUMENT EXTRACTION
// ============================================================================

app.post('/api/extract/rental-agreement', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;
    const fileExt = path.extname(fileName).toLowerCase();

    let extractedText = '';

    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileExt)) {
      const request = {
        image: {
          content: fileBuffer,
        },
      };

      const [result] = await visionClient.documentTextDetection(request);
      const fullTextAnnotation = result.fullTextAnnotation;
      extractedText = fullTextAnnotation ? fullTextAnnotation.text : '';
    } else if (fileExt === '.pdf') {
      return res.status(400).json({ 
        error: 'Please upload agreement as image (JPG/PNG). PDF support coming soon.',
        suggestion: 'Convert PDF to image using any online tool and re-upload'
      });
    }

    if (!extractedText) {
      return res.status(400).json({ error: 'Could not extract text from image' });
    }

    // Parse extracted text using Claude to get structured data
    const parsePrompt = `Extract structured tenant and rental information from this rental agreement text. Return ONLY valid JSON with these exact keys (use null for missing values):

{
  "tenant_name": "string",
  "tenant_age": "number or null",
  "tenant_gender": "string or null",
  "tenant_email": "string or null",
  "tenant_phone": "string or null",
  "monthly_rent": "number or null",
  "security_deposit": "number or null",
  "maintenance_charges": "number or null",
  "maintenance_includes": "string or null",
  "other_charges": "string or null",
  "other_charges_amount": "number or null",
  "payment_due_date": "number or null (1-31)",
  "agreement_start_date": "string in YYYY-MM-DD or null",
  "agreement_end_date": "string in YYYY-MM-DD or null",
  "co_tenants": [
    {
      "name": "string",
      "age": "number or null",
      "gender": "string or null",
      "phone": "string or null",
      "relationship": "string or null"
    }
  ]
}

Agreement text:
${extractedText}`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: parsePrompt }
      ]
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    
    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(400).json({ error: 'Could not parse agreement structure' });
    }

    const extractedData = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      extractedText: extractedText.substring(0, 500) + '...',
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
    const { property_name, property_type, flat_number, society_name, street_address, city, state, pincode, constructed_area_sqft, carpet_area_sqft, total_floors, current_floor, parking_slots, year_built, society_contact_name, society_contact_phone } = req.body;

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
        pincode,
        constructed_area_sqft: parseInt(constructed_area_sqft || 0),
        carpet_area_sqft: parseInt(carpet_area_sqft || 0),
        total_floors: parseInt(total_floors || 0),
        current_floor: parseInt(current_floor || 0),
        parking_slots: parseInt(parking_slots || 0),
        year_built: parseInt(year_built || 0),
        society_contact_name,
        society_contact_phone
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
    const { name, age, gender, pan_card, aadhar_card, personal_email, personal_phone, permanent_address, occupancy_type, number_of_occupants, emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, date_of_move_in } = req.body;

    const { data, error } = await supabase
      .from('tenants')
      .insert([{
        property_id: propertyId,
        user_id: req.userId,
        name,
        age: parseInt(age || 0),
        gender,
        pan_card,
        aadhar_card,
        personal_email,
        personal_phone,
        permanent_address,
        occupancy_type,
        number_of_occupants: parseInt(number_of_occupants || 1),
        emergency_contact_name,
        emergency_contact_phone,
        emergency_contact_relationship,
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

app.get('/api/tenants/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tenants')
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

app.patch('/api/tenants/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tenants')
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

app.post('/api/tenants/:tenantId/co-tenants', verifyToken, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { name, age, gender, relationship, pan_card, aadhar_card, phone, email } = req.body;

    const { data, error } = await supabase
      .from('co_tenants')
      .insert([{
        main_tenant_id: tenantId,
        name,
        age: parseInt(age || 0),
        gender,
        relationship,
        pan_card,
        aadhar_card,
        phone,
        email
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
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
    const { tenant_id, monthly_rent, security_deposit, maintenance_charges, maintenance_includes_text, other_charges_description, other_charges_amount, payment_due_date, rent_increase_percentage, rent_increase_month, agreement_start_date, agreement_end_date } = req.body;

    const { data, error } = await supabase
      .from('rental_agreements')
      .insert([{
        property_id: propertyId,
        tenant_id,
        user_id: req.userId,
        monthly_rent: parseFloat(monthly_rent),
        security_deposit: parseFloat(security_deposit || 0),
        maintenance_charges: parseFloat(maintenance_charges || 0),
        maintenance_includes_text,
        other_charges_description,
        other_charges_amount: parseFloat(other_charges_amount || 0),
        payment_due_date: parseInt(payment_due_date),
        rent_increase_percentage: parseFloat(rent_increase_percentage || 0),
        rent_increase_month: parseInt(rent_increase_month),
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
// MAINTENANCE COSTS
// ============================================================================

app.post('/api/properties/:propertyId/maintenance-costs', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { tenant_id, cost_type, description, amount, paid_by, owner_share, tenant_share, maintenance_date, category, vendor_name, vendor_phone } = req.body;

    const { data, error } = await supabase
      .from('maintenance_costs')
      .insert([{
        property_id: propertyId,
        user_id: req.userId,
        tenant_id: tenant_id || null,
        cost_type,
        description,
        amount: parseFloat(amount),
        paid_by,
        owner_share: parseFloat(owner_share || 0),
        tenant_share: parseFloat(tenant_share || 0),
        maintenance_date,
        category,
        vendor_name,
        vendor_phone
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/maintenance-costs', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { data, error } = await supabase
      .from('maintenance_costs')
      .select('*')
      .eq('property_id', propertyId)
      .eq('user_id', req.userId)
      .order('maintenance_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// OTHER COSTS
// ============================================================================

app.post('/api/properties/:propertyId/other-costs', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { tenant_id, cost_type, description, amount, billing_month, billing_year, paid_by, owner_share, tenant_share } = req.body;

    const { data, error } = await supabase
      .from('other_costs')
      .insert([{
        property_id: propertyId,
        user_id: req.userId,
        tenant_id: tenant_id || null,
        cost_type,
        description,
        amount: parseFloat(amount),
        billing_month: parseInt(billing_month),
        billing_year: parseInt(billing_year),
        paid_by,
        owner_share: parseFloat(owner_share || 0),
        tenant_share: parseFloat(tenant_share || 0)
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/other-costs', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { data, error } = await supabase
      .from('other_costs')
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
    const { tenant_id, payment_type, description, amount, payment_date, payment_method, utr_number, cheque_number } = req.body;

    const { data, error } = await supabase
      .from('payments')
      .insert([{
        property_id: propertyId,
        tenant_id,
        user_id: req.userId,
        payment_type,
        description,
        amount: parseFloat(amount),
        payment_date,
        payment_method,
        utr_number,
        cheque_number
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
      .eq('user_id', req.userId)
      .order('payment_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DASHBOARD
// ============================================================================

app.get('/api/properties/:propertyId/dashboard', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { data: propData } = await supabase
      .from('properties')
      .select('*')
      .eq('id', propertyId)
      .eq('user_id', req.userId)
      .single();

    const { data: tenantData } = await supabase
      .from('tenants')
      .select('*')
      .eq('property_id', propertyId)
      .eq('is_active', true);

    const { data: agreementData } = await supabase
      .from('rental_agreements')
      .select('*')
      .eq('property_id', propertyId)
      .eq('is_active', true);

    const currentDate = new Date();
    const { data: maintenanceData } = await supabase
      .from('maintenance_costs')
      .select('*')
      .eq('property_id', propertyId)
      .gte('maintenance_date', `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-01`);

    const totalMonthlyRevenue = agreementData ? agreementData.reduce((sum, a) => sum + parseFloat(a.monthly_rent || 0), 0) : 0;
    const maintenanceThisMonth = maintenanceData ? maintenanceData.reduce((sum, m) => sum + parseFloat(m.amount || 0), 0) : 0;

    res.json({
      property: propData,
      active_tenants_count: tenantData ? tenantData.length : 0,
      agreements_count: agreementData ? agreementData.length : 0,
      total_monthly_revenue: totalMonthlyRevenue,
      maintenance_this_month: maintenanceThisMonth,
      tenants: tenantData,
      agreements: agreementData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OMniNivas Backend (MVP 2) running on port ${PORT}`));
