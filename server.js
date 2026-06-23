require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const vision = require('@google-cloud/vision');
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

// Google Vision Client
const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

// Constants
const JWT_SECRET = process.env.JWT_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!JWT_SECRET || !WEBHOOK_SECRET) {
  throw new Error('Missing required environment variables');
}

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

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// POST /api/auth/register
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

// Webhook verification
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

// Server Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
