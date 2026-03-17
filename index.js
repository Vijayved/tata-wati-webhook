require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const OpenAI = require('openai');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3000;
const WATI_TOKEN = process.env.WATI_TOKEN;
const WATI_BASE_URL = process.env.WATI_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const TATA_SECRET = process.env.TATA_SECRET || 'tata_webhook_secret';
const HMAC_SECRET = process.env.HMAC_SECRET || 'your_hmac_secret_key';
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91';
const DEDUPE_WINDOW_MS = (parseInt(process.env.DEDUPE_WINDOW_SECONDS || '600', 10)) * 1000;
const TEMPLATE_NAME = process.env.MISSCALL_TEMPLATE_NAME || 'misscall_welcome_v3';
const LEAD_TEMPLATE_NAME = process.env.LEAD_TEMPLATE_NAME || 'lead_notification_v2';
const FOLLOWUP_TEMPLATE = process.env.FOLLOWUP_TEMPLATE || 'followup_template';
const CONFIRMATION_TEMPLATE = process.env.CONFIRMATION_TEMPLATE || 'confirmation_template';
const ASK_DATE_TEMPLATE = process.env.ASK_DATE_TEMPLATE || 'ask_date_template';

// OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Keep-alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://tata-wati-webhook.onrender.com';
if (SELF_URL) {
  setInterval(() => {
    axios.get(`${SELF_URL}/health`).catch(() => {});
  }, 14 * 60 * 1000);
}

if (!WATI_TOKEN || !WATI_BASE_URL) {
  console.error('❌ Missing WATI configuration in .env');
  process.exit(1);
}

// ============================================
// ✅ DATABASE CONNECTION
// ============================================
let db;
let processedCollection;
let patientsCollection;
let executivesCollection;
let missCallsCollection; // New collection for miss calls tracking

async function connectDB() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    console.log('MongoDB URI:', MONGODB_URI ? '✅ Present' : '❌ Missing');
    
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in environment variables');
    }
    
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ MongoDB connected successfully');
    
    db = client.db('executive_system');
    processedCollection = db.collection('processed_messages');
    patientsCollection = db.collection('patients');
    executivesCollection = db.collection('executives');
    missCallsCollection = db.collection('miss_calls'); // Track miss calls separately
    
    console.log('✅ Collections initialized:');
    console.log('   - patientsCollection:', patientsCollection ? '✅' : '❌');
    console.log('   - processedCollection:', processedCollection ? '✅' : '❌');
    console.log('   - missCallsCollection:', missCallsCollection ? '✅' : '❌');
    
    // Create indexes
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await patientsCollection.createIndex({ chatId: 1 }, { unique: true });
    await patientsCollection.createIndex({ patientPhone: 1, branch: 1, status: 1 });
    await patientsCollection.createIndex({ followupDate: 1 });
    await patientsCollection.createIndex({ createdAt: 1 });
    await patientsCollection.createIndex({ lastNotificationSentAt: 1 });
    await missCallsCollection.createIndex({ phoneNumber: 1, calledNumber: 1, createdAt: 1 });
    
    console.log('✅ Indexes created successfully');
    
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error DETAILS:', {
      message: error.message,
      name: error.name,
      code: error.code,
      stack: error.stack
    });
    throw error;
  }
}

// ============================================
// EXECUTIVE NUMBERS MAPPING
// ============================================
const EXECUTIVES = {
  'Naroda Team': process.env.NARODA_EXECUTIVE || '917880261858',
  'Usmanpura Team': process.env.USMANPURA_EXECUTIVE || '919825086011',
  'Vadaj Team': process.env.VADAJ_EXECUTIVE || '919825086011',
  'Satellite Team': process.env.SATELLITE_EXECUTIVE || '919825086011',
  'Manager': process.env.MANAGER_NUMBER || '919825086011'
};

// ============================================
// BRANCH CONFIGURATION
// ============================================
const BRANCHES = {
  [normalizeIndianNumber(process.env.NARODA_NUMBER || '07969690935')]: {
    name: 'Naroda',
    executive: EXECUTIVES['Naroda Team']
  },
  [normalizeIndianNumber(process.env.USMANPURA_NUMBER || '9898989897')]: {
    name: 'Usmanpura',
    executive: EXECUTIVES['Usmanpura Team']
  },
  [normalizeIndianNumber(process.env.VADAJ_NUMBER || '9898989896')]: {
    name: 'Vadaj',
    executive: EXECUTIVES['Vadaj Team']
  },
  [normalizeIndianNumber(process.env.SATELLITE_NUMBER || '9898989898')]: {
    name: 'Satellite',
    executive: EXECUTIVES['Satellite Team']
  },
  [normalizeIndianNumber('917969690935')]: {
    name: 'Test Branch',
    executive: '917880261858'
  }
};

