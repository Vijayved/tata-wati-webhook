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

// OpenAI Initialization
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Keep-alive for Render free tier
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
  'Satellite Team': process.env.SATELLITE_EXECUTIVE || '919825086011',
  'Naroda Team': process.env.NARODA_EXECUTIVE || '919825086012',
  'Usmanpura Team': process.env.USMANPURA_EXECUTIVE || '919825086013',
  'Vadaj Team': process.env.VADAJ_EXECUTIVE || '919825086014',
  'Manager': process.env.MANAGER_NUMBER || '919825086099'
};

// ============================================
// BRANCH CONFIGURATION
// ============================================
const BRANCHES = {
  [normalizeIndianNumber(process.env.SATELLITE_NUMBER || '9898989898')]: {
    name: 'Satellite',
    executive: EXECUTIVES['Satellite Team']
  },
  [normalizeIndianNumber(process.env.NARODA_NUMBER || '9898989899')]: {
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
const followupDB = new Map();
const processedImages = new Set();

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
  return normalized ? '91' + normalized.slice(-10) : '';
}

function getBranchByCalledNumber(calledNumber) {
  const normalized = normalizeIndianNumber(calledNumber);
  return BRANCHES[normalized] || {
    name: 'Main Branch',
    executive: process.env.DEFAULT_EXECUTIVE || '919825086011'
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
// WATI API FUNCTIONS
// ============================================
async function callWatiApi(url, data) {
  try {
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `${WATI_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    console.error('❌ WATI API Error:', error.response?.data || error.message);
    throw error;
  }
}

async function sendWatiTemplateMessage(whatsappNumber, branchName) {
  const payload = {
    template_name: TEMPLATE_NAME,
    broadcast_name: `misscall_${Date.now()}`,
    parameters: [{ name: '1', value: branchName }]
  };
  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
  return await callWatiApi(url, payload);
}

async function sendSessionTextMessage(whatsappNumber, messageText) {
  const url = `${WATI_BASE_URL}/api/v1/sendSessionMessage/${encodeURIComponent(whatsappNumber)}`;
  const payload = { messageText, messageType: 'TEXT' };
  return await callWatiApi(url, payload);
}

async function sendExecutiveNotification(executiveNumber, messageText) {
  return await sendSessionTextMessage(executiveNumber, messageText);
}

// ============================================
// OPENAI OCR FUNCTION
// ============================================
async function extractWithOpenAI(imageUrl) {
  try {
    console.log('🔍 Calling OpenAI Vision API...');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract the following information from this medical prescription:
                - Patient Name
                - Doctor Name
                - List of medical tests prescribed
                
                Return the response in JSON format with keys: patientName, doctorName, tests (as array)`
            },
            {
              type: "image_url",
              image_url: {
                url: imageUrl
              }
            }
          ]
        }
      ],
      max_tokens: 500
    });
    
    const content = response.choices[0].message.content;
    
    // Parse JSON from response
    try {
      const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || 
                       content.match(/```\n([\s\S]*?)\n```/) ||
                       [null, content];
      
      const jsonStr = jsonMatch[1] || content;
      const parsed = JSON.parse(jsonStr);
      
      return {
        patientName: parsed.patientName || 'Not found',
        doctorName: parsed.doctorName || 'Not found',
        tests: Array.isArray(parsed.tests) ? parsed.tests.join(', ') : parsed.tests || 'Not found',
        rawText: content
      };
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', content);
      return {
        patientName: 'Parsing failed',
        doctorName: 'Parsing failed',
        tests: 'Parsing failed',
        rawText: content
      };
    }
    
  } catch (error) {
    console.error('❌ OpenAI API Error:', error.message);
    return {
      patientName: 'OCR Failed',
      doctorName: 'OCR Failed',
      tests: 'OCR Failed',
      rawText: '',
      error: error.message
    };
  }
}

