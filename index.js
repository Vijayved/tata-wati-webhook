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
  'Satellite Team': process.env.SATELLITE_EXECUTIVE || '919825086011',
  'Naroda Team': process.env.NARODA_EXECUTIVE || '919825086012',
  'Usmanpura Team': process.env.USMANPURA_EXECUTIVE || '919825086013',
  'Vadaj Team': process.env.VADAJ_EXECUTIVE || '919825086014',
  'Manager': process.env.MANAGER_NUMBER || '919825086099'
};

// List of all executive numbers for session keeping
const ALL_EXECUTIVE_NUMBERS = [
  process.env.SATELLITE_EXECUTIVE || '919825086011',
  process.env.NARODA_EXECUTIVE || '919825086012',
  process.env.USMANPURA_EXECUTIVE || '919825086013',
  process.env.VADAJ_EXECUTIVE || '919825086014',
  process.env.MANAGER_NUMBER || '919825086099',
  '919169959992' // Test number
].filter(Boolean); // Remove empty values

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
// WATI API FETCH FUNCTIONS
// ============================================
async function fetchRecentChats() {
  try {
    const from = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const to = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    const url = `${WATI_BASE_URL}/api/v1/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
    
    const response = await axios.get(url, {
      headers: { Authorization: `${WATI_TOKEN}` }
    });
    
    return response.data || [];
  } catch (error) {
    console.error('❌ Error fetching chats:', error.message);
    return [];
  }
}

async function getContactDetails(whatsappNumber) {
  try {
    const url = `${WATI_BASE_URL}/api/v1/getContacts?pageSize=1&name=${whatsappNumber}`;
    const response = await axios.get(url, {
      headers: { Authorization: `${WATI_TOKEN}` }
    });
    return response.data?.[0] || null;
  } catch (error) {
    console.error('❌ Error fetching contact:', error.message);
    return null;
  }
}

// ============================================
// PROCESS FUNCTIONS
// ============================================
async function processManualEntry(chatId, patientName, testNames, branch) {
  console.log(`📝 Processing manual entry for ${patientName}`);
  
  const executiveNumber = getExecutiveNumber(branch);
  
  const message = `
📋 *New Manual Test Entry*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${patientName}
🔬 Tests: ${testNames}
🏥 Branch: ${branch}
📅 Time: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
🔗 Connect: ${SELF_URL}/connect-chat/${chatId}
✅ Convert: ${SELF_URL}/exec-action?action=convert&chat=${chatId}
⏳ Waiting: ${SELF_URL}/exec-action?action=waiting&chat=${chatId}
❌ Not Convert: ${SELF_URL}/exec-action?action=notconvert&chat=${chatId}
  `;
  
  await sendExecutiveNotification(executiveNumber, message);
  
  patientDB.set(chatId, {
    patientName,
    testNames,
    branch,
    executiveNumber,
    entryType: 'manual',
    status: 'pending',
    timestamp: new Date().toISOString(),
    chatId
  });
}

async function processImageUpload(chatId, patientName, branch, imageUrl) {
  console.log(`📸 Processing image upload for ${patientName}`);
  
  const executiveNumber = getExecutiveNumber(branch);
  
  const extracted = await extractWithOpenAI(imageUrl);
  
  const message = `
📸 *New Prescription Received*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${extracted.patientName}
🔬 Tests: ${extracted.tests}
👨‍⚕️ Doctor: ${extracted.doctorName}
🏥 Branch: ${branch}
📅 Time: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
📝 *OCR Preview:*
${extracted.rawText.substring(0, 300)}...
━━━━━━━━━━━━━━━━━━
🔗 Connect: ${SELF_URL}/connect-chat/${chatId}
✅ Convert: ${SELF_URL}/exec-action?action=convert&chat=${chatId}
⏳ Waiting: ${SELF_URL}/exec-action?action=waiting&chat=${chatId}
❌ Not Convert: ${SELF_URL}/exec-action?action=notconvert&chat=${chatId}
  `;
  
  await sendExecutiveNotification(executiveNumber, message);
  
  patientDB.set(chatId, {
    patientName,
    branch,
    imageUrl,
    extracted,
    executiveNumber,
    entryType: 'upload',
    status: 'processed',
    timestamp: new Date().toISOString(),
    chatId
  });
  
  processedImages.add(chatId);
}

function getExecutiveNumber(branch) {
  const teamName = `${branch} Team`;
  return EXECUTIVES[teamName] || process.env.DEFAULT_EXECUTIVE || '919825086011';
}

// ============================================
// BACKGROUND CRON JOB (हर 2 मिनट में)
// ============================================
cron.schedule('*/2 * * * *', async () => {
  console.log('🔍 [' + new Date().toLocaleTimeString() + '] Checking WATI for new chats...');
  
  try {
    const chats = await fetchRecentChats();
    
    for (const chat of chats) {
      if (processedChats.has(chat.id)) continue;
      
      const contact = await getContactDetails(chat.whatsappNumber);
      if (!contact) continue;
      
      const patientName = contact.customAttributes?.patient_name || 'Patient';
      const branch = contact.customAttributes?.branch_name || 'Main Branch';
      
      if (chat.lastMessage?.type === 'text') {
        const text = chat.lastMessage.text?.toLowerCase() || '';
        if (text.includes('manual entry') || text.includes('test name')) {
          const testNames = extractTestNames(chat.messages);
          await processManualEntry(chat.id, patientName, testNames, branch);
          processedChats.add(chat.id);
        }
      }
      else if (chat.lastMessage?.type === 'image') {
        const imageUrl = chat.lastMessage.mediaUrl;
        if (imageUrl) {
          await processImageUpload(chat.id, patientName, branch, imageUrl);
          processedChats.add(chat.id);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error in cron job:', error.message);
  }
});

function extractTestNames(messages) {
  if (!messages || !messages.length) return 'Not specified';
  
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'text' && msg.text && 
        !msg.text.toLowerCase().includes('please') && 
        !msg.text.toLowerCase().includes('enter') &&
        msg.text.length < 100) {
      return msg.text;
    }
  }
  return 'Not specified';
}

// ============================================
// OPENAI OCR FUNCTION
// ============================================
async function extractWithOpenAI(imageUrl) {
  try {
    console.log('🔍 Calling OpenAI Vision API with GPT-4o...');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
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
// EXECUTIVE DIRECT MESSAGE SYSTEM
// ============================================

// 1. Open Session for Executive
app.get('/open-session/:number', async (req, res) => {
  try {
    const { number } = req.params;
    
    console.log(`🔄 Opening session for ${number}...`);
    
    await axios.post(
      `${WATI_BASE_URL}/api/v1/sendSessionMessage/${number}?messageText=🔧%20Session%20Open%20Test%20Message`,
      {},
      {
        headers: { Authorization: `${WATI_TOKEN}` }
      }
    );
    
    res.json({ success: true, message: `✅ Session opened for ${number}` });
    
  } catch (error) {
    console.error('❌ Open session error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// 2. Direct Message to Executive
app.get('/direct-message', async (req, res) => {
  try {
    const { to, message } = req.query;
    
    if (!to || !message) {
      return res.status(400).json({ 
        error: 'Missing parameters. Use: /direct-message?to=919169959992&message=Hello' 
      });
    }
    
    console.log(`📤 Direct message to ${to}: ${message.substring(0, 50)}...`);
    
    const response = await axios.post(
      `${WATI_BASE_URL}/api/v1/sendSessionMessage/${to}?messageText=${encodeURIComponent(message)}`,
      {},
      {
        headers: { Authorization: `${WATI_TOKEN}` }
      }
    );
    
    res.json({ 
      success: true, 
      message: `✅ Message sent to ${to}`,
      response: response.data 
    });
    
  } catch (error) {
    console.error('❌ Direct message error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// 3. Keep All Executive Sessions Alive (हर 20 घंटे में)
cron.schedule('0 */20 * * *', async () => {
  console.log('🔄 Keeping executive sessions alive...');
  
  for (const num of ALL_EXECUTIVE_NUMBERS) {
    try {
      await axios.post(
        `${WATI_BASE_URL}/api/v1/sendSessionMessage/${num}?messageText=🔧%20System%20Ping%20Test%20Message`,
        {},
        {
          headers: { Authorization: `${WATI_TOKEN}` }
        }
      );
      console.log(`✅ Session alive for ${num}`);
      
      // Delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Failed for ${num}:`, error.message);
    }
  }
});

