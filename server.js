{\rtf1\ansi\ansicpg1252\cocoartf2822
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fnil\fcharset0 .AppleSystemUIFontMonospaced-Regular;}
{\colortbl;\red255\green255\blue255;\red110\green117\blue134;\red33\green33\blue31;\red229\green231\blue236;
\red95\green167\blue255;\red201\green206\blue214;\red140\green233\blue81;\red191\green94\blue241;\red82\green235\blue232;
\red248\green157\blue78;\red239\green99\blue114;\red243\green155\blue77;\red135\green225\blue77;}
{\*\expandedcolortbl;;\cssrgb\c50588\c53333\c59608;\cssrgb\c17255\c17255\c16471;\cssrgb\c91765\c92549\c94118;
\cssrgb\c43922\c72157\c100000;\cssrgb\c82745\c84314\c87059;\cssrgb\c60784\c91373\c38824;\cssrgb\c80000\c48235\c95686;\cssrgb\c36863\c92941\c92941;
\cssrgb\c98431\c67843\c37647;\cssrgb\c95686\c48235\c52157;\cssrgb\c96863\c67059\c37255;\cssrgb\c58824\c89020\c37255;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\deftab720
\pard\pardeftab720\partightenfactor0

\f0\fs28 \cf2 \cb3 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 // OMniNivas Backend API - Node.js/Express\cf4 \strokec4 \
\cf2 \strokec2 // Copy this entire code into server.js file\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf5 \strokec5 require\cf6 \strokec6 (\cf7 \strokec7 'dotenv'\cf6 \strokec6 ).\cf5 \strokec5 config\cf6 \strokec6 ();\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 const\cf4 \strokec4  express = \cf5 \strokec5 require\cf6 \strokec6 (\cf7 \strokec7 'express'\cf6 \strokec6 );\cf4 \strokec4 \
\cf8 \strokec8 const\cf4 \strokec4  cors = \cf5 \strokec5 require\cf6 \strokec6 (\cf7 \strokec7 'cors'\cf6 \strokec6 );\cf4 \strokec4 \
\cf8 \strokec8 const\cf4 \strokec4  jwt = \cf5 \strokec5 require\cf6 \strokec6 (\cf7 \strokec7 'jsonwebtoken'\cf6 \strokec6 );\cf4 \strokec4 \
\cf8 \strokec8 const\cf4 \strokec4  bcrypt = \cf5 \strokec5 require\cf6 \strokec6 (\cf7 \strokec7 'bcryptjs'\cf6 \strokec6 );\cf4 \strokec4 \
\cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  createClient \cf6 \strokec6 \}\cf4 \strokec4  = \cf5 \strokec5 require\cf6 \strokec6 (\cf7 \strokec7 '@supabase/supabase-js'\cf6 \strokec6 );\cf4 \strokec4 \
\cf8 \strokec8 const\cf4 \strokec4  vision = \cf5 \strokec5 require\cf6 \strokec6 (\cf7 \strokec7 '@google-cloud/vision'\cf6 \strokec6 );\cf4 \strokec4 \
\cf8 \strokec8 const\cf4 \strokec4  crypto = \cf5 \strokec5 require\cf6 \strokec6 (\cf7 \strokec7 'crypto'\cf6 \strokec6 );\cf4 \strokec4 \
\
\cf8 \strokec8 const\cf4 \strokec4  app = \cf5 \strokec5 express\cf6 \strokec6 ();\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // INITIALIZATION\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
\cf2 \strokec2 // Middleware\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 use\cf6 \strokec6 (\cf5 \strokec5 cors\cf6 \strokec6 ());\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 use\cf6 \strokec6 (\cf4 \strokec4 express\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 ());\cf4 \strokec4 \
\
\cf2 \strokec2 // Supabase Client\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 const\cf4 \strokec4  supabase = \cf5 \strokec5 createClient\cf6 \strokec6 (\cf4 \strokec4 \
  process\cf6 \strokec6 .\cf4 \strokec4 env\cf6 \strokec6 .\cf9 \strokec9 SUPABASE_URL\cf6 \strokec6 ,\cf4 \strokec4 \
  process\cf6 \strokec6 .\cf4 \strokec4 env\cf6 \strokec6 .\cf9 \strokec9 SUPABASE_KEY\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 );\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // Google Vision Client\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 const\cf4 \strokec4  visionClient = \cf8 \strokec8 new\cf4 \strokec4  \cf10 \strokec10 vision\cf6 \strokec6 .\cf10 \strokec10 ImageAnnotatorClient\cf6 \strokec6 (\{\cf4 \strokec4 \
  \cf11 \strokec11 keyFilename\cf4 \strokec4 : process\cf6 \strokec6 .\cf4 \strokec4 env\cf6 \strokec6 .\cf9 \strokec9 GOOGLE_APPLICATION_CREDENTIALS\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // Constants\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 const\cf4 \strokec4  \cf9 \strokec9 JWT_SECRET\cf4 \strokec4  = process\cf6 \strokec6 .\cf4 \strokec4 env\cf6 \strokec6 .\cf9 \strokec9 JWT_SECRET\cf4 \strokec4  || \cf7 \strokec7 'your-secret-key-change-in-production'\cf6 \strokec6 ;\cf4 \strokec4 \
\cf8 \strokec8 const\cf4 \strokec4  \cf9 \strokec9 WEBHOOK_SECRET\cf4 \strokec4  = process\cf6 \strokec6 .\cf4 \strokec4 env\cf6 \strokec6 .\cf9 \strokec9 WEBHOOK_SECRET\cf4 \strokec4  || \cf7 \strokec7 'webhook-secret'\cf6 \strokec6 ;\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // MIDDLEWARE\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
\cf2 \strokec2 // JWT Verification Middleware\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 const\cf4 \strokec4  \cf5 \strokec5 verifyToken\cf4 \strokec4  = \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 ,\cf12 \strokec12  next\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  token = req\cf6 \strokec6 .\cf4 \strokec4 headers\cf6 \strokec6 .\cf4 \strokec4 authorization?.\cf5 \strokec5 split\cf6 \strokec6 (\cf7 \strokec7 ' '\cf6 \strokec6 )[\cf9 \strokec9 1\cf6 \strokec6 ];\cf4 \strokec4 \
  \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 !token\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf4 \strokec4  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 401\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'No token provided'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
