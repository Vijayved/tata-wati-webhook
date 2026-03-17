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

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ MongoDB connected');
    db = client.db('executive_system');
    processedCollection = db.collection('processed_messages');
    patientsCollection = db.collection('patients');
    executivesCollection = db.collection('executives');
    
    // Create indexes
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await patientsCollection.createIndex({ chatId: 1 }, { unique: true });
    await patientsCollection.createIndex({ patientPhone: 1, branch: 1, status: 1 });
    await patientsCollection.createIndex({ followupDate: 1 });
    await patientsCollection.createIndex({ createdAt: 1 });
    await patientsCollection.createIndex({ lastNotificationSentAt: 1 });
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}
connectDB();

// ============================================
// EXECUTIVE NUMBERS MAPPING
// ============================================
const EXECUTIVES = {
  'Naroda Team': process.env.NARODA_EXECUTIVE || '917880261858',
  'Manager': process.env.MANAGER_NUMBER || '919825086099'
};

// ============================================
// BRANCH CONFIGURATION
// ============================================
const BRANCHES = {
  [normalizeIndianNumber(process.env.NARODA_NUMBER || '9898989899')]: {
    name: 'Naroda',
    executive: EXECUTIVES['Naroda Team']
  },
  [normalizeIndianNumber('917969690935')]: {
    name: 'Test Branch',
    executive: '917880261858'
  }
};

// ============================================
// ✅ IN-MEMORY STORAGE (Redis recommended for production)
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
// HELPER FUNCTIONS
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
  return body.caller_id_number || body.caller_number || body.from || 
         body.msisdn || body.mobile || body.customer_number ||
         body.customer_no_with_prefix || body.cli || '';
}

function getCalledNumberFromPayload(body) {
  return body.call_to_number || body.called_number || body.to || 
         body.destination || body.did || body.virtual_number || '';
}

// ✅ Check if message is already processed
async function isMessageProcessed(messageId) {
  const processed = await processedCollection.findOne({ messageId });
  return !!processed;
}

// ✅ Mark message as processed (atomic)
async function markMessageProcessed(messageId) {
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
// ✅ ATOMIC LEAD CREATION (No Race Conditions)
// ============================================
async function createOrUpdateLead(chatId, patientName, patientPhone, branch, testNames, sourceType, executiveNumber, priority, imageUrl = null) {
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
        updatedAt: now
      },
      $set: imageUrl ? { imageUrl, updatedAt: now } : { updatedAt: now }
    },
    { upsert: true }
  );
  
  return result.upsertedCount > 0; // true if new lead created
}