// ============================================
// ✅ IN-MEMORY STORAGE
// ============================================
const recentMissCalls = new Map();

// ============================================
// ✅ TOKEN GENERATION (HMAC)
// ============================================
function generateToken(chatId) {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(chatId)
    .digest('hex');
}

function verifyToken(chatId, token) {
  const expectedToken = generateToken(chatId);
  return token === expectedToken;
}

// ============================================
// ✅ TIMEOUT HANDLER
// ============================================
function timeout(ms) {
  return new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  );
}

// ============================================
// ✅ RETRY MECHANISM WITH TIMEOUT
// ============================================
async function retryWithTimeout(fn, timeoutMs = 5000, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await Promise.race([
        fn(),
        timeout(timeoutMs)
      ]);
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`⚠️ Retry ${i + 1}/${retries} failed: ${error.message}`);
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
    }
  }
}

// ============================================
// ✅ RATE LIMIT DELAY
// ============================================
async function rateLimitDelay() {
  await new Promise(r => setTimeout(r, 300));
}

// ============================================
// ✅ PARSE DATE FUNCTION
// ============================================
function parseDate(text) {
  try {
    const [d, m, y] = text.split('/');
    const date = new Date(`${y}-${m}-${d}`);
    if (isNaN(date.getTime())) return null;
    return date;
  } catch {
    return null;
  }
}

// ============================================
// ✅ UPDATED HELPER FUNCTIONS FOR TATA TELE
// ============================================
function normalizeIndianNumber(number) {
  if (!number) return '';
  let digits = String(number).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  if (digits.length === 12) {
    if (digits.startsWith('91')) return digits;
    return '91' + digits.slice(-10);
  }
  if (digits.length > 12) return digits.slice(-12);
  return '';
}

function normalizeWhatsAppNumber(number) {
  const normalized = normalizeIndianNumber(number);
  return normalized || '';
}

function getBranchByCalledNumber(calledNumber) {
  const normalized = normalizeIndianNumber(calledNumber);
  return BRANCHES[normalized] || {
    name: 'Main Branch',
    executive: process.env.DEFAULT_EXECUTIVE || '917880261858'
  };
}

function shouldSkipDuplicateMissCall(whatsappNumber, calledNumber) {
  const key = `${whatsappNumber}_${normalizeIndianNumber(calledNumber)}`;
  const now = Date.now();
  const lastHit = recentMissCalls.get(key);
  if (lastHit && (now - lastHit) < DEDUPE_WINDOW_MS) return true;
  recentMissCalls.set(key, now);
  return false;
}

function getCallerNumberFromPayload(body) {
  return body.caller_id_number || 
         body["customer_no_with_prefix "] || 
         body.customer_number_with_prefix ||
         body.cli || 
         body.msisdn || 
         body.mobile || 
         body.caller_number || 
         body.from || 
         body.customer_number ||
         '';
}

function getCalledNumberFromPayload(body) {
  return body.call_to_number || 
         body.called_number || 
         body.to || 
         body.destination || 
         body.did || 
         body.virtual_number || 
         '';
}

// ✅ Check if message is already processed
async function isMessageProcessed(messageId) {
  if (!processedCollection) {
    console.error('❌ processedCollection is undefined in isMessageProcessed');
    return false;
  }
  const processed = await processedCollection.findOne({ messageId });
  return !!processed;
}

// ✅ Mark message as processed (atomic)
async function markMessageProcessed(messageId) {
  if (!processedCollection) {
    console.error('❌ processedCollection is undefined in markMessageProcessed');
    return;
  }
  await processedCollection.insertOne({ messageId, processedAt: new Date() });
}

// ✅ Get priority based on tests
function getPriority(testNames) {
  const tests = testNames.toLowerCase();
  if (tests.includes('mri') || tests.includes('ct') || tests.includes('emergency')) {
    return 'high';
  }
  if (tests.includes('blood') || tests.includes('x-ray')) {
    return 'medium';
  }
  return 'low';
}

// ✅ Safe JSON parse for OpenAI response
function safeJSONParse(content) {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { patientName: 'Not found', tests: 'Not found' };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      patientName: parsed.patientName || 'Not found',
      tests: parsed.tests || 'Not found'
    };
  } catch {
    return { patientName: 'Not found', tests: 'Not found' };
  }
}

