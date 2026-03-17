require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const OpenAI = require('openai');
const { MongoClient, ObjectId } = require('mongodb');

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
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91';
const DEDUPE_WINDOW_MS = (parseInt(process.env.DEDUPE_WINDOW_SECONDS || '600', 10)) * 1000;
const TEMPLATE_NAME = process.env.MISSCALL_TEMPLATE_NAME || 'misscall_welcome_v3';
const LEAD_TEMPLATE_NAME = process.env.LEAD_TEMPLATE_NAME || 'lead_notification_v2';

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
    await patientsCollection.createIndex({ status: 1 });
    await patientsCollection.createIndex({ timestamp: 1 });
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
// IN-MEMORY STORAGE (Fallback)
// ============================================
const recentMissCalls = new Map();
const userContext = new Map();
const processedImages = new Set();

// ============================================
// ✅ RETRY MECHANISM
// ============================================
async function retry(fn, retries = 3, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    if (retries === 0) throw error;
    console.log(`⚠️ Retrying... ${retries} attempts left`);
    await new Promise(r => setTimeout(r, delay));
    return retry(fn, retries - 1, delay * 2);
  }
}

// ============================================
// ✅ RATE LIMIT DELAY
// ============================================
async function rateLimitDelay() {
  await new Promise(r => setTimeout(r, 300));
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

// ✅ Mark message as processed
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
    { name: "6", value: `${SELF_URL}/connect-chat/${chatId}?token=${Buffer.from(chatId).toString('base64')}` }
  ];
  
  return await sendWatiTemplateMessage(executiveNumber, LEAD_TEMPLATE_NAME, parameters);
}

// ============================================
// ✅ FETCH CHATS
// ============================================
async function fetchRecentChats() {
  try {
    const from = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const to = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    const url = `${WATI_BASE_URL}/api/v1/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
    
    const response = await axios.get(url, {
      headers: { Authorization: `${WATI_TOKEN}` }
    });
    
    if (Array.isArray(response.data)) return response.data;
    if (response.data?.messages) return response.data.messages;
    if (response.data?.data) return response.data.data;
    return [];
  } catch (error) {
    console.error('❌ Fetch error:', error.message);
    return [];
  }
}

// ============================================
// ✅ OPENAI OCR
// ============================================
async function extractWithOpenAI(imageUrl) {
  try {
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
    try {
      const parsed = JSON.parse(content);
      return {
        patientName: parsed.patientName || 'Not found',
        tests: parsed.tests || 'Not found'
      };
    } catch {
      return { patientName: 'Not found', tests: 'Not found' };
    }
  } catch (error) {
    return { patientName: 'Not found', tests: 'Not found' };
  }
}

// ============================================
// ✅ PROCESS MANUAL ENTRY
// ============================================
async function processManualEntry(chatId, patientName, testNames, branch, patientPhone) {
  console.log(`\n📝 Processing manual entry`);
  
  const executiveNumber = getExecutiveNumber(branch);
  const priority = getPriority(testNames);
  
  // Store in MongoDB
  await patientsCollection.insertOne({
    chatId,
    patientName,
    testNames,
    branch,
    patientPhone,
    executiveNumber,
    entryType: 'Manual',
    priority,
    status: 'pending',
    timestamp: new Date(),
    createdAt: new Date()
  });
  
  // Send template notification with retry
  await retry(() => sendLeadNotification(
    executiveNumber, 
    patientName, 
    patientPhone, 
    branch, 
    testNames, 
    "Manual", 
    chatId
  ));
}

// ============================================
// ✅ PROCESS IMAGE UPLOAD
// ============================================
async function processImageUpload(chatId, patientName, branch, imageUrl, patientPhone) {
  console.log(`\n📸 Processing image upload`);
  
  const executiveNumber = getExecutiveNumber(branch);
  
  // OCR with retry
  const extracted = await retry(() => extractWithOpenAI(imageUrl), 2, 2000);
  console.log(`✅ OCR: ${extracted.patientName} - ${extracted.tests}`);
  
  const priority = getPriority(extracted.tests);
  
  // Store in MongoDB
  await patientsCollection.insertOne({
    chatId,
    patientName,
    tests: extracted.tests,
    branch,
    imageUrl,
    patientPhone,
    executiveNumber,
    entryType: 'Upload',
    priority,
    status: 'processed',
    timestamp: new Date(),
    createdAt: new Date()
  });
  
  // Send template notification with retry
  await retry(() => sendLeadNotification(
    executiveNumber, 
    extracted.patientName, 
    patientPhone, 
    branch, 
    extracted.tests, 
    "Upload", 
    chatId
  ));
  
  processedImages.add(chatId);
}

function getExecutiveNumber(branch) {
  const teamName = `${branch} Team`;
  return EXECUTIVES[teamName] || process.env.DEFAULT_EXECUTIVE || '917880261858';
}

// ============================================
// ✅ CRON JOB (हर 2 मिनट)
// ============================================
cron.schedule('*/2 * * * *', async () => {
  console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Checking for new leads...`);
  
  try {
    const messages = await fetchRecentChats();
    
    for (const msg of messages) {
      await rateLimitDelay(); // Rate limit protection
      
      const msgId = msg.id || msg.messageId || msg._id;
      if (!msgId) continue;
      
      // Check if already processed in DB
      if (await isMessageProcessed(msgId)) continue;
      
      const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
      if (!patientPhone) continue;
      
      const branch = 'Naroda'; // Default for testing
      
      if (msg.type === 'text' || msg.messageType === 'text') {
        const text = msg.text || msg.body || '';
        const lowerText = text.toLowerCase();
        
        if (lowerText.includes('manual') || lowerText.includes('test')) {
          await processManualEntry(msgId, 'Patient', text, branch, patientPhone);
          await markMessageProcessed(msgId);
        }
      }
      else if (msg.type === 'image' || msg.messageType === 'image') {
        const imageUrl = msg.mediaUrl || msg.url || msg.image?.url;
        if (imageUrl) {
          await processImageUpload(msgId, 'Patient', branch, imageUrl, patientPhone);
          await markMessageProcessed(msgId);
        }
      }
    }
  } catch (error) {
    console.error('❌ Cron error:', error.message);
  }
});

