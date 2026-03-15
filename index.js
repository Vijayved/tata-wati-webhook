require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3000;
const WATI_TOKEN = process.env.WATI_TOKEN;
const WATI_BASE_URL = process.env.WATI_BASE_URL;
const OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY;
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91';
const DEDUPE_WINDOW_MS = (parseInt(process.env.DEDUPE_WINDOW_SECONDS || '600', 10)) * 1000;
const TEMPLATE_NAME = process.env.MISSCALL_TEMPLATE_NAME || 'misscall_welcome';

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
  'Manager': '919825086099'  // Manager का नंबर डालो
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
const patientDB = new Map();        // Executive system के लिए
const followupDB = new Map();       // Follow-up dates के लिए

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
// EXECUTIVE SYSTEM ENDPOINTS
// ============================================

// WATI Webhook for chat assignments
app.post('/webhook/chat-assigned', async (req, res) => {
  try {
    console.log('📨 Executive Webhook:', JSON.stringify(req.body, null, 2));
    
    const { chatId, assignedTeam, contact, messages } = req.body;
    
    // Check if chat is assigned to any team
    if (!assignedTeam || assignedTeam === '') {
      console.log('⏭️ Skipping - Chat not assigned');
      return res.json({ ignored: true });
    }
    
    // Get executive number
    const executiveNumber = EXECUTIVES[assignedTeam];
    if (!executiveNumber) {
      console.log(`⚠️ No executive for team: ${assignedTeam}`);
      return res.json({ ignored: true });
    }
    
    // Extract patient details
    const patientData = {
      patientName: contact?.name || 'Patient',
      patientNumber: contact?.waId || 'Unknown',
      testNames: 'Test booked',
      branch: assignedTeam.replace(' Team', ''),
      time: new Date().toLocaleString(),
      chatId
    };
    
    // Store in database
    patientDB.set(chatId, {
      ...patientData,
      executiveNumber,
      team: assignedTeam,
      status: 'pending',
      createdAt: new Date()
    });
    
    // Send message to executive
    const message = `
📋 *New Patient Request*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${patientData.patientName}
🔬 Tests: ${patientData.testNames}
🏥 Branch: ${patientData.branch}
📅 Time: ${patientData.time}
📞 Patient No: ${patientData.patientNumber}
━━━━━━━━━━━━━━━━━━

🔗 Connect: ${SELF_URL}/connect-chat/${chatId}
✅ Convert: ${SELF_URL}/exec-action?action=convert&chat=${chatId}
⏳ Waiting: ${SELF_URL}/exec-action?action=waiting&chat=${chatId}
❌ Not Convert: ${SELF_URL}/exec-action?action=notconvert&chat=${chatId}
    `;
    
    await sendExecutiveNotification(executiveNumber, message);
    console.log(`✅ Notification sent to ${executiveNumber} for chat ${chatId}`);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Connect button handler
app.get('/connect-chat/:chatId', (req, res) => {
  const { chatId } = req.params;
  // Redirect to WATI app deep link
  res.redirect(`https://app.wati.io/chat/${chatId}`);
});

// Executive action handler
app.get('/exec-action', async (req, res) => {
  const { action, chat } = req.query;
  
  const patient = patientDB.get(chat);
  if (!patient) {
    return res.send('❌ Patient not found');
  }
  
  let responseMessage = '';
  
  switch(action) {
    case 'convert':
      patient.status = 'converted';
      patientDB.set(chat, patient);
      responseMessage = '✅ Patient marked as converted';
      await sendExecutiveNotification(patient.executiveNumber,
        `✅ Patient ${patient.patientName} converted successfully!`);
      break;
      
    case 'waiting':
      patient.status = 'waiting';
      patientDB.set(chat, patient);
      responseMessage = '⏳ Please reply with follow-up date (DD/MM/YYYY)';
      await sendExecutiveNotification(patient.executiveNumber,
        `⏳ Patient ${patient.patientName} is waiting. Please send follow-up date.`);
      break;
      
    case 'notconvert':
      patient.status = 'not_converted';
      patientDB.set(chat, patient);
      responseMessage = '❌ Escalated to manager';
      await sendExecutiveNotification(EXECUTIVES['Manager'],
        `📤 *Escalation Alert*\nPatient: ${patient.patientName}\nExecutive: ${patient.executiveNumber}\nBranch: ${patient.branch}`);
      await sendExecutiveNotification(patient.executiveNumber,
        `❌ Patient ${patient.patientName} escalated to manager.`);
      break;
  }
  
  res.send(responseMessage);
});

// Follow-up date handler
app.post('/webhook/followup', async (req, res) => {
  const { chatId, followupDate } = req.body;
  
  const patient = patientDB.get(chatId);
  if (patient) {
    patient.followupDate = followupDate;
    patient.status = 'waiting';
    patientDB.set(chatId, patient);
    
    const dateKey = followupDate.split('/').reverse().join('-'); // Convert to YYYY-MM-DD
    const existing = followupDB.get(dateKey) || [];
    followupDB.set(dateKey, [...existing, chatId]);
  }
  
  res.json({ success: true });
});

// Daily follow-up reminder (9 AM)
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Running follow-up reminder...');
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
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
    const createdDate = patient.createdAt.toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    
    if (createdDate !== today) continue; // Only today's patients
    
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
// OCR FUNCTIONS
// ============================================
async function extractWithOCRSpace(imageUrl) {
  try {
    const formData = new FormData();
    formData.append('url', imageUrl);
    formData.append('apikey', OCR_SPACE_API_KEY);
    formData.append('language', 'eng');
    const response = await axios.post('https://api.ocr.space/parse/image', formData, {
      headers: formData.getHeaders(),
      timeout: 30000
    });
    const parsedText = response.data?.ParsedResults?.[0]?.ParsedText || '';
    return parsePrescriptionText(parsedText);
  } catch (error) {
    console.error('❌ OCR Error:', error.response?.data || error.message);
    return { patientName: 'OCR Failed', doctorName: 'OCR Failed', tests: 'OCR Failed', rawText: '' };
  }
}

function parsePrescriptionText(text) {
  const cleanText = String(text || '').trim();
  const patientMatch = cleanText.match(/Patient(?:\s*Name)?[:\s]+([A-Za-z\s]+)/i) || 
                       cleanText.match(/Name[:\s]+([A-Za-z\s]+)/i);
  const doctorMatch = cleanText.match(/Dr\.?\s*([A-Za-z\s]+)/i);
  const testKeywords = ['blood', 'x-ray', 'xray', 'ultrasound', 'cbc', 'thyroid'];
  const foundTests = [];
  const lower = cleanText.toLowerCase();
  for (const keyword of testKeywords) {
    if (lower.includes(keyword)) foundTests.push(keyword.toUpperCase());
  }
  return {
    patientName: patientMatch ? patientMatch[1].trim() : 'Not found',
    doctorName: doctorMatch ? doctorMatch[1].trim() : 'Not found',
    tests: foundTests.length ? [...new Set(foundTests)].join(', ') : 'Not found',
    rawText: cleanText.slice(0, 500)
  };
}

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

app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('📨 WATI Webhook:', JSON.stringify(req.body, null, 2));
    
    const from = normalizeWhatsAppNumber(req.body.from || req.body.whatsappNumber || req.body.sender);
    const text = String(req.body.text || req.body.message || '').trim().toLowerCase();
    const mediaUrl = req.body.imageUrl || req.body.media?.url || '';
    
    if (!from) return res.json({ received: true, ignored: true });
    
    const context = userContext.get(from) || {};
    const branch = context.branch || 'Main Branch';
    const executive = context.executive || process.env.DEFAULT_EXECUTIVE;
    
    if (text === '1') {
      await sendSessionTextMessage(from, `📅 *Book Test - ${branch} Branch*\nKripya apna naam, test ka naam, aur preferred date/time bhejiye.`);
      userContext.set(from, { ...context, stage: 'book_test_requested' });
    } else if (text === '2') {
      await sendSessionTextMessage(from, `📸 *Upload Prescription - ${branch} Branch*\nKripya prescription ki clear photo bhejiye.`);
      userContext.set(from, { ...context, stage: 'awaiting_prescription' });
    } else if (text === '3') {
      await sendSessionTextMessage(from, `👨‍💼 Aapko ${branch} branch ke executive se connect kiya ja raha hai.`);
      userContext.set(from, { ...context, stage: 'executive_requested' });
    } else if (mediaUrl && context.stage === 'awaiting_prescription') {
      const extracted = await extractWithOCRSpace(mediaUrl);
      await sendExecutiveNotification(executive, 
        `📸 *Prescription Received*\n🏥 Branch: ${branch}\n📱 Customer: ${from}\n👤 Patient: ${extracted.patientName}\n👨‍⚕️ Doctor: ${extracted.doctorName}\n🔬 Tests: ${extracted.tests}\n\n🔗 Image: ${mediaUrl}`);
      await sendSessionTextMessage(from, '✅ Aapki prescription receive ho gayi hai.');
      userContext.set(from, { ...context, stage: 'prescription_uploaded' });
    }
    
    return res.json({ received: true });
    
  } catch (error) {
    console.error('❌ WATI webhook error:', error.message);
    return res.status(500).json({ received: false, error: error.message });
  }
});