// ============================================
// TEST ENDPOINTS
// ============================================
app.get('/test-manual', async (req, res) => {
  try {
    const { patient, test, branch, exec } = req.query;
    
    if (!patient || !test || !branch || !exec) {
      return res.status(400).json({ 
        error: 'Missing parameters. Use: /test-manual?patient=Name&test=TestName&branch=Branch&exec=919169959992' 
      });
    }
    
    const chatId = `test-${Date.now()}`;
    
    const message = `
📋 *New Manual Test Entry (TEST)*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${patient}
🔬 Tests: ${test}
🏥 Branch: ${branch}
📅 Time: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
🔗 Connect: ${SELF_URL}/connect-chat/${chatId}
✅ Convert: ${SELF_URL}/exec-action?action=convert&chat=${chatId}
⏳ Waiting: ${SELF_URL}/exec-action?action=waiting&chat=${chatId}
❌ Not Convert: ${SELF_URL}/exec-action?action=notconvert&chat=${chatId}
    `;
    
    await sendExecutiveNotification(exec, message);
    
    res.json({ 
      success: true, 
      message: `Test manual entry sent to ${exec}`,
      chatId 
    });
    
  } catch (error) {
    console.error('❌ Test error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/test-upload', async (req, res) => {
  try {
    const { patient, branch, exec } = req.query;
    
    if (!patient || !branch || !exec) {
      return res.status(400).json({ 
        error: 'Missing parameters. Use: /test-upload?patient=Name&branch=Branch&exec=919169959992' 
      });
    }
    
    const chatId = `test-${Date.now()}`;
    
    const message = `
📸 *New Prescription Uploaded (TEST)*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${patient}
🔬 Tests: MRI Brain, CT Scan (demo data)
👨‍⚕️ Doctor: Dr. Sharma
🏥 Branch: ${branch}
📅 Time: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
📝 *OCR Preview:*
MRI Brain with contrast...
CT Scan whole abdomen...
━━━━━━━━━━━━━━━━━━
🔗 Connect: ${SELF_URL}/connect-chat/${chatId}
✅ Convert: ${SELF_URL}/exec-action?action=convert&chat=${chatId}
⏳ Waiting: ${SELF_URL}/exec-action?action=waiting&chat=${chatId}
❌ Not Convert: ${SELF_URL}/exec-action?action=notconvert&chat=${chatId}
    `;
    
    await sendExecutiveNotification(exec, message);
    
    res.json({ 
      success: true, 
      message: `Test upload entry sent to ${exec}`,
      chatId 
    });
    
  } catch (error) {
    console.error('❌ Test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// EXECUTIVE SYSTEM ENDPOINTS
// ============================================
app.get('/connect-chat/:chatId', (req, res) => {
  const { chatId } = req.params;
  res.redirect(`https://app.wati.io/chat/${chatId}`);
});

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
      const extracted = await extractWithOpenAI(mediaUrl);
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
    
    const extracted = await extractWithOpenAI(imageUrl);
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
    const result = await extractWithOpenAI(imageUrl);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'ok', 
    processed: processedImages.size,
    patients: patientDB.size,
    processedChats: processedChats.size,
    uptime: process.uptime() 
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Tata-WATI Webhook Server</h1>
    <p>OpenAI OCR + Executive System Active (Auto-Fetch Mode + Direct Messaging)</p>
    <ul>
      <li>✅ Auto-fetches from WATI every 2 minutes</li>
      <li>✅ Manual Entry & Upload both supported</li>
      <li>✅ No webhook nodes required in WATI</li>
      <li>✅ Executive notifications with Connect button</li>
      <li>✅ Direct messaging to executives</li>
      <li>✅ Auto session keeper (every 20 hours)</li>
      <li>✅ Follow-up reminders (9 AM)</li>
      <li>✅ Manager daily report (10 PM)</li>
    </ul>
    <p><a href="/health">Health Check</a></p>
  `);
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Template: ${TEMPLATE_NAME}`);
  console.log(`📍 OpenAI OCR: Active with GPT-4o`);
  console.log(`📍 Auto-Fetch Mode: Every 2 minutes`);
  console.log(`📍 Direct Messaging: ✅ Available`);
  console.log(`📍 Session Keeper: Every 20 hours`);
  console.log(`📍 Manual Entry: ✅ Supported`);
  console.log(`📍 Upload Entry: ✅ Supported`);
  console.log('='.repeat(60));
});
