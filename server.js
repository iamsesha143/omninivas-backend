require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Constants
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret';

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// JWT Verification Middleware
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

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, full_name, phone_number } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const whatsappToken = crypto.randomBytes(32).toString('hex');

    const { data: users, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .limit(1);

    if (users && users.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

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

// POST /api/auth/login
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

// GET /api/properties (Protected)
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

// POST /api/properties
app.post('/api/properties', verifyToken, async (req, res) => {
  try {
    const { property_name, property_type, address, flat_number, area_sqft } = req.body;
    const { data, error } = await supabase
      .from('properties')
      .insert([{ user_id: req.userId, property_name, property_type, address, flat_number, area_sqft }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/properties/:id
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

// GET /api/user
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

// WhatsApp Webhook Verification
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

// WhatsApp Webhook Handler
app.post('/api/webhooks/whatsapp', (req, res) => {
  res.status(200).json({ received: true });
});

// Server Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
