require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const OpenAI = require('openai');

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
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91';
const DEDUPE_WINDOW_MS = (parseInt(process.env.DEDUPE_WINDOW_SECONDS || '600', 10)) * 1000;
const TEMPLATE_NAME = process.env.MISSCALL_TEMPLATE_NAME || 'misscall_welcome_v3';
const LEAD_TEMPLATE_NAME = process.env.LEAD_TEMPLATE_NAME || 'lead_notification_v2'; // Utility template

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
// IN-MEMORY STORAGE
// ============================================
const recentMissCalls = new Map();
const userContext = new Map();
const patientDB = new Map();
const processedImages = new Set();
const processedChats = new Set();

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
// ✅ ENHANCED LEAD NOTIFICATION
// ============================================
async function sendLeadNotification(executiveNumber, branch, chatId, type = "General") {
  const parameters = [
    { name: "1", value: branch },
    { name: "2", value: type }, // "Manual Entry" / "Prescription"
    { name: "3", value: `${SELF_URL}/connect-chat/${chatId}` }
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
// ✅ OCR FUNCTION
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
        tests: parsed.tests || 'Not found',
        rawText: content
      };
    } catch {
      return { patientName: 'Not found', tests: 'Not found', rawText: content };
    }
  } catch (error) {
    return { patientName: 'OCR Failed', tests: 'OCR Failed', rawText: '' };
  }
}

// ============================================
// ✅ PROCESS FUNCTIONS
// ============================================
async function processManualEntry(chatId, patientName, testNames, branch, patientPhone) {
  console.log(`\n📝 === PROCESSING MANUAL ENTRY ===`);
  
  const executiveNumber = getExecutiveNumber(branch);
  
  // Store in DB
  patientDB.set(chatId, {
    patientName,
    testNames,
    branch,
    patientPhone,
    executiveNumber,
    entryType: 'manual',
    status: 'pending',
    timestamp: new Date().toISOString(),
    chatId
  });
  
  // Send template notification
  await sendLeadNotification(executiveNumber, branch, chatId, "📝 Manual Entry");
  console.log(`✅ Lead notification sent`);
}

async function processImageUpload(chatId, patientName, branch, imageUrl, patientPhone) {
  console.log(`\n📸 === PROCESSING IMAGE UPLOAD ===`);
  
  const executiveNumber = getExecutiveNumber(branch);
  
  // OCR
  const extracted = await extractWithOpenAI(imageUrl);
  console.log(`✅ OCR: ${extracted.patientName} - ${extracted.tests}`);
  
  // Store in DB
  patientDB.set(chatId, {
    patientName,
    tests: extracted.tests,
    branch,
    imageUrl,
    patientPhone,
    executiveNumber,
    entryType: 'upload',
    status: 'processed',
    timestamp: new Date().toISOString(),
    chatId
  });
  
  // Send template notification
  await sendLeadNotification(executiveNumber, branch, chatId, "📸 Prescription");
  console.log(`✅ Lead notification sent`);
  
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
      const msgId = msg.id || msg.messageId || msg._id;
      if (!msgId || processedChats.has(msgId)) continue;
      
      const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
      if (!patientPhone) continue;
      
      const branch = 'Naroda'; // Default for testing
      
      if (msg.type === 'text' || msg.messageType === 'text') {
        const text = msg.text || msg.body || '';
        const lowerText = text.toLowerCase();
        
        if (lowerText.includes('manual') || lowerText.includes('test')) {
          await processManualEntry(msgId, 'Patient', text, branch, patientPhone);
          processedChats.add(msgId);
        }
      }
      else if (msg.type === 'image' || msg.messageType === 'image') {
        const imageUrl = msg.mediaUrl || msg.url || msg.image?.url;
        if (imageUrl) {
          await processImageUpload(msgId, 'Patient', branch, imageUrl, patientPhone);
          processedChats.add(msgId);
        }
      }
    }
  } catch (error) {
    console.error('❌ Cron error:', error.message);
  }
});

// ============================================
// ✅ WEBHOOK FOR INCOMING MESSAGES (WATI से)
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('📨 WATI Webhook:', JSON.stringify(req.body, null, 2));
    
    const from = normalizeWhatsAppNumber(req.body.from || req.body.whatsappNumber || req.body.sender);
    const text = String(req.body.text || req.body.message || '').trim().toLowerCase();
    const mediaUrl = req.body.imageUrl || req.body.media?.url || '';
    
    if (!from) return res.json({ received: true });
    
    const context = userContext.get(from) || {};
    const branch = context.branch || 'Main Branch';
    const executive = context.executive || process.env.DEFAULT_EXECUTIVE || '917880261858';
    
    if (text === '1') {
      await sendWatiTemplateMessage(from, TEMPLATE_NAME, [{ name: '1', value: branch }]);
    } else if (text === '2') {
      await sendWatiTemplateMessage(from, TEMPLATE_NAME, [{ name: '1', value: branch }]);
    } else if (text === '3') {
      await sendLeadNotification(executive, branch, 'pending', "👤 Executive Request");
    } else if (mediaUrl) {
      const extracted = await extractWithOpenAI(mediaUrl);
      await sendLeadNotification(executive, branch, 'ocr', "📸 Prescription Upload");
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    res.json({ received: true });
  }
});