\
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  decoded = jwt\cf6 \strokec6 .\cf5 \strokec5 verify\cf6 \strokec6 (\cf4 \strokec4 token\cf6 \strokec6 ,\cf4 \strokec4  \cf9 \strokec9 JWT_SECRET\cf6 \strokec6 );\cf4 \strokec4 \
    req\cf6 \strokec6 .\cf4 \strokec4 userId = decoded\cf6 \strokec6 .\cf4 \strokec4 sub\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf5 \strokec5 next\cf6 \strokec6 ();\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 401\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Invalid token'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \};\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // WhatsApp Webhook Verification\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 const\cf4 \strokec4  \cf5 \strokec5 verifyWebhook\cf4 \strokec4  = \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 ,\cf12 \strokec12  next\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  signature = req\cf6 \strokec6 .\cf4 \strokec4 headers\cf6 \strokec6 [\cf7 \strokec7 'x-hub-signature-256'\cf6 \strokec6 ];\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  body = req\cf6 \strokec6 .\cf4 \strokec4 rawBody || \cf10 \strokec10 JSON\cf6 \strokec6 .\cf5 \strokec5 stringify\cf6 \strokec6 (\cf4 \strokec4 req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 );\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  hash = crypto\cf6 \strokec6 .\cf5 \strokec5 createHmac\cf6 \strokec6 (\cf7 \strokec7 'sha256'\cf6 \strokec6 ,\cf4 \strokec4  \cf9 \strokec9 WEBHOOK_SECRET\cf6 \strokec6 ).\cf5 \strokec5 update\cf6 \strokec6 (\cf4 \strokec4 body\cf6 \strokec6 ).\cf5 \strokec5 digest\cf6 \strokec6 (\cf7 \strokec7 'hex'\cf6 \strokec6 );\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  expected = \cf7 \strokec7 `sha256=\cf6 \strokec6 $\{\cf7 \strokec7 hash\cf6 \strokec6 \}\cf7 \strokec7 `\cf6 \strokec6 ;\cf4 \strokec4 \
\
  \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 signature === expected\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf5 \strokec5 next\cf6 \strokec6 ();\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 else\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 401\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Webhook signature mismatch'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \};\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // AUTHENTICATION ENDPOINTS\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