// ============================================
// ✅ WATI TEMPLATE SENDER
// ============================================
async function sendWatiTemplateMessage(whatsappNumber, templateName, parameters) {
  try {
    console.log(`📱 Sending template ${templateName} to ${whatsappNumber}`);
    
    const payload = {
      template_name: templateName,
      broadcast_name: `msg_${Date.now()}`,
      parameters: parameters || []
    };
    
    const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
    
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `${WATI_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    
    console.log(`✅ Template sent successfully`);
    return response.data;
  } catch (error) {
    console.error('❌ Template send failed:', error.response?.data || error.message);
    throw error;
  }
}

// ============================================
// ✅ LEAD NOTIFICATION
// ============================================
async function sendLeadNotification(
  executiveNumber, 
  patientName, 
  patientPhone, 
  branch, 
  testNames, 
  sourceType, 
  chatId
) {
  const safePatientName = patientName || "Unknown Patient";
  const safeTestNames = testNames || "Not specified";
  const safeSourceType = sourceType.replace(/[📝📸]/g, '').trim();
  
  const parameters = [
    { name: "1", value: safePatientName },
    { name: "2", value: patientPhone },
    { name: "3", value: branch },
    { name: "4", value: safeTestNames },
    { name: "5", value: safeSourceType },
    { name: "6", value: `${SELF_URL}/connect-chat/${chatId}?token=${generateToken(chatId)}` }
  ];
  
  return await sendWatiTemplateMessage(executiveNumber, LEAD_TEMPLATE_NAME, parameters);
}

// ============================================
// ✅ ATOMIC LEAD CREATION
// ============================================
async function createOrUpdateLead(chatId, patientName, patientPhone, branch, testNames, sourceType, executiveNumber, priority, imageUrl = null) {
  if (!patientsCollection) {
    console.error('❌ patientsCollection is undefined in createOrUpdateLead');
    return false;
  }
  
  const now = new Date();
  
  const result = await patientsCollection.updateOne(
    { 
      patientPhone, 
      branch, 
      status: { $in: ['pending', 'waiting'] } 
    },
    {
      $setOnInsert: {
        chatId,
        patientName,
        patientPhone,
        branch,
        testNames,
        sourceType,
        executiveNumber,
        priority,
        status: 'pending',
        lastNotificationSentAt: null,
        followupDate: null,
        createdAt: now,
        updatedAt: now,
        missCallTime: sourceType === 'Miss Call' ? now : null
      },
      $set: imageUrl ? { imageUrl, updatedAt: now } : { updatedAt: now }
    },
    { upsert: true }
  );
  
  return result.upsertedCount > 0;
}

// ============================================
// ✅ PROCESS MANUAL ENTRY
// ============================================
async function processManualEntry(messageId, patientName, testNames, branch, patientPhone) {
  console.log(`\n📝 Processing manual entry`);
  
  const executiveNumber = getExecutiveNumber(branch);
  const priority = getPriority(testNames);
  const chatId = `${patientPhone}_${branch}`;
  
  await markMessageProcessed(messageId);
  
  const isNew = await createOrUpdateLead(
    chatId, patientName, patientPhone, branch, testNames, 'Manual', 
    executiveNumber, priority
  );
  
  if (isNew) {
    await retryWithTimeout(() => sendLeadNotification(
      executiveNumber, patientName, patientPhone, branch, testNames, "Manual", chatId
    ), 5000, 3);
  } else {
    console.log(`ℹ️ Lead already exists, skipping notification`);
  }
}

// ============================================
// ✅ PROCESS IMAGE UPLOAD
// ============================================
async function processImageUpload(messageId, patientName, branch, imageUrl, patientPhone) {
  console.log(`\n📸 Processing image upload`);
  
  const executiveNumber = getExecutiveNumber(branch);
  const chatId = `${patientPhone}_${branch}`;
  
  await markMessageProcessed(messageId);
  
  const extracted = await retryWithTimeout(() => extractWithOpenAI(imageUrl), 10000, 2);
  console.log(`✅ OCR: ${extracted.patientName} - ${extracted.tests}`);
  
  const priority = getPriority(extracted.tests);
  
  const isNew = await createOrUpdateLead(
    chatId, patientName, patientPhone, branch, extracted.tests, 'Upload',
    executiveNumber, priority, imageUrl
  );
  
  if (isNew) {
    await retryWithTimeout(() => sendLeadNotification(
      executiveNumber, extracted.patientName, patientPhone, branch, extracted.tests, "Upload", chatId
    ), 5000, 3);
  }
}

function getExecutiveNumber(branch) {
  const teamName = `${branch} Team`;
  return EXECUTIVES[teamName] || process.env.DEFAULT_EXECUTIVE || '917880261858';
}

// ============================================
// ✅ OPENAI OCR WITH TIMEOUT
// ============================================
async function extractWithOpenAI(imageUrl) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Extract patient name and tests from this medical prescription. Return JSON with keys: patientName, tests`
          },
          {
            type: "image_url",
            image_url: { url: imageUrl }
          }
        ]
      }
    ],
    max_tokens: 300
  });
  
  const content = response.choices[0].message.content;
  return safeJSONParse(content);
}