// ============================================
// ✅ EXECUTIVE ENDPOINTS
// ============================================
app.get('/connect-chat/:chatId', (req, res) => {
  const { chatId } = req.params;
  const patient = patientDB.get(chatId);
  
  if (!patient) {
    return res.send(`
      <html>
        <head><title>Patient Not Found</title></head>
        <body>
          <h2>❌ Patient not found</h2>
          <p>Chat ID: ${chatId}</p>
        </body>
      </html>
    `);
  }
  
  res.send(`
    <html>
      <head>
        <title>Patient Details</title>
        <style>
          body { font-family: Arial; padding: 20px; background: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
          .detail { margin: 15px 0; padding: 10px; background: #f8f9fa; border-radius: 5px; }
          .label { font-weight: bold; color: #666; }
          .value { font-size: 18px; margin-top: 5px; }
          .buttons { margin-top: 30px; display: flex; gap: 10px; }
          .btn { padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
          .btn-convert { background: #28a745; color: white; }
          .btn-waiting { background: #ffc107; color: black; }
          .btn-notconvert { background: #dc3545; color: white; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>👤 Patient Details</h1>
          
          <div class="detail">
            <div class="label">Patient Name</div>
            <div class="value">${patient.patientName || 'N/A'}</div>
          </div>
          
          <div class="detail">
            <div class="label">Tests</div>
            <div class="value">${patient.tests || patient.testNames || 'N/A'}</div>
          </div>
          
          <div class="detail">
            <div class="label">Branch</div>
            <div class="value">${patient.branch || 'N/A'}</div>
          </div>
          
          <div class="detail">
            <div class="label">Phone</div>
            <div class="value">${patient.patientPhone || 'N/A'}</div>
          </div>
          
          <div class="detail">
            <div class="label">Type</div>
            <div class="value">${patient.entryType || 'N/A'}</div>
          </div>
          
          <div class="buttons">
            <button class="btn btn-convert" onclick="updateStatus('convert')">✅ Convert</button>
            <button class="btn btn-waiting" onclick="updateStatus('waiting')">⏳ Waiting</button>
            <button class="btn btn-notconvert" onclick="updateStatus('notconvert')">❌ Not Convert</button>
          </div>
        </div>
        
        <script>
          function updateStatus(action) {
            fetch('/exec-action?action=' + action + '&chat=${chatId}')
              .then(response => response.text())
              .then(data => {
                alert(data);
                window.close();
              });
          }
        </script>
      </body>
    </html>
  `);
});

app.get('/exec-action', async (req, res) => {
  const { action, chat } = req.query;
  const patient = patientDB.get(chat);
  
  if (!patient) return res.send('❌ Patient not found');
  
  patient.status = 
    action === 'convert' ? 'converted' :
    action === 'waiting' ? 'waiting' : 'not_converted';
  
  patientDB.set(chat, patient);
  res.send(`✅ Patient marked as ${patient.status}`);
});

// ============================================
// ✅ TEST ENDPOINTS
// ============================================
app.get('/test-exec', async (req, res) => {
  try {
    const { exec } = req.query;
    const executiveNumber = exec || '917880261858';
    const chatId = `test-${Date.now()}`;
    
    await sendLeadNotification(executiveNumber, 'Test Branch', chatId, "🧪 Test");
    
    res.json({
      success: true,
      message: `Template sent to ${executiveNumber}`,
      chatId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    patients: patientDB.size,
    processed: processedImages.size,
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Executive System</title>
      <style>
        body { font-family: Arial; padding: 30px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
        h1 { color: #333; }
        .endpoint { background: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #007bff; }
        .code { background: #eee; padding: 3px 6px; border-radius: 3px; font-family: monospace; }
        .btn { display: inline-block; background: #28a745; color: white; padding: 8px 15px; text-decoration: none; border-radius: 4px; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 Executive Notification System</h1>
        <p>✅ Basic Plan Optimized - Template Only</p>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/test-exec?exec=917880261858">/test-exec?exec=917880261858</a></div>
          <small>Send test template to executive</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/health">/health</a></div>
          <small>Health check</small>
        </div>
        
        <a href="/test-exec?exec=917880261858" class="btn">🧪 Send Test Message</a>
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
    console.log('📞 Tata Miss Call:', JSON.stringify(req.body, null, 2));
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    if (!callerNumberRaw) {
      return res.status(400).json({ error: 'Caller number not found' });
    }
    
    let whatsappNumber = String(callerNumberRaw).replace(/\D/g, '');
    whatsappNumber = whatsappNumber.length >= 10 ? '91' + whatsappNumber.slice(-10) : '';
    
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
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Template: ${LEAD_TEMPLATE_NAME}`);
  console.log(`📍 Test: /test-exec?exec=917880261858`);
  console.log('='.repeat(60));
});