\cf2 \strokec2 // POST /api/auth/register\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 post\cf6 \strokec6 (\cf7 \strokec7 '/api/auth/register'\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  email\cf6 \strokec6 ,\cf4 \strokec4  password\cf6 \strokec6 ,\cf4 \strokec4  full_name\cf6 \strokec6 ,\cf4 \strokec4  phone_number \cf6 \strokec6 \}\cf4 \strokec4  = req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 !email || !password\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf4 \strokec4  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 400\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Email and password required'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  hashedPassword = \cf8 \strokec8 await\cf4 \strokec4  bcrypt\cf6 \strokec6 .\cf5 \strokec5 hash\cf6 \strokec6 (\cf4 \strokec4 password\cf6 \strokec6 ,\cf4 \strokec4  \cf9 \strokec9 10\cf6 \strokec6 );\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  whatsappToken = crypto\cf6 \strokec6 .\cf5 \strokec5 randomBytes\cf6 \strokec6 (\cf9 \strokec9 32\cf6 \strokec6 ).\cf5 \strokec5 toString\cf6 \strokec6 (\cf7 \strokec7 'hex'\cf6 \strokec6 );\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'users'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 insert\cf6 \strokec6 ([\{\cf4 \strokec4  email\cf6 \strokec6 ,\cf4 \strokec4  full_name\cf6 \strokec6 ,\cf4 \strokec4  phone_number\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 whatsapp_webhook_token\cf4 \strokec4 : whatsappToken \cf6 \strokec6 \}])\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf4 \strokec4  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 400\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : error\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  token = jwt\cf6 \strokec6 .\cf5 \strokec5 sign\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 sub\cf4 \strokec4 : data\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ].\cf4 \strokec4 id\cf6 \strokec6 ,\cf4 \strokec4  email \cf6 \strokec6 \},\cf4 \strokec4  \cf9 \strokec9 JWT_SECRET\cf6 \strokec6 ,\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 expiresIn\cf4 \strokec4 : \cf7 \strokec7 '7d'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 user\cf4 \strokec4 : data\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ],\cf4 \strokec4  token\cf6 \strokec6 ,\cf4 \strokec4  whatsappToken \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // POST /api/auth/login\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 post\cf6 \strokec6 (\cf7 \strokec7 '/api/auth/login'\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  email\cf6 \strokec6 ,\cf4 \strokec4  password \cf6 \strokec6 \}\cf4 \strokec4  = req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 !email || !password\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf4 \strokec4  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 400\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Email and password required'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'users'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 '*'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'email'\cf6 \strokec6 ,\cf4 \strokec4  email\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 single\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error || !data\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf4 \strokec4  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 401\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Invalid credentials'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  validPassword = \cf8 \strokec8 await\cf4 \strokec4  bcrypt\cf6 \strokec6 .\cf5 \strokec5 compare\cf6 \strokec6 (\cf4 \strokec4 password\cf6 \strokec6 ,\cf4 \strokec4  data\cf6 \strokec6 .\cf4 \strokec4 password_hash || \cf7 \strokec7 ''\cf6 \strokec6 );\cf4 \strokec4 \
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 !validPassword\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf4 \strokec4  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 401\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Invalid credentials'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  token = jwt\cf6 \strokec6 .\cf5 \strokec5 sign\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 sub\cf4 \strokec4 : data\cf6 \strokec6 .\cf4 \strokec4 id\cf6 \strokec6 ,\cf4 \strokec4  email \cf6 \strokec6 \},\cf4 \strokec4  \cf9 \strokec9 JWT_SECRET\cf6 \strokec6 ,\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 expiresIn\cf4 \strokec4 : \cf7 \strokec7 '7d'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 user\cf4 \strokec4 : data\cf6 \strokec6 ,\cf4 \strokec4  token \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // PROPERTIES ENDPOINTS\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
\cf2 \strokec2 // GET /api/properties\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 get\cf6 \strokec6 (\cf7 \strokec7 '/api/properties'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'properties'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 '*'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'user_id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 userId\cf6 \strokec6 );\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 );\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // POST /api/properties\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 post\cf6 \strokec6 (\cf7 \strokec7 '/api/properties'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  property_name\cf6 \strokec6 ,\cf4 \strokec4  property_type\cf6 \strokec6 ,\cf4 \strokec4  address\cf6 \strokec6 ,\cf4 \strokec4  flat_number\cf6 \strokec6 ,\cf4 \strokec4  area_sqft \cf6 \strokec6 \}\cf4 \strokec4  = req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'properties'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 insert\cf6 \strokec6 ([\{\cf4 \strokec4  \cf11 \strokec11 user_id\cf4 \strokec4 : req\cf6 \strokec6 .\cf4 \strokec4 userId\cf6 \strokec6 ,\cf4 \strokec4  property_name\cf6 \strokec6 ,\cf4 \strokec4  property_type\cf6 \strokec6 ,\cf4 \strokec4  address\cf6 \strokec6 ,\cf4 \strokec4  flat_number\cf6 \strokec6 ,\cf4 \strokec4  area_sqft \cf6 \strokec6 \}])\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 201\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ]);\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // GET /api/properties/:id\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 get\cf6 \strokec6 (\cf7 \strokec7 '/api/properties/:id'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'properties'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 '*'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 id\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'user_id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 userId\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 single\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error || !data\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf4 \strokec4  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 404\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Property not found'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 );\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // PATCH /api/properties/:id\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 patch\cf6 \strokec6 (\cf7 \strokec7 '/api/properties/:id'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'properties'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 update\cf6 \strokec6 (\cf4 \strokec4 req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 id\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'user_id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 userId\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error || !data\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ]);\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // MORTGAGES ENDPOINTS\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
\cf2 \strokec2 // POST /api/mortgages\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 post\cf6 \strokec6 (\cf7 \strokec7 '/api/mortgages'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  property_id\cf6 \strokec6 ,\cf4 \strokec4  bank_name\cf6 \strokec6 ,\cf4 \strokec4  loan_amount\cf6 \strokec6 ,\cf4 \strokec4  emi_amount\cf6 \strokec6 ,\cf4 \strokec4  tenure_months\cf6 \strokec6 ,\cf4 \strokec4  rate_of_interest\cf6 \strokec6 ,\cf4 \strokec4  document_url \cf6 \strokec6 \}\cf4 \strokec4  = req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'mortgages'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 insert\cf6 \strokec6 ([\{\cf4 \strokec4  property_id\cf6 \strokec6 ,\cf4 \strokec4  bank_name\cf6 \strokec6 ,\cf4 \strokec4  loan_amount\cf6 \strokec6 ,\cf4 \strokec4  emi_amount\cf6 \strokec6 ,\cf4 \strokec4  tenure_months\cf6 \strokec6 ,\cf4 \strokec4  rate_of_interest\cf6 \strokec6 ,\cf4 \strokec4  document_url\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 extraction_status\cf4 \strokec4 : \cf7 \strokec7 'pending'\cf4 \strokec4  \cf6 \strokec6 \}])\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 201\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ]);\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // GET /api/properties/:propertyId/mortgages\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 get\cf6 \strokec6 (\cf7 \strokec7 '/api/properties/:propertyId/mortgages'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'mortgages'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 '*'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'property_id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 propertyId\cf6 \strokec6 );\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 );\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // POST /api/mortgages/:id/extract (Trigger OCR)\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 post\cf6 \strokec6 (\cf7 \strokec7 '/api/mortgages/:id/extract'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  document_url \cf6 \strokec6 \}\cf4 \strokec4  = req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 !document_url\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf4 \strokec4  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 400\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Document URL required'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  request = \cf6 \strokec6 \{\cf4 \strokec4 \
      \cf11 \strokec11 requests\cf4 \strokec4 : \cf6 \strokec6 [\cf4 \strokec4 \
        \cf6 \strokec6 \{\cf4 \strokec4 \
          \cf11 \strokec11 image\cf4 \strokec4 : \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 source\cf4 \strokec4 : \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 imageUri\cf4 \strokec4 : document_url \cf6 \strokec6 \}\cf4 \strokec4  \cf6 \strokec6 \},\cf4 \strokec4 \
          \cf11 \strokec11 features\cf4 \strokec4 : \cf6 \strokec6 [\{\cf4 \strokec4  \cf11 \strokec11 type\cf4 \strokec4 : \cf7 \strokec7 'DOCUMENT_TEXT_DETECTION'\cf4 \strokec4  \cf6 \strokec6 \}],\cf4 \strokec4 \
        \cf6 \strokec6 \},\cf4 \strokec4 \
      \cf6 \strokec6 ],\cf4 \strokec4 \
    \cf6 \strokec6 \};\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  response = \cf8 \strokec8 await\cf4 \strokec4  visionClient\cf6 \strokec6 .\cf5 \strokec5 batchAnnotateImages\cf6 \strokec6 (\cf4 \strokec4 request\cf6 \strokec6 );\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  text = response\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ].\cf4 \strokec4 responses\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ].\cf4 \strokec4 fullTextAnnotation\cf6 \strokec6 .\cf4 \strokec4 text\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  extractedData = \cf5 \strokec5 parseMortgageText\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 );\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'mortgages'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 update\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 extracted_data\cf4 \strokec4 : extractedData\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 extraction_status\cf4 \strokec4 : \cf7 \strokec7 'completed'\cf4 \strokec4  \cf6 \strokec6 \})\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 id\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ]);\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // TENANTS ENDPOINTS\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