// ============================================
// ✅ WATI WEBHOOK ENDPOINT
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    if (req.headers['authorization'] !== `Bearer ${WATI_TOKEN}`) {
      console.log('⚠️ Unauthorized webhook attempt');
      return res.sendStatus(403);
    }
    
    console.log('📨 WATI Webhook:', JSON.stringify(req.body, null, 2));
    
    const msg = req.body;
    const msgId = msg.id || msg.messageId || msg._id;
    
    if (!msgId) {
      return res.sendStatus(200);
    }
    
    if (await isMessageProcessed(msgId)) {
      console.log(`⏭️ Message ${msgId} already processed`);
      return res.sendStatus(200);
    }
    
    const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
    if (!patientPhone) {
      return res.sendStatus(200);
    }
    
    // Try to get branch from message or default to Naroda
    let branch = 'Naroda';
    // Check if branch was selected in chat
    if (msg.text && msg.text.toLowerCase().includes('naroda')) {
      branch = 'Naroda';
    } else if (msg.text && msg.text.toLowerCase().includes('usmanpura')) {
      branch = 'Usmanpura';
    } else if (msg.text && msg.text.toLowerCase().includes('vadaj')) {
      branch = 'Vadaj';
    } else if (msg.text && msg.text.toLowerCase().includes('satellite')) {
      branch = 'Satellite';
    }
    
    if (msg.type === 'text' || msg.messageType === 'text') {
      const text = msg.text || msg.body || '';
      const lowerText = text.toLowerCase();
      
      if (lowerText.includes('manual') || lowerText.includes('test')) {
        await processManualEntry(msgId, 'Patient', text, branch, patientPhone);
      }
      else if (msg.buttonText || msg.button) {
        const action = msg.buttonText || msg.button;
        const chatId = `${patientPhone}_${branch}`;
        
        if (action === '✅ Convert Done') {
          await patientsCollection.updateOne(
            { chatId },
            { $set: { status: 'converted', updatedAt: new Date() } }
          );
          
          await sendWatiTemplateMessage(
            patientPhone,
            CONFIRMATION_TEMPLATE,
            [{ name: "1", value: "✅ Patient marked as converted" }]
          );
        }
        else if (action === '⏳ Waiting') {
          await sendWatiTemplateMessage(
            patientPhone,
            ASK_DATE_TEMPLATE,
            [{ name: "1", value: "Please send follow-up date (DD/MM/YYYY)" }]
          );
          
          await patientsCollection.updateOne(
            { chatId },
            { $set: { awaiting_followup: true } }
          );
        }
        else if (action === '❌ Not Convert') {
          await patientsCollection.updateOne(
            { chatId },
            { $set: { status: 'not_converted', updatedAt: new Date() } }
          );
          
          await sendLeadNotification(
            EXECUTIVES['Manager'],
            'Escalation Alert',
            EXECUTIVES['Manager'],
            'ALL',
            'Not Converted',
            `escalation-${Date.now()}`,
            chatId
          );
        }
      }
    }
    else if (msg.type === 'image' || msg.messageType === 'image') {
      const imageUrl = msg.mediaUrl || msg.url || msg.image?.url;
      if (imageUrl) {
        await processImageUpload(msgId, 'Patient', branch, imageUrl, patientPhone);
      }
    }
    else {
      await markMessageProcessed(msgId);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    res.sendStatus(200);
  }
});