// ============================================
// ✅ AUTO FOLLOW-UP (हर 10 मिनट)
// ============================================
cron.schedule('*/10 * * * *', async () => {
  console.log('⏰ Checking for pending leads...');
  
  const pendingLeads = await patientsCollection.find({
    status: 'pending',
    createdAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) }
  }).toArray();
  
  for (const lead of pendingLeads) {
    await sendLeadNotification(
      lead.executiveNumber,
      lead.patientName,
      lead.patientPhone,
      lead.branch,
      lead.testNames || lead.tests,
      '⏰ Follow-up',
      lead.chatId
    );
  }
});

// ============================================
// ✅ MANAGER ESCALATION
// ============================================
cron.schedule('0 */1 * * *', async () => { // हर घंटे
  const notConverted = await patientsCollection.find({
    status: 'not_converted',
    createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  }).toArray();
  
  if (notConverted.length > 0) {
    const report = notConverted.map(p => 
      `❌ ${p.patientName} (${p.branch}) - ${p.executiveNumber}`
    ).join('\n');
    
    await sendLeadNotification(
      EXECUTIVES['Manager'],
      'Escalation Alert',
      EXECUTIVES['Manager'],
      'ALL',
      `${notConverted.length} leads not converted`,
      '⚠️ Escalation',
      `escalation-${Date.now()}`
    );
  }
});

// ============================================
// ✅ EXECUTIVE DASHBOARD (with Security)
// ============================================
app.get('/connect-chat/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { token } = req.query;
  
  // Security check
  const expectedToken = Buffer.from(chatId).toString('base64');
  if (token !== expectedToken) {
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
            <strong>Tests:</strong> ${patient.tests || patient.testNames || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Source:</strong> ${patient.entryType || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Priority:</strong> ${patient.priority || 'low'}
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
            fetch('/exec-action?action=' + action + '&chat=${chatId}')
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
        <p>✅ MongoDB + Rate Limiting + Retry + Security</p>
        
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
// ✅ TATA TELE WEBHOOK
// ============================================
app.post('/tata-misscall', async (req, res) => {
  try {
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
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ START SERVER
// ============================================
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 PRODUCTION SERVER running on port ${PORT}`);
  console.log(`📍 MongoDB Connected`);
  console.log(`📍 Rate Limiting: 300ms delay`);
  console.log(`📍 Retry Mechanism: 3 attempts`);
  console.log(`📍 Security: Token-based access`);
  console.log('='.repeat(60));
});