\cf2 \strokec2 // POST /api/tenants\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 post\cf6 \strokec6 (\cf7 \strokec7 '/api/tenants'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  property_id\cf6 \strokec6 ,\cf4 \strokec4  name\cf6 \strokec6 ,\cf4 \strokec4  age\cf6 \strokec6 ,\cf4 \strokec4  gender\cf6 \strokec6 ,\cf4 \strokec4  occupancy_type\cf6 \strokec6 ,\cf4 \strokec4  pancard\cf6 \strokec6 ,\cf4 \strokec4  aadhar_number\cf6 \strokec6 ,\cf4 \strokec4  address\cf6 \strokec6 ,\cf4 \strokec4  email\cf6 \strokec6 ,\cf4 \strokec4  phone_number\cf6 \strokec6 ,\cf4 \strokec4  emergency_contact_name\cf6 \strokec6 ,\cf4 \strokec4  emergency_contact_number\cf6 \strokec6 ,\cf4 \strokec4  date_of_movein \cf6 \strokec6 \}\cf4 \strokec4  = req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'tenants'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 insert\cf6 \strokec6 ([\{\cf4 \strokec4  property_id\cf6 \strokec6 ,\cf4 \strokec4  name\cf6 \strokec6 ,\cf4 \strokec4  age\cf6 \strokec6 ,\cf4 \strokec4  gender\cf6 \strokec6 ,\cf4 \strokec4  occupancy_type\cf6 \strokec6 ,\cf4 \strokec4  pancard\cf6 \strokec6 ,\cf4 \strokec4  aadhar_number\cf6 \strokec6 ,\cf4 \strokec4  address\cf6 \strokec6 ,\cf4 \strokec4  email\cf6 \strokec6 ,\cf4 \strokec4  phone_number\cf6 \strokec6 ,\cf4 \strokec4  emergency_contact_name\cf6 \strokec6 ,\cf4 \strokec4  emergency_contact_number\cf6 \strokec6 ,\cf4 \strokec4  date_of_movein \cf6 \strokec6 \}])\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 201\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ]);\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // GET /api/properties/:propertyId/tenants\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 get\cf6 \strokec6 (\cf7 \strokec7 '/api/properties/:propertyId/tenants'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'tenants'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 '*'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'property_id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 propertyId\cf6 \strokec6 );\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 );\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // PATCH /api/tenants/:id\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 patch\cf6 \strokec6 (\cf7 \strokec7 '/api/tenants/:id'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'tenants'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 update\cf6 \strokec6 (\cf4 \strokec4 req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 id\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ]);\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // PAYMENT TRANSACTIONS ENDPOINTS\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
\cf2 \strokec2 // GET /api/properties/:propertyId/payments\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 get\cf6 \strokec6 (\cf7 \strokec7 '/api/properties/:propertyId/payments'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'payment_transactions'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 '*'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'property_id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 propertyId\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 order\cf6 \strokec6 (\cf7 \strokec7 'payment_date'\cf6 \strokec6 ,\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 ascending\cf4 \strokec4 : \cf9 \strokec9 false\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 );\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // POST /api/properties/:propertyId/payments (Manual entry)\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 post\cf6 \strokec6 (\cf7 \strokec7 '/api/properties/:propertyId/payments'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  tenant_id\cf6 \strokec6 ,\cf4 \strokec4  amount\cf6 \strokec6 ,\cf4 \strokec4  payment_date\cf6 \strokec6 ,\cf4 \strokec4  due_date\cf6 \strokec6 ,\cf4 \strokec4  payment_status\cf6 \strokec6 ,\cf4 \strokec4  source \cf6 \strokec6 \}\cf4 \strokec4  = req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'payment_transactions'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 insert\cf6 \strokec6 ([\{\cf4 \strokec4  \cf11 \strokec11 property_id\cf4 \strokec4 : req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 propertyId\cf6 \strokec6 ,\cf4 \strokec4  tenant_id\cf6 \strokec6 ,\cf4 \strokec4  amount\cf6 \strokec6 ,\cf4 \strokec4  payment_date\cf6 \strokec6 ,\cf4 \strokec4  due_date\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 payment_status\cf4 \strokec4 : payment_status || \cf7 \strokec7 'pending'\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 source\cf4 \strokec4 : source || \cf7 \strokec7 'manual_entry'\cf4 \strokec4  \cf6 \strokec6 \}])\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 201\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ]);\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // GET /api/properties/:propertyId/cashflow (Monthly cashflow)\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 get\cf6 \strokec6 (\cf7 \strokec7 '/api/properties/:propertyId/cashflow'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 data\cf4 \strokec4 : mortgages\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : mortError \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'mortgages'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 'emi_amount'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'property_id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 propertyId\cf6 \strokec6 );\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 data\cf4 \strokec4 : payments\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : payError \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'payment_transactions'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 'amount'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'property_id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 params\cf6 \strokec6 .\cf4 \strokec4 propertyId\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'payment_status'\cf6 \strokec6 ,\cf4 \strokec4  \cf7 \strokec7 'reconciled'\cf6 \strokec6 );\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  totalEMI = mortgages?.\cf5 \strokec5 reduce\cf6 \strokec6 ((\cf12 \strokec12 sum\cf6 \strokec6 ,\cf12 \strokec12  m\cf6 \strokec6 )\cf4 \strokec4  => sum + \cf6 \strokec6 (\cf5 \strokec5 parseFloat\cf6 \strokec6 (\cf4 \strokec4 m\cf6 \strokec6 .\cf4 \strokec4 emi_amount\cf6 \strokec6 )\cf4 \strokec4  || \cf9 \strokec9 0\cf6 \strokec6 ),\cf4 \strokec4  \cf9 \strokec9 0\cf6 \strokec6 )\cf4 \strokec4  || \cf9 \strokec9 0\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  totalRent = payments?.\cf5 \strokec5 reduce\cf6 \strokec6 ((\cf12 \strokec12 sum\cf6 \strokec6 ,\cf12 \strokec12  p\cf6 \strokec6 )\cf4 \strokec4  => sum + \cf6 \strokec6 (\cf5 \strokec5 parseFloat\cf6 \strokec6 (\cf4 \strokec4 p\cf6 \strokec6 .\cf4 \strokec4 amount\cf6 \strokec6 )\cf4 \strokec4  || \cf9 \strokec9 0\cf6 \strokec6 ),\cf4 \strokec4  \cf9 \strokec9 0\cf6 \strokec6 )\cf4 \strokec4  || \cf9 \strokec9 0\cf6 \strokec6 ;\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  netCashflow = totalRent - totalEMI\cf6 \strokec6 ;\cf4 \strokec4 \
\
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  totalEMI\cf6 \strokec6 ,\cf4 \strokec4  totalRent\cf6 \strokec6 ,\cf4 \strokec4  netCashflow \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // WHATSAPP WEBHOOK (Payment Detection)\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
\cf2 \strokec2 // POST /api/webhooks/whatsapp\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 post\cf6 \strokec6 (\cf7 \strokec7 '/api/webhooks/whatsapp'\cf6 \strokec6 ,\cf4 \strokec4  verifyWebhook\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  object\cf6 \strokec6 ,\cf4 \strokec4  entry \cf6 \strokec6 \}\cf4 \strokec4  = req\cf6 \strokec6 .\cf4 \strokec4 body\cf6 \strokec6 ;\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 object !== \cf7 \strokec7 'whatsapp_business_account'\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
      \cf8 \strokec8 return\cf4 \strokec4  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 400\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Invalid webhook object'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
    \cf6 \strokec6 \}\cf4 \strokec4 \