// ============================================
// ✅ FOLLOW-UP DATE HANDLER
// ============================================
app.post('/webhook/followup-date', async (req, res) => {
  try {
    const { patientPhone, followupDate, branch } = req.body;
    const chatId = `${patientPhone}_${branch}`;
    
    const date = parseDate(followupDate);
    if (!date) {
      return res.status(400).json({ error: 'Invalid date format. Use DD/MM/YYYY' });
    }
    
    await patientsCollection.updateOne(
      { chatId },
      { 
        $set: { 
          followupDate: date,
          status: 'waiting',
          awaiting_followup: false,
          updatedAt: new Date()
        }
      }
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ CRON JOB (FALLBACK)
// ============================================
cron.schedule('*/5 * * * *', async () => {
  console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Fallback check for missed messages...`);
  
  try {
    const from = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const to = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    let url;
    if (WATI_BASE_URL.includes('/api/v1')) {
      url = `${WATI_BASE_URL}/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
    } else {
      url = `${WATI_BASE_URL}/api/v1/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
    }
    
    console.log('🔍 Fetching messages from:', url);
    
    const response = await axios.get(url, {
      headers: { Authorization: `${WATI_TOKEN}` }
    });
    
    let messages = [];
    if (Array.isArray(response.data)) messages = response.data;
    else if (response.data?.messages) messages = response.data.messages;
    else if (response.data?.data) messages = response.data.data;
    
    console.log(`📨 Found ${messages.length} messages`);
    
    for (const msg of messages) {
      await rateLimitDelay();
      
      const msgId = msg.id || msg.messageId || msg._id;
      if (!msgId || await isMessageProcessed(msgId)) continue;
      
      const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
      if (!patientPhone) continue;
      
      const branch = 'Naroda';
      
      if (msg.type === 'text' || msg.messageType === 'text') {
        const text = msg.text || msg.body || '';
        if (text.toLowerCase().includes('manual') || text.toLowerCase().includes('test')) {
          await processManualEntry(msgId, 'Patient', text, branch, patientPhone);
        } else {
          await markMessageProcessed(msgId);
        }
      }
      else if (msg.type === 'image' || msg.messageType === 'image') {
        const imageUrl = msg.mediaUrl || msg.url || msg.image?.url;
        if (imageUrl) {
          await processImageUpload(msgId, 'Patient', branch, imageUrl, patientPhone);
        } else {
          await markMessageProcessed(msgId);
        }
      } else {
        await markMessageProcessed(msgId);
      }
    }
  } catch (error) {
    console.error('❌ Fallback cron error:', error.response?.status ? 
      `Status ${error.response.status}: ${error.response.data}` : error.message);
  }
});

// ============================================
// ✅ AUTO FOLLOW-UP
// ============================================
cron.schedule('*/30 * * * *', async () => {
  console.log('⏰ Checking for pending leads...');
  
  if (!patientsCollection) {
    console.error('❌ patientsCollection is undefined in follow-up cron');
    return;
  }
  
  try {
    const pendingLeads = await patientsCollection.find({
      status: 'waiting',
      followupDate: { $lt: new Date() },
      $or: [
        { lastNotificationSentAt: null },
        { lastNotificationSentAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
      ]
    }).toArray();
    
    console.log(`📊 Found ${pendingLeads.length} pending leads for follow-up`);
    
    for (const lead of pendingLeads) {
      await sendLeadNotification(
        lead.executiveNumber,
        lead.patientName,
        lead.patientPhone,
        lead.branch,
        lead.testNames || lead.tests || 'Follow-up',
        '⏰ Follow-up Reminder',
        lead.chatId
      );
      
      await patientsCollection.updateOne(
        { _id: lead._id },
        { $set: { lastNotificationSentAt: new Date() } }
      );
    }
  } catch (error) {
    console.error('❌ Follow-up cron error:', error.message);
  }
});

// ============================================
// ✅ MANAGER ESCALATION
// ============================================
cron.schedule('0 21 * * *', async () => {
  if (!patientsCollection) {
    console.error('❌ patientsCollection is undefined in manager escalation');
    return;
  }
  
  try {
    const notConverted = await patientsCollection.find({
      status: 'not_converted',
      createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }).toArray();
    
    if (notConverted.length > 0) {
      const summary = notConverted.map(p => 
        `❌ ${p.patientName} (${p.branch})`
      ).join('\n');
      
      await sendLeadNotification(
        EXECUTIVES['Manager'],
        'Daily Escalation Summary',
        EXECUTIVES['Manager'],
        'ALL',
        `${notConverted.length} leads not converted today`,
        '📊 Summary',
        `summary-${Date.now()}`
      );
    }
  } catch (error) {
    console.error('❌ Manager escalation error:', error.message);
  }
});

// ============================================
// ✅ EXECUTIVE DASHBOARD
// ============================================
app.get('/connect-chat/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { token } = req.query;
  
  if (!verifyToken(chatId, token)) {
    return res.status(403).send(`
      <html>
        <head><title>Unauthorized</title></head>
        <body style="font-family: Arial; padding: 30px;">
          <h2>🔒 Unauthorized Access</h2>
          <p>Invalid access token</p>
        </body>
      </html>
    `);
  }
  
  if (!patientsCollection) {
    return res.status(500).send('<h2>❌ Database not initialized</h2>');
  }
  
  const patient = await patientsCollection.findOne({ chatId });
  
  if (!patient) {
    return res.send('<h2>❌ Patient not found</h2>');
  }
  
  res.send(`
    <html>
      <head>
        <title>Patient Details</title>
        <style>
          body { font-family: Arial; padding: 20px; background: #f5f5f5; }
          .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
          .priority-high { border-left: 4px solid #dc3545; }
          .priority-medium { border-left: 4px solid #ffc107; }
          .priority-low { border-left: 4px solid #28a745; }
          .detail-row { margin: 15px 0; padding: 10px; background: #f8f9fa; border-radius: 5px; }
          .whatsapp-btn { display: inline-block; background: #25D366; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .btn-group { margin-top: 30px; display: flex; gap: 10px; flex-wrap: wrap; }
          .btn { padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
          .btn-convert { background: #28a745; color: white; }
          .btn-waiting { background: #ffc107; color: black; }
          .btn-notconvert { background: #dc3545; color: white; }
        </style>
      </head>
      <body>
        <div class="container priority-${patient.priority || 'low'}">
          <h1>👤 Patient Details</h1>
          
          <div class="detail-row">
            <strong>Patient:</strong> ${patient.patientName || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Phone:</strong> ${patient.patientPhone || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Branch:</strong> ${patient.branch || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Tests:</strong> ${patient.testNames || patient.tests || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Source:</strong> ${patient.sourceType || patient.entryType || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Priority:</strong> ${patient.priority || 'low'}
          </div>
          <div class="detail-row">
            <strong>Status:</strong> ${patient.status || 'pending'}
          </div>
          <div class="detail-row">
            <strong>Miss Call Time:</strong> ${patient.missCallTime ? new Date(patient.missCallTime).toLocaleString() : 'N/A'}
          </div>
          
          ${patient.imageUrl ? `
            <div class="detail-row">
              <h3>📄 Prescription</h3>
              <iframe src="${patient.imageUrl}" style="width:100%; height:300px;"></iframe>
            </div>
          ` : ''}
          
          <a href="https://wa.me/${patient.patientPhone}" target="_blank" class="whatsapp-btn">
            💬 Chat on WhatsApp
          </a>
          
          <div class="btn-group">
            <button class="btn btn-convert" onclick="updateStatus('convert')">✅ Convert</button>
            <button class="btn btn-waiting" onclick="updateStatus('waiting')">⏳ Waiting</button>
            <button class="btn btn-notconvert" onclick="updateStatus('notconvert')">❌ Not Convert</button>
          </div>
        </div>
        
        <script>
          function updateStatus(action) {
            fetch('/exec-action?action=' + action + '&chat=${patient.chatId}')
              .then(response => response.text())
              .then(data => alert(data));
          }
        </script>
      </body>
    </html>
  `);
});

// ============================================
// ✅ EXECUTIVE ACTION HANDLER
// ============================================
app.get('/exec-action', async (req, res) => {
  const { action, chat } = req.query;
  
  const status = 
    action === 'convert' ? 'converted' :
    action === 'waiting' ? 'waiting' : 'not_converted';
  
  await patientsCollection.updateOne(
    { chatId: chat },
    { $set: { status, updatedAt: new Date() } }
  );
  
  res.send(`✅ Patient marked as ${status}`);
});

// ============================================
// ✅ UPDATED TATA TELE WEBHOOK - With Database Save
// ============================================
app.post('/tata-misscall-whatsapp', async (req, res) => {
  try {
    // Log everything
    console.log('='.repeat(60));
    console.log('📞 TATA TELE WEBBOOK RECEIVED');
    console.log('📦 Headers:', JSON.stringify(req.headers, null, 2));
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    
    // Verify API key
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.TATA_SECRET) {
      console.log('❌ Unauthorized - Invalid API Key:', apiKey);
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Get caller number from all possible fields
    const callerNumberRaw = req.body.caller_id_number || 
                           req.body["customer_no_with_prefix "] || 
                           req.body.customer_number_with_prefix ||
                           req.body.cli || 
                           req.body.msisdn || 
                           req.body.mobile || 
                           req.body.caller_number || 
                           req.body.from || 
                           req.body.customer_number ||
                           '';
    
    console.log('📞 Raw Caller Number:', callerNumberRaw);
    
    if (!callerNumberRaw) {
      console.log('❌ No caller number found in payload');
      return res.status(400).json({ error: 'Caller number not found' });
    }
    
    // Normalize to WhatsApp format
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    console.log('📱 Normalized WhatsApp Number:', whatsappNumber);
    
    if (!whatsappNumber) {
      console.log('❌ Invalid number format');
      return res.status(400).json({ error: 'Invalid number' });
    }
    
    // Get branch from called number
    const calledNumber = req.body.call_to_number || req.body.called_number || '';
    const branch = getBranchByCalledNumber(calledNumber);
    console.log('🏢 Branch:', branch);
    
    // Check for duplicates
    const isDuplicate = shouldSkipDuplicateMissCall(whatsappNumber, calledNumber);
    
    // Save miss call to database
    try {
      await missCallsCollection.insertOne({
        phoneNumber: whatsappNumber,
        calledNumber: calledNumber,
        branch: branch.name,
        rawPayload: req.body,
        createdAt: new Date(),
        isDuplicate: isDuplicate
      });
      console.log('✅ Miss call saved to database');
    } catch (dbError) {
      console.error('❌ Error saving miss call:', dbError.message);
    }
    
    if (isDuplicate) {
      console.log('⏭️ Skipping duplicate miss call');
      return res.json({ 
        success: true, 
        skipped: true, 
        message: 'Duplicate miss call skipped',
        whatsappNumber 
      });
    }
    
    // ✅ Save to patients collection
    const chatId = `${whatsappNumber}_${branch.name}`;
    const patientName = 'Miss Call Patient';
    const testNames = 'Miss Call';
    const sourceType = 'Miss Call';
    const priority = 'low';
    
    try {
      // Check if patient already exists
      const existingPatient = await patientsCollection.findOne({ 
        patientPhone: whatsappNumber,
        branch: branch.name,
        status: { $in: ['pending', 'waiting'] }
      });
      
      if (!existingPatient) {
        // Create new patient record
        await patientsCollection.insertOne({
          chatId,
          patientName,
          patientPhone: whatsappNumber,
          branch: branch.name,
          testNames,
          sourceType,
          executiveNumber: branch.executive,
          priority,
          status: 'pending',
          missCallTime: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        });
        console.log('✅ Patient saved to database:', whatsappNumber);
      } else {
        console.log('ℹ️ Patient already exists:', whatsappNumber);
        // Update miss call time
        await patientsCollection.updateOne(
          { _id: existingPatient._id },
          { $set: { missCallTime: new Date(), updatedAt: new Date() } }
        );
      }
    } catch (dbError) {
      console.error('❌ Database save error:', dbError.message);
    }
    
    // Send WATI template to customer
    console.log(`📱 Sending template ${TEMPLATE_NAME} to ${whatsappNumber}`);
    
    try {
      const templateResult = await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [
        { name: '1', value: branch.name }
      ]);
      console.log('✅ Customer template sent successfully');
    } catch (templateError) {
      console.error('❌ Customer template send failed:', templateError.message);
    }
    
    // ✅ Send notification to executive
    console.log(`📱 Sending executive notification to ${branch.executive}`);
    
    try {
      await sendLeadNotification(
        branch.executive,
        patientName,
        whatsappNumber,
        branch.name,
        'Miss Call - Awaiting details',
        '📞 Miss Call',
        chatId
      );
      console.log('✅ Executive notification sent');
    } catch (execError) {
      console.error('❌ Executive notification failed:', execError.message);
    }
    
    res.json({ 
      success: true, 
      message: 'Miss call processed',
      whatsappNumber,
      branch: branch.name
    });
    
  } catch (error) {
    console.error('❌ Tata Tele webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ MISS CALL STATS ENDPOINT (for dashboard)
// ============================================
app.get('/api/misscall-stats', async (req, res) => {
  try {
    if (!missCallsCollection || !patientsCollection) {
      return res.json({ total: 0, today: 0, byBranch: {} });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const total = await missCallsCollection.countDocuments();
    const today_count = await missCallsCollection.countDocuments({
      createdAt: { $gte: today }
    });
    
    const byBranch = await missCallsCollection.aggregate([
      { $group: { _id: '$branch', count: { $sum: 1 } } }
    ]).toArray();
    
    const branchStats = {};
    byBranch.forEach(b => { branchStats[b._id] = b.count; });
    
    // Also get patients from miss calls
    const missCallPatients = await patientsCollection.countDocuments({
      sourceType: 'Miss Call'
    });
    
    res.json({
      total,
      today: today_count,
      byBranch: branchStats,
      patientsFromMissCall: missCallPatients
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ TEST ENDPOINTS
// ============================================
app.get('/test-exec', async (req, res) => {
  try {
    const { exec } = req.query;
    const executiveNumber = exec || '917880261858';
    const chatId = `test-${Date.now()}`;
    
    await sendLeadNotification(
      executiveNumber, 
      'Test Patient', 
      executiveNumber, 
      'Test Branch', 
      'MRI Brain, CT Scan', 
      'Test', 
      chatId
    );
    
    res.json({
      success: true,
      message: `Template sent to ${executiveNumber}`,
      chatId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test-misscall', async (req, res) => {
  // Test endpoint to simulate miss call
  const testPhone = req.query.phone || '9876543210';
  const testBranch = req.query.branch || 'Naroda';
  
  const whatsappNumber = normalizeWhatsAppNumber(testPhone);
  const branch = BRANCHES[normalizeIndianNumber(process.env.NARODA_NUMBER)] || {
    name: testBranch,
    executive: process.env.DEFAULT_EXECUTIVE
  };
  
  console.log('🧪 Test miss call:', { whatsappNumber, branch });
  
  try {
    // Send template
    await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [
      { name: '1', value: branch.name }
    ]);
    
    // Send executive notification
    const chatId = `${whatsappNumber}_${branch.name}`;
    await sendLeadNotification(
      branch.executive,
      'Test Patient',
      whatsappNumber,
      branch.name,
      'Test Miss Call',
      '📞 Test',
      chatId
    );
    
    res.json({ 
      success: true, 
      message: 'Test miss call processed',
      whatsappNumber,
      branch: branch.name,
      executive: branch.executive
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', async (req, res) => {
  if (!patientsCollection || !processedCollection) {
    return res.status(503).json({
      success: false,
      error: 'Database not initialized',
      patientsCollection: !!patientsCollection,
      processedCollection: !!processedCollection
    });
  }
  
  try {
    const patientCount = await patientsCollection.countDocuments();
    const processedCount = await processedCollection.countDocuments();
    const missCallCount = missCallsCollection ? await missCallsCollection.countDocuments() : 0;
    
    res.json({
      success: true,
      patients: patientCount,
      processed: processedCount,
      missCalls: missCallCount,
      uptime: process.uptime(),
      mongodb: 'connected'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Production Executive System</title>
      <style>
        body { font-family: Arial; padding: 30px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
        h1 { color: #333; }
        .endpoint { background: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #007bff; }
        .btn { display: inline-block; background: #28a745; color: white; padding: 8px 15px; text-decoration: none; border-radius: 4px; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 Production Executive System</h1>
        <p>✅ Tata Tele Webhooks + WATI + MongoDB</p>
        
        <div class="endpoint">
          <div><span class="code">POST</span> /tata-misscall-whatsapp</div>
          <small>Main Tata Tele webhook</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/test-misscall?phone=9876543210">/test-misscall?phone=9876543210</a></div>
          <small>Test miss call flow</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/test-exec?exec=917880261858">/test-exec?exec=917880261858</a></div>
          <small>Send test template to executive</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/api/misscall-stats">/api/misscall-stats</a></div>
          <small>Miss call statistics</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/health">/health</a></div>
          <small>Health check</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/admin">/admin</a></div>
          <small>Admin Dashboard</small>
        </div>
      </div>
    </body>
    </html>
  `);
});

// ============================================
// ✅ DASHBOARD ROUTE
// ============================================
const dashboardRouter = require('./dashboard');
app.use('/admin', (req, res, next) => {
  if (!patientsCollection || !processedCollection) {
    return res.status(503).send(`
      <html>
        <head><title>Dashboard Unavailable</title></head>
        <body style="font-family: Arial; padding: 30px;">
          <h2>⏳ Dashboard Initializing</h2>
          <p>Database connection is being established. Please refresh in a few seconds.</p>
          <p>Collections: patients=${!!patientsCollection}, processed=${!!processedCollection}</p>
          <button onclick="location.reload()">Refresh Page</button>
        </body>
      </html>
    `);
  }
  req.patientsCollection = patientsCollection;
  req.processedCollection = processedCollection;
  req.missCallsCollection = missCallsCollection;
  req.PORT = PORT;
  next();
}, dashboardRouter);

// ============================================
// ✅ START SERVER
// ============================================
async function startServer() {
  try {
    console.log('🔄 Starting server...');
    
    await connectDB();
    
    if (!patientsCollection || !processedCollection) {
      throw new Error('Collections not initialized properly after connectDB()');
    }
    
    console.log('✅ All collections verified, starting server...');
    
    app.listen(PORT, () => {
      console.log('='.repeat(60));
      console.log(`🚀 PRODUCTION SERVER running on port ${PORT}`);
      console.log(`📍 Tata Tele Webhook: /tata-misscall-whatsapp`);
      console.log(`📍 WATI Webhook: /wati-webhook`);
      console.log(`📍 Test Endpoint: /test-misscall`);
      console.log(`📍 Cron: Fallback (5 min)`);
      console.log(`📍 MongoDB: Connected ✅`);
      console.log(`📍 Security: HMAC + API Key + WATI Auth`);
      console.log(`📍 Templates: misscall_welcome_v3, lead_notification_v2`);
      console.log('='.repeat(60));
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