app.post('/ocr-prescription', async (req, res) => {
  try {
    const { imageUrl, whatsappNumber, branch, executive } = req.body;
    
    if (!imageUrl || !whatsappNumber) {
      return res.status(400).json({ success: false, error: 'imageUrl and whatsappNumber required' });
    }
    
    const extracted = await extractWithOCRSpace(imageUrl);
    const context = userContext.get(whatsappNumber) || {};
    const finalBranch = branch || context.branch || 'Not specified';
    const finalExecutive = executive || context.executive || process.env.DEFAULT_EXECUTIVE;
    
    const executiveMessage = `📸 *New Prescription Uploaded*\n━━━━━━━━━━━━━━━━━━\n🏥 *Branch:* ${finalBranch}\n👤 *Patient:* ${extracted.patientName}\n👨‍⚕️ *Doctor:* ${extracted.doctorName}\n🔬 *Tests:* ${extracted.tests}\n━━━━━━━━━━━━━━━━━━\n📝 *OCR Preview:*\n${extracted.rawText}\n\n🔗 Image: ${imageUrl}`;
    
    await sendExecutiveNotification(finalExecutive, executiveMessage);
    await sendSessionTextMessage(whatsappNumber, '✅ Aapki prescription receive ho gayi hai.');
    
    userContext.set(whatsappNumber, { ...context, branch: finalBranch, executive: finalExecutive, stage: 'prescription_uploaded' });
    
    return res.json({ success: true, extracted });
    
  } catch (error) {
    console.error('❌ OCR error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// TEST ENDPOINTS
// ============================================
app.get('/test-template', async (req, res) => {
  try {
    const number = req.query.number || '919106959092';
    const branch = req.query.branch || 'Satellite';
    const result = await sendWatiTemplateMessage(number, branch);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/test-ocr', async (req, res) => {
  try {
    const imageUrl = req.query.image;
    if (!imageUrl) return res.status(400).json({ error: 'image URL required' });
    const result = await extractWithOCRSpace(imageUrl);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok', uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Tata-WATI Webhook Server</h1>
    <p>Executive Notification System Active</p>
    <ul>
      <li>POST /tata-misscall - Tata Tele webhook</li>
      <li>POST /wati-webhook - WATI webhook</li>
      <li>POST /ocr-prescription - OCR endpoint</li>
      <li>POST /webhook/chat-assigned - Executive webhook</li>
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
  console.log(`📍 Executive webhook: POST /webhook/chat-assigned`);
  console.log('='.repeat(60));
});