\
    \cf8 \strokec8 for\cf4 \strokec4  \cf6 \strokec6 (\cf8 \strokec8 const\cf4 \strokec4  e \cf8 \strokec8 of\cf4 \strokec4  entry\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
      \cf8 \strokec8 for\cf4 \strokec4  \cf6 \strokec6 (\cf8 \strokec8 const\cf4 \strokec4  change \cf8 \strokec8 of\cf4 \strokec4  e\cf6 \strokec6 .\cf4 \strokec4 changes\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
        \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  value \cf6 \strokec6 \}\cf4 \strokec4  = change\cf6 \strokec6 ;\cf4 \strokec4 \
\
        \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 value\cf6 \strokec6 .\cf4 \strokec4 messages\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
          \cf8 \strokec8 for\cf4 \strokec4  \cf6 \strokec6 (\cf8 \strokec8 const\cf4 \strokec4  message \cf8 \strokec8 of\cf4 \strokec4  value\cf6 \strokec6 .\cf4 \strokec4 messages\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
            \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 message\cf6 \strokec6 .\cf4 \strokec4 type === \cf7 \strokec7 'image'\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
              \cf8 \strokec8 const\cf4 \strokec4  imageUrl = message\cf6 \strokec6 .\cf4 \strokec4 image\cf6 \strokec6 .\cf4 \strokec4 link\cf6 \strokec6 ;\cf4 \strokec4 \
              \cf8 \strokec8 const\cf4 \strokec4  senderPhone = message\cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 ;\cf4 \strokec4 \
\
              \cf8 \strokec8 const\cf4 \strokec4  ocrResult = \cf8 \strokec8 await\cf4 \strokec4  \cf5 \strokec5 extractPaymentFromScreenshot\cf6 \strokec6 (\cf4 \strokec4 imageUrl\cf6 \strokec6 );\cf4 \strokec4 \
\
              \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 data\cf4 \strokec4 : logData\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : logError \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
                \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'whatsapp_observer_log'\cf6 \strokec6 )\cf4 \strokec4 \
                \cf6 \strokec6 .\cf5 \strokec5 insert\cf6 \strokec6 ([\{\cf4 \strokec4 \
                  \cf11 \strokec11 tenant_phone_number\cf4 \strokec4 : senderPhone\cf6 \strokec6 ,\cf4 \strokec4 \
                  \cf11 \strokec11 screenshot_url\cf4 \strokec4 : imageUrl\cf6 \strokec6 ,\cf4 \strokec4 \
                  \cf11 \strokec11 ocr_result\cf4 \strokec4 : ocrResult\cf6 \strokec6 ,\cf4 \strokec4 \
                  \cf11 \strokec11 status\cf4 \strokec4 : ocrResult\cf6 \strokec6 .\cf4 \strokec4 amount ? \cf7 \strokec7 'matched'\cf4 \strokec4  : \cf7 \strokec7 'processing'\cf4 \strokec4 \
                \cf6 \strokec6 \}])\cf4 \strokec4 \
                \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 ();\cf4 \strokec4 \
\
              \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 ocrResult\cf6 \strokec6 .\cf4 \strokec4 amount\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
                \cf8 \strokec8 await\cf4 \strokec4  \cf5 \strokec5 matchPaymentToTransaction\cf6 \strokec6 (\cf4 \strokec4 senderPhone\cf6 \strokec6 ,\cf4 \strokec4  ocrResult\cf6 \strokec6 );\cf4 \strokec4 \
              \cf6 \strokec6 \}\cf4 \strokec4 \
            \cf6 \strokec6 \}\cf4 \strokec4 \
          \cf6 \strokec6 \}\cf4 \strokec4 \
        \cf6 \strokec6 \}\cf4 \strokec4 \
      \cf6 \strokec6 \}\cf4 \strokec4 \
    \cf6 \strokec6 \}\cf4 \strokec4 \