// ============================================
// WEBHOOK – New Prescription from WATI
// ============================================
app.post('/webhook/new-prescription', async (req, res) => {
  try {
    const { chatId, patientName, branch, imageUrl, executiveNumber } = req.body;
    
    console.log(`📸 New prescription from ${patientName} (${branch})`);
    
    // Store in DB
    patientDB.set(chatId, {
      patientName,
      branch,
      imageUrl,
      executiveNumber,
      status: 'pending',
      timestamp: new Date().toISOString(),
      chatId
    });
    
    // Trigger immediate OCR (async)
    res.json({ success: true, message: 'Prescription received' });
    
    // Run OCR in background
    setTimeout(async () => {
      console.log(`🔍 Processing OCR for chat ${chatId}`);
      
      const extracted = await extractWithOpenAI(imageUrl);
      
      // Update patient record
      const patient = patientDB.get(chatId);
      if (patient) {
        patient.extracted = extracted;
        patient.status = 'processed';
        patientDB.set(chatId, patient);
        
        // Send to executive
        const message = `
📸 *New Prescription Received*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${extracted.patientName}
🔬 Tests: ${extracted.tests}
👨‍⚕️ Doctor: ${extracted.doctorName}
🏥 Branch: ${patient.branch}
📅 Time: ${patient.timestamp}
━━━━━━━━━━━━━━━━━━
📝 *OCR Preview:*
${extracted.rawText.substring(0, 300)}...
━━━━━━━━━━━━━━━━━━
🔗 Connect: ${SELF_URL}/connect-chat/${chatId}
✅ Convert: ${SELF_URL}/exec-action?action=convert&chat=${chatId}
⏳ Waiting: ${SELF_URL}/exec-action?action=waiting&chat=${chatId}
❌ Not Convert: ${SELF_URL}/exec-action?action=notconvert&chat=${chatId}
        `;
        
        await sendExecutiveNotification(patient.executiveNumber, message);
        processedImages.add(chatId);
      }
    }, 1000);
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// EXECUTIVE SYSTEM ENDPOINTS
// ============================================

// Connect button handler
app.get('/connect-chat/:chatId', (req, res) => {
  const { chatId } = req.params;
  res.redirect(`https://app.wati.io/chat/${chatId}`);
});

// Executive action handler
app.get('/exec-action', async (req, res) => {
  const { action, chat } = req.query;
  
  const patient = patientDB.get(chat);
  if (!patient) {
    return res.send('❌ Patient not found');
  }
  
  switch(action) {
    case 'convert':
      patient.status = 'converted';
      patientDB.set(chat, patient);
      await sendExecutiveNotification(patient.executiveNumber,
        `✅ Patient ${patient.patientName} converted successfully!`);
      break;
      
    case 'waiting':
      patient.status = 'waiting';
      patientDB.set(chat, patient);
      await sendExecutiveNotification(patient.executiveNumber,
        `⏳ Please send follow-up date (DD/MM/YYYY) for ${patient.patientName}`);
      break;
      
    case 'notconvert':
      patient.status = 'not_converted';
      patientDB.set(chat, patient);
      await sendExecutiveNotification(EXECUTIVES['Manager'],
        `📤 *Escalation Alert*\nPatient: ${patient.patientName}\nBranch: ${patient.branch}\nExecutive: ${patient.executiveNumber}`);
      await sendExecutiveNotification(patient.executiveNumber,
        `❌ Patient ${patient.patientName} escalated to manager.`);
      break;
  }
  
  res.send('✅ Action recorded!');
});

// Follow-up date handler
app.post('/webhook/followup', async (req, res) => {
  const { chatId, followupDate } = req.body;
  
  const patient = patientDB.get(chatId);
  if (patient) {
    patient.followupDate = followupDate;
    patient.status = 'waiting';
    patientDB.set(chatId, patient);
    
    const dateKey = followupDate.split('/').reverse().join('-');
    const existing = followupDB.get(dateKey) || [];
    followupDB.set(dateKey, [...existing, chatId]);
  }
  
  res.json({ success: true });
});

// Daily follow-up reminder (9 AM)
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Running follow-up reminder...');
  const today = new Date().toISOString().split('T')[0];
  
  const chatIds = followupDB.get(today) || [];
  
  for (const chatId of chatIds) {
    const patient = patientDB.get(chatId);
    if (patient) {
      await sendExecutiveNotification(patient.executiveNumber,
        `⏰ *Follow-up Reminder*\nPatient: ${patient.patientName}\nBranch: ${patient.branch}`);
    }
  }
});

// Daily manager report (10 PM)
cron.schedule('0 22 * * *', async () => {
  console.log('📊 Generating daily report...');
  
  let report = `📊 *Daily Report - ${new Date().toLocaleDateString()}*\n━━━━━━━━━━━━━━━━━━\n\n`;
  
  let total = 0, converted = 0, waiting = 0, notConverted = 0;
  const branchStats = {};
  
  for (let [chatId, patient] of patientDB) {
    const createdDate = patient.timestamp?.split('T')[0] || '';
    const today = new Date().toISOString().split('T')[0];
    
    if (createdDate !== today) continue;
    
    total++;
    
    branchStats[patient.branch] = branchStats[patient.branch] || 
      { total:0, converted:0, waiting:0, notConverted:0 };
    branchStats[patient.branch].total++;
    
    if (patient.status === 'converted') {
      converted++;
      branchStats[patient.branch].converted++;
    } else if (patient.status === 'waiting') {
      waiting++;
      branchStats[patient.branch].waiting++;
    } else if (patient.status === 'not_converted') {
      notConverted++;
      branchStats[patient.branch].notConverted++;
    }
  }
  
  report += `📞 Total Patients: ${total}\n`;
  report += `✅ Converted: ${converted}\n`;
  report += `⏳ Waiting: ${waiting}\n`;
  report += `❌ Not Converted: ${notConverted}\n\n`;
  report += `🏥 Branch-wise:\n`;
  
  for (let branch in branchStats) {
    let b = branchStats[branch];
    report += `${branch}: ${b.total} (✅${b.converted} ⏳${b.waiting} ❌${b.notConverted})\n`;
  }
  
  await sendExecutiveNotification(EXECUTIVES['Manager'], report);
});

// ============================================
// MAIN ENDPOINTS
// ============================================
app.post('/tata-misscall', async (req, res) => {
  try {
    console.log('📞 Tata Miss Call Payload:', JSON.stringify(req.body, null, 2));
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    const calledNumberRaw = getCalledNumberFromPayload(req.body);
    
    if (!callerNumberRaw) {
      return res.status(400).json({ success: false, error: 'Caller number not found' });
    }
    
    let whatsappNumber = String(callerNumberRaw).replace(/\D/g, '');
    whatsappNumber = whatsappNumber.length >= 10 ? '91' + whatsappNumber.slice(-10) : '';
    
    if (!whatsappNumber) {
      return res.status(400).json({ success: false, error: 'Invalid number format' });
    }
    
    const branch = getBranchByCalledNumber(calledNumberRaw);
    
    if (shouldSkipDuplicateMissCall(whatsappNumber, calledNumberRaw)) {
      console.log(`⏳ Duplicate call skipped for ${whatsappNumber}`);
      return res.json({ success: true, skipped: true });
    }
    
    await sendWatiTemplateMessage(whatsappNumber, branch.name);
    
    return res.json({ success: true, whatsappNumber, branch: branch.name });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'ok', 
    processed: processedImages.size,
    patients: patientDB.size,
    uptime: process.uptime() 
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Tata-WATI Webhook Server</h1>
    <p>OpenAI OCR + Executive System Active</p>
    <ul>
      <li>POST /tata-misscall - Tata Tele webhook</li>
      <li>POST /wati-webhook - WATI webhook</li>
      <li>POST /ocr-prescription - OCR endpoint</li>
      <li>POST /webhook/new-prescription - New prescription from WATI</li>
      <li>GET /connect-chat/:chatId - Connect to patient</li>
      <li>GET /exec-action - Executive actions</li>
      <li>POST /webhook/followup - Follow-up date</li>
      <li>GET /health - Health check</li>
    </ul>
  `);
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Template: ${TEMPLATE_NAME}`);
  console.log(`📍 OpenAI OCR: Active`);
  console.log(`📍 Webhook: POST /webhook/new-prescription`);
  console.log('='.repeat(60));
});