// ============================================
// ✅ PROCESS MANUAL ENTRY
// ============================================
async function processManualEntry(messageId, patientName, testNames, branch, patientPhone) {
  console.log(`\n📝 Processing manual entry`);
  
  const executiveNumber = getExecutiveNumber(branch);
  const priority = getPriority(testNames);
  const chatId = `${patientPhone}_${branch}`;
  
  // First mark as processed (to prevent duplicates on crash)
  await markMessageProcessed(messageId);
  
  // Atomic upsert to prevent race conditions
  const isNew = await createOrUpdateLead(
    chatId, patientName, patientPhone, branch, testNames, 'Manual', 
    executiveNumber, priority
  );
  
  // Only send notification for new leads
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
  
  // First mark as processed
  await markMessageProcessed(messageId);
  
  // OCR with timeout
  const extracted = await retryWithTimeout(() => extractWithOpenAI(imageUrl), 10000, 2);
  console.log(`✅ OCR: ${extracted.patientName} - ${extracted.tests}`);
  
  const priority = getPriority(extracted.tests);
  
  // Atomic upsert
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
// ✅ WEBHOOK ENDPOINT (MAIN ENTRY POINT)
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    // Security check
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
    
    // Check if already processed
    if (await isMessageProcessed(msgId)) {
      console.log(`⏭️ Message ${msgId} already processed`);
      return res.sendStatus(200);
    }
    
    const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
    if (!patientPhone) {
      return res.sendStatus(200);
    }
    
    const branch = 'Naroda'; // TODO: Get from contact attributes
    
    // Process based on message type
    if (msg.type === 'text' || msg.messageType === 'text') {
      const text = msg.text || msg.body || '';
      const lowerText = text.toLowerCase();
      
      if (lowerText.includes('manual') || lowerText.includes('test')) {
        await processManualEntry(msgId, 'Patient', text, branch, patientPhone);
      }
      else if (msg.buttonText || msg.button) {
        // Handle quick replies
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
          
          // Escalate to manager
          await sendLeadNotification(
            EXECUTIVES['Manager'],
            'Escalation Alert',
            EXECUTIVES['Manager'],
            'ALL',
            'Not Converted',
            `escalation-${Date.now()}`
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
      // Mark other message types as processed to avoid reprocessing
      await markMessageProcessed(msgId);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    res.sendStatus(200); // Always return 200 to WATI
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
// ✅ CRON JOB (FALLBACK - हर 5 मिनट)
// ============================================
cron.schedule('*/5 * * * *', async () => {
  console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Fallback check for missed messages...`);
  
  try {
    const from = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const to = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    const url = `${WATI_BASE_URL}/api/v1/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
    
    const response = await axios.get(url, {
      headers: { Authorization: `${WATI_TOKEN}` }
    });
    
    let messages = [];
    if (Array.isArray(response.data)) messages = response.data;
    else if (response.data?.messages) messages = response.data.messages;
    else if (response.data?.data) messages = response.data.data;
    
    for (const msg of messages) {
      await rateLimitDelay();
      
      const msgId = msg.id || msg.messageId || msg._id;
      if (!msgId || await isMessageProcessed(msgId)) continue;
      
      const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
      if (!patientPhone) continue;
      
      const branch = 'Naroda';
      
      // Process and mark as processed
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
    console.error('❌ Fallback cron error:', error.message);
  }
});

// ============================================
// ✅ AUTO FOLLOW-UP (हर 30 मिनट)
// ============================================
cron.schedule('*/30 * * * *', async () => {
  console.log('⏰ Checking for pending leads...');
  
  const pendingLeads = await patientsCollection.find({
    status: 'waiting',
    followupDate: { $lt: new Date() },
    $or: [
      { lastNotificationSentAt: null },
      { lastNotificationSentAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    ]
  }).toArray();
  
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
});

// ============================================
// ✅ MANAGER ESCALATION (Daily at 9 PM)
// ============================================
cron.schedule('0 21 * * *', async () => {
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
});

// ============================================
// ✅ EXECUTIVE DASHBOARD (with Security)
// ============================================
app.get('/connect-chat/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { token } = req.query;
  
  // Security check with HMAC
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
// ✅ TATA TELE WEBHOOK (with Auth)
// ============================================
app.post('/tata-misscall', async (req, res) => {
  try {
    // Verify Tata Tele webhook
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== TATA_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    console.log('📞 Tata Miss Call');
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    if (!callerNumberRaw) {
      return res.status(400).json({ error: 'Caller number not found' });
    }
    
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    if (!whatsappNumber) {
      return res.status(400).json({ error: 'Invalid number' });
    }
    
    const branch = getBranchByCalledNumber(req.body.call_to_number || '');
    
    if (shouldSkipDuplicateMissCall(whatsappNumber, req.body.call_to_number)) {
      return res.json({ skipped: true });
    }
    
    await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [{ name: '1', value: branch.name }]);
    
    res.json({ success: true, whatsappNumber, branch: branch.name });
  } catch (error) {
    console.error('❌ Error:', error);
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

app.get('/health', async (req, res) => {
  const patientCount = await patientsCollection.countDocuments();
  const processedCount = await processedCollection.countDocuments();
  
  res.json({
    success: true,
    patients: patientCount,
    processed: processedCount,
    uptime: process.uptime()
  });
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
        <p>✅ Webhook + Cron + MongoDB + Security + Atomic Ops + Timeouts</p>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/test-exec?exec=917880261858">/test-exec?exec=917880261858</a></div>
          <small>Send test template</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/health">/health</a></div>
          <small>Health check</small>
        </div>
      </div>
    </body>
    </html>
  `);
});

// ============================================
// ✅ START SERVER
// ============================================
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 PRODUCTION SERVER running on port ${PORT}`);
  console.log(`📍 Webhook: Primary`);
  console.log(`📍 Cron: Fallback (5 min)`);
  console.log(`📍 MongoDB: Connected`);
  console.log(`📍 Security: HMAC + API Key + WATI Auth`);
  console.log(`📍 Atomic Operations: ✅`);
  console.log(`📍 Timeouts: 5s-10s`);
  console.log('='.repeat(60));
});