\
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 200\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 success\cf4 \strokec4 : \cf9 \strokec9 true\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf10 \strokec10 console\cf6 \strokec6 .\cf5 \strokec5 error\cf6 \strokec6 (\cf7 \strokec7 'Webhook error:'\cf6 \strokec6 ,\cf4 \strokec4  err\cf6 \strokec6 );\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // GET /api/webhooks/whatsapp (Webhook verification)\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 get\cf6 \strokec6 (\cf7 \strokec7 '/api/webhooks/whatsapp'\cf6 \strokec6 ,\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  verifyToken = process\cf6 \strokec6 .\cf4 \strokec4 env\cf6 \strokec6 .\cf9 \strokec9 WEBHOOK_VERIFY_TOKEN\cf4 \strokec4  || \cf7 \strokec7 'verify-token-123'\cf6 \strokec6 ;\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  challenge = req\cf6 \strokec6 .\cf4 \strokec4 query\cf6 \strokec6 [\cf7 \strokec7 'hub.challenge'\cf6 \strokec6 ];\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  token = req\cf6 \strokec6 .\cf4 \strokec4 query\cf6 \strokec6 [\cf7 \strokec7 'hub.verify_token'\cf6 \strokec6 ];\cf4 \strokec4 \
\
  \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 token === verifyToken\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 200\cf6 \strokec6 ).\cf5 \strokec5 send\cf6 \strokec6 (\cf4 \strokec4 challenge\cf6 \strokec6 );\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 else\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 403\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : \cf7 \strokec7 'Invalid verification token'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // HELPER FUNCTIONS\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 function\cf4 \strokec4  \cf5 \strokec5 parseMortgageText\cf6 \strokec6 (\cf12 \strokec12 text\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 return\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf11 \strokec11 loan_amount\cf4 \strokec4 : \cf5 \strokec5 extractNumber\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 ,\cf4 \strokec4  \cf13 \strokec13 /loan amount|amount financed|principal amount/i\cf6 \strokec6 ),\cf4 \strokec4 \
    \cf11 \strokec11 emi_amount\cf4 \strokec4 : \cf5 \strokec5 extractNumber\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 ,\cf4 \strokec4  \cf13 \strokec13 /emi|monthly installment|monthly payment/i\cf6 \strokec6 ),\cf4 \strokec4 \
    \cf11 \strokec11 tenure_months\cf4 \strokec4 : \cf5 \strokec5 extractNumber\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 ,\cf4 \strokec4  \cf13 \strokec13 /tenure|term|duration|months/i\cf6 \strokec6 ),\cf4 \strokec4 \
    \cf11 \strokec11 rate_of_interest\cf4 \strokec4 : \cf5 \strokec5 extractNumber\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 ,\cf4 \strokec4  \cf13 \strokec13 /rate of interest|interest rate|roi|rate|%/i\cf6 \strokec6 ),\cf4 \strokec4 \
  \cf6 \strokec6 \};\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \}\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 function\cf4 \strokec4  \cf5 \strokec5 parseAgreementText\cf6 \strokec6 (\cf12 \strokec12 text\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 return\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf11 \strokec11 rent_amount\cf4 \strokec4 : \cf5 \strokec5 extractNumber\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 ,\cf4 \strokec4  \cf13 \strokec13 /rent|monthly rent|rental/i\cf6 \strokec6 ),\cf4 \strokec4 \
    \cf11 \strokec11 maintenance_amount\cf4 \strokec4 : \cf5 \strokec5 extractNumber\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 ,\cf4 \strokec4  \cf13 \strokec13 /maintenance|maintenance charges|upkeep/i\cf6 \strokec6 ),\cf4 \strokec4 \
    \cf11 \strokec11 lease_duration_months\cf4 \strokec4 : \cf5 \strokec5 extractNumber\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 ,\cf4 \strokec4  \cf13 \strokec13 /lease|duration|term|months/i\cf6 \strokec6 ),\cf4 \strokec4 \
  \cf6 \strokec6 \};\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \}\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 function\cf4 \strokec4  \cf5 \strokec5 extractNumber\cf6 \strokec6 (\cf12 \strokec12 text\cf6 \strokec6 ,\cf12 \strokec12  pattern\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  match = text\cf6 \strokec6 .\cf5 \strokec5 match\cf6 \strokec6 (\cf4 \strokec4 pattern\cf6 \strokec6 );\cf4 \strokec4 \
  \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 !match\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf4 \strokec4  \cf8 \strokec8 null\cf6 \strokec6 ;\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  startPos = match\cf6 \strokec6 .\cf4 \strokec4 index\cf6 \strokec6 ;\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  substring = text\cf6 \strokec6 .\cf5 \strokec5 substring\cf6 \strokec6 (\cf4 \strokec4 startPos\cf6 \strokec6 ,\cf4 \strokec4  startPos + \cf9 \strokec9 100\cf6 \strokec6 );\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  numberMatch = substring\cf6 \strokec6 .\cf5 \strokec5 match\cf6 \strokec6 (\cf13 \strokec13 /[\\d,]+(?:\\.\\d\{2\})?/\cf6 \strokec6 );\cf4 \strokec4 \
  \cf8 \strokec8 return\cf4 \strokec4  numberMatch ? \cf5 \strokec5 parseFloat\cf6 \strokec6 (\cf4 \strokec4 numberMatch\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ].\cf5 \strokec5 replace\cf6 \strokec6 (\cf13 \strokec13 /,/g\cf6 \strokec6 ,\cf4 \strokec4  \cf7 \strokec7 ''\cf6 \strokec6 ))\cf4 \strokec4  : \cf8 \strokec8 null\cf6 \strokec6 ;\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \}\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 async\cf4 \strokec4  \cf8 \strokec8 function\cf4 \strokec4  \cf5 \strokec5 extractPaymentFromScreenshot\cf6 \strokec6 (\cf12 \strokec12 imageUrl\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  request = \cf6 \strokec6 \{\cf4 \strokec4 \
      \cf11 \strokec11 requests\cf4 \strokec4 : \cf6 \strokec6 [\{\cf4 \strokec4 \
        \cf11 \strokec11 image\cf4 \strokec4 : \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 source\cf4 \strokec4 : \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 imageUri\cf4 \strokec4 : imageUrl \cf6 \strokec6 \}\cf4 \strokec4  \cf6 \strokec6 \},\cf4 \strokec4 \
        \cf11 \strokec11 features\cf4 \strokec4 : \cf6 \strokec6 [\{\cf4 \strokec4  \cf11 \strokec11 type\cf4 \strokec4 : \cf7 \strokec7 'TEXT_DETECTION'\cf4 \strokec4  \cf6 \strokec6 \}],\cf4 \strokec4 \
      \cf6 \strokec6 \}],\cf4 \strokec4 \
    \cf6 \strokec6 \};\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  response = \cf8 \strokec8 await\cf4 \strokec4  visionClient\cf6 \strokec6 .\cf5 \strokec5 batchAnnotateImages\cf6 \strokec6 (\cf4 \strokec4 request\cf6 \strokec6 );\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  text = response\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ].\cf4 \strokec4 responses\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ].\cf4 \strokec4 fullTextAnnotation?.text || \cf7 \strokec7 ''\cf6 \strokec6 ;\cf4 \strokec4 \
