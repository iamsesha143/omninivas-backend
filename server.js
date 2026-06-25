require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key';

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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

app.get('/api/rental-agreements/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_agreements')
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

app.patch('/api/rental-agreements/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rental_agreements')
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

app.get('/api/tenants/:tenantId/payment-history', verifyToken, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('user_id', req.userId)
      .order('payment_date', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/properties/:propertyId/tenant-summary/:tenantId', verifyToken, async (req, res) => {
  try {
    const { propertyId, tenantId } = req.params;
    const { data: tenantData } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .single();
    const { data: agreementData } = await supabase
      .from('rental_agreements')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();
    const { data: paymentData } = await supabase
      .from('payments')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('user_id', req.userId);
    const { data: maintenanceData } = await supabase
      .from('maintenance_costs')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('user_id', req.userId);
    const totalPaid = paymentData ? paymentData.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0) : 0;
    const totalMaintenance = maintenanceData ? maintenanceData.reduce((sum, m) => sum + parseFloat(m.tenant_share || 0), 0) : 0;
    res.json({
      tenant: tenantData,
      agreement: agreementData,
      payments: paymentData,
      maintenance_costs: maintenanceData,
      total_paid: totalPaid,
      total_maintenance_paid: totalMaintenance
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:propertyId/financial-summary', verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { data: maintenanceData } = await supabase
      .from('maintenance_costs')
      .select('*')
      .eq('property_id', propertyId)
      .eq('user_id', req.userId);
    const { data: otherCostsData } = await supabase
      .from('other_costs')
      .select('*')
      .eq('property_id', propertyId)
      .eq('user_id', req.userId);
    const { data: paymentData } = await supabase
      .from('payments')
      .select('*')
      .eq('property_id', propertyId)
      .eq('user_id', req.userId);
    const costByType = {};
    if (maintenanceData) {
      maintenanceData.forEach(m => {
        if (!costByType[m.cost_type]) costByType[m.cost_type] = 0;
        costByType[m.cost_type] += parseFloat(m.amount || 0);
      });
    }
    if (otherCostsData) {
      otherCostsData.forEach(o => {
        if (!costByType[o.cost_type]) costByType[o.cost_type] = 0;
        costByType[o.cost_type] += parseFloat(o.amount || 0);
      });
    }
    const totalRevenue = paymentData ? paymentData.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0) : 0;
    const totalCosts = (maintenanceData ? maintenanceData.reduce((sum, m) => sum + parseFloat(m.amount || 0), 0) : 0) + (otherCostsData ? otherCostsData.reduce((sum, o) => sum + parseFloat(o.amount || 0), 0) : 0);
    res.json({
      total_revenue: totalRevenue,
      total_costs: totalCosts,
      net_income: totalRevenue - totalCosts,
      cost_by_type: costByType,
      payments: paymentData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/webhooks/whatsapp', (req, res) => {
  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'verify-token-123';
  const challenge = req.query['hub.challenge'];
  const token = req.query['hub.verify_token'];
  if (token === verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Invalid verification token' });
  }
});

app.post('/api/webhooks/whatsapp', (req, res) => {
  res.status(200).json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OMniNivas Backend running on port ${PORT}`));