\
    \cf8 \strokec8 return\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
      \cf11 \strokec11 amount\cf4 \strokec4 : \cf5 \strokec5 extractNumber\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 ,\cf4 \strokec4  \cf13 \strokec13 /\uc0\u8377 |amount|paid|trans|upi/i\cf6 \strokec6 ),\cf4 \strokec4 \
      \cf11 \strokec11 utr\cf4 \strokec4 : \cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 .\cf5 \strokec5 match\cf6 \strokec6 (\cf13 \strokec13 /UTR|utr|reference|ref\\s*[:#]?\\s*([A-Z0-9]\{12\})/i\cf6 \strokec6 )\cf4 \strokec4  || \cf6 \strokec6 [])[\cf9 \strokec9 1\cf6 \strokec6 ]\cf4 \strokec4  || \cf8 \strokec8 null\cf6 \strokec6 ,\cf4 \strokec4 \
      \cf11 \strokec11 date\cf4 \strokec4 : \cf5 \strokec5 extractDateFromText\cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 ),\cf4 \strokec4 \
      \cf11 \strokec11 payee\cf4 \strokec4 : \cf6 \strokec6 (\cf4 \strokec4 text\cf6 \strokec6 .\cf5 \strokec5 match\cf6 \strokec6 (\cf13 \strokec13 /payee|to|recipient|name.*?([A-Z][a-z]+)/i\cf6 \strokec6 )\cf4 \strokec4  || \cf6 \strokec6 [])[\cf9 \strokec9 1\cf6 \strokec6 ]\cf4 \strokec4  || \cf8 \strokec8 null\cf6 \strokec6 ,\cf4 \strokec4 \
    \cf6 \strokec6 \};\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf10 \strokec10 console\cf6 \strokec6 .\cf5 \strokec5 error\cf6 \strokec6 (\cf7 \strokec7 'OCR error:'\cf6 \strokec6 ,\cf4 \strokec4  err\cf6 \strokec6 );\cf4 \strokec4 \
    \cf8 \strokec8 return\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 amount\cf4 \strokec4 : \cf8 \strokec8 null\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 utr\cf4 \strokec4 : \cf8 \strokec8 null\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 date\cf4 \strokec4 : \cf8 \strokec8 null\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 payee\cf4 \strokec4 : \cf8 \strokec8 null\cf4 \strokec4  \cf6 \strokec6 \};\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \}\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 function\cf4 \strokec4  \cf5 \strokec5 extractDateFromText\cf6 \strokec6 (\cf12 \strokec12 text\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 const\cf4 \strokec4  dateMatch = text\cf6 \strokec6 .\cf5 \strokec5 match\cf6 \strokec6 (\cf13 \strokec13 /(\\d\{1,2\})[/-](\\d\{1,2\})[/-](\\d\{2,4\})/\cf6 \strokec6 );\cf4 \strokec4 \
  \cf8 \strokec8 return\cf4 \strokec4  dateMatch ? dateMatch\cf6 \strokec6 [\cf9 \strokec9 0\cf6 \strokec6 ]\cf4 \strokec4  : \cf8 \strokec8 null\cf6 \strokec6 ;\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \}\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 async\cf4 \strokec4  \cf8 \strokec8 function\cf4 \strokec4  \cf5 \strokec5 matchPaymentToTransaction\cf6 \strokec6 (\cf12 \strokec12 phoneNumber\cf6 \strokec6 ,\cf12 \strokec12  ocrResult\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 !ocrResult\cf6 \strokec6 .\cf4 \strokec4 amount\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf6 \strokec6 ;\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 data\cf4 \strokec4 : tenant\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : tenantError \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'tenants'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 'id, property_id'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'phone_number'\cf6 \strokec6 ,\cf4 \strokec4  phoneNumber\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 single\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 !tenant\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf6 \strokec6 ;\cf4 \strokec4 \
\
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 data\cf4 \strokec4 : transaction\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : transError \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'payment_transactions'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 '*'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'tenant_id'\cf6 \strokec6 ,\cf4 \strokec4  tenant\cf6 \strokec6 .\cf4 \strokec4 id\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'property_id'\cf6 \strokec6 ,\cf4 \strokec4  tenant\cf6 \strokec6 .\cf4 \strokec4 property_id\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'payment_status'\cf6 \strokec6 ,\cf4 \strokec4  \cf7 \strokec7 'pending'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 order\cf6 \strokec6 (\cf7 \strokec7 'created_at'\cf6 \strokec6 ,\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  \cf11 \strokec11 ascending\cf4 \strokec4 : \cf9 \strokec9 false\cf4 \strokec4  \cf6 \strokec6 \})\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 limit\cf6 \strokec6 (\cf9 \strokec9 1\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 single\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 !transaction\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 return\cf6 \strokec6 ;\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf10 \strokec10 Math\cf6 \strokec6 .\cf5 \strokec5 abs\cf6 \strokec6 (\cf5 \strokec5 parseFloat\cf6 \strokec6 (\cf4 \strokec4 transaction\cf6 \strokec6 .\cf4 \strokec4 amount\cf6 \strokec6 )\cf4 \strokec4  - ocrResult\cf6 \strokec6 .\cf4 \strokec4 amount\cf6 \strokec6 )\cf4 \strokec4  < \cf9 \strokec9 1\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
      \cf8 \strokec8 await\cf4 \strokec4  supabase\
        \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'payment_transactions'\cf6 \strokec6 )\cf4 \strokec4 \
        \cf6 \strokec6 .\cf5 \strokec5 update\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 payment_status\cf4 \strokec4 : \cf7 \strokec7 'reconciled'\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 utr_number\cf4 \strokec4 : ocrResult\cf6 \strokec6 .\cf4 \strokec4 utr\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 ocr_extracted_data\cf4 \strokec4 : ocrResult \cf6 \strokec6 \})\cf4 \strokec4 \
        \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'id'\cf6 \strokec6 ,\cf4 \strokec4  transaction\cf6 \strokec6 .\cf4 \strokec4 id\cf6 \strokec6 );\cf4 \strokec4 \
    \cf6 \strokec6 \}\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf10 \strokec10 console\cf6 \strokec6 .\cf5 \strokec5 error\cf6 \strokec6 (\cf7 \strokec7 'Match payment error:'\cf6 \strokec6 ,\cf4 \strokec4  err\cf6 \strokec6 );\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \}\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // UTILITY ENDPOINTS\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
app\cf6 \strokec6 .\cf5 \strokec5 get\cf6 \strokec6 (\cf7 \strokec7 '/health'\cf6 \strokec6 ,\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 status\cf4 \strokec4 : \cf7 \strokec7 'ok'\cf6 \strokec6 ,\cf4 \strokec4  \cf11 \strokec11 timestamp\cf4 \strokec4 : \cf8 \strokec8 new\cf4 \strokec4  \cf10 \strokec10 Date\cf6 \strokec6 ().\cf5 \strokec5 toISOString\cf6 \strokec6 ()\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
app\cf6 \strokec6 .\cf5 \strokec5 get\cf6 \strokec6 (\cf7 \strokec7 '/api/user'\cf6 \strokec6 ,\cf4 \strokec4  verifyToken\cf6 \strokec6 ,\cf4 \strokec4  \cf8 \strokec8 async\cf4 \strokec4  \cf6 \strokec6 (\cf12 \strokec12 req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf8 \strokec8 try\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    \cf8 \strokec8 const\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4  data\cf6 \strokec6 ,\cf4 \strokec4  error \cf6 \strokec6 \}\cf4 \strokec4  = \cf8 \strokec8 await\cf4 \strokec4  supabase\
      \cf6 \strokec6 .\cf8 \strokec8 from\cf6 \strokec6 (\cf7 \strokec7 'users'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 select\cf6 \strokec6 (\cf7 \strokec7 '*'\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 eq\cf6 \strokec6 (\cf7 \strokec7 'id'\cf6 \strokec6 ,\cf4 \strokec4  req\cf6 \strokec6 .\cf4 \strokec4 userId\cf6 \strokec6 )\cf4 \strokec4 \
      \cf6 \strokec6 .\cf5 \strokec5 single\cf6 \strokec6 ();\cf4 \strokec4 \
\
    \cf8 \strokec8 if\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 error\cf6 \strokec6 )\cf4 \strokec4  \cf8 \strokec8 throw\cf4 \strokec4  error\cf6 \strokec6 ;\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 json\cf6 \strokec6 (\cf4 \strokec4 data\cf6 \strokec6 );\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4  \cf8 \strokec8 catch\cf4 \strokec4  \cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 )\cf4 \strokec4  \cf6 \strokec6 \{\cf4 \strokec4 \
    res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message \cf6 \strokec6 \});\cf4 \strokec4 \
  \cf6 \strokec6 \}\cf4 \strokec4 \
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\cf2 \strokec2 // ERROR HANDLING & SERVER START\cf4 \strokec4 \
\cf2 \strokec2 // ============================================\cf4 \strokec4 \
\
app\cf6 \strokec6 .\cf5 \strokec5 use\cf6 \strokec6 ((\cf12 \strokec12 err\cf6 \strokec6 ,\cf12 \strokec12  req\cf6 \strokec6 ,\cf12 \strokec12  res\cf6 \strokec6 ,\cf12 \strokec12  next\cf6 \strokec6 )\cf4 \strokec4  => \cf6 \strokec6 \{\cf4 \strokec4 \
  \cf10 \strokec10 console\cf6 \strokec6 .\cf5 \strokec5 error\cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 );\cf4 \strokec4 \
  res\cf6 \strokec6 .\cf5 \strokec5 status\cf6 \strokec6 (\cf4 \strokec4 err\cf6 \strokec6 .\cf4 \strokec4 status || \cf9 \strokec9 500\cf6 \strokec6 ).\cf5 \strokec5 json\cf6 \strokec6 (\{\cf4 \strokec4  \cf11 \strokec11 error\cf4 \strokec4 : err\cf6 \strokec6 .\cf4 \strokec4 message || \cf7 \strokec7 'Internal server error'\cf4 \strokec4  \cf6 \strokec6 \});\cf4 \strokec4 \
\pard\pardeftab720\partightenfactor0
\cf6 \strokec6 \});\cf4 \strokec4 \
\
\pard\pardeftab720\partightenfactor0
\cf8 \strokec8 const\cf4 \strokec4  \cf9 \strokec9 PORT\cf4 \strokec4  = process\cf6 \strokec6 .\cf4 \strokec4 env\cf6 \strokec6 .\cf9 \strokec9 PORT\cf4 \strokec4  || \cf9 \strokec9 3000\cf6 \strokec6 ;\cf4 \strokec4 \
app\cf6 \strokec6 .\cf5 \strokec5 listen\cf6 \strokec6 (\cf9 \strokec9 PORT\cf6 \strokec6 ,\cf4 \strokec4  \cf6 \strokec6 ()\cf4 \strokec4  => \cf10 \strokec10 console\cf6 \strokec6 .\cf5 \strokec5 log\cf6 \strokec6 (\cf7 \strokec7 `Server running on port \cf6 \strokec6 $\{\cf9 \strokec9 PORT\cf6 \strokec6 \}\cf7 \strokec7 `\cf6 \strokec6 ));}