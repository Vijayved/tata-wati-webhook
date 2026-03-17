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
  'Naroda Team': process.env.NARODA_EXECUTIVE || '917880261858',
  'Manager': process.env.MANAGER_NUMBER || '919825086099'
};

const ALL_EXECUTIVE_NUMBERS = [
  process.env.NARODA_EXECUTIVE || '917880261858',
  process.env.MANAGER_NUMBER || '919825086099'
].filter(Boolean);

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
// ✅ TESTING FUNCTION: Direct API Test
// ============================================
app.get('/test-wati-api', async (req, res) => {
  try {
    console.log('🧪 Testing WATI API connection...');
    
    const testUrl = `${WATI_BASE_URL}/api/v1/getContacts?pageSize=1`;
    const response = await axios.get(testUrl, {
      headers: { Authorization: `${WATI_TOKEN}` }
    });
    
    res.json({
      success: true,
      message: '✅ WATI API working!',
      data: response.data
    });
  } catch (error) {
    res.json({
      success: false,
      message: '❌ WATI API failed',
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
  }
});

// ============================================
// ✅ FETCH FUNCTION WITH FULL LOGGING
// ============================================
async function fetchRecentChats() {
  try {
    const from = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const to = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    // Log what we're about to do
    console.log('\n📋 ===== WATI API FETCH DEBUG ====');
    console.log(`⏰ Time Range: ${from} to ${to}`);
    
    // Try v1 endpoint
    const url = `${WATI_BASE_URL}/api/v1/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
    console.log(`📡 Attempt 1 (v1): ${url}`);
    
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `${WATI_TOKEN}` }
      });
      
      console.log(`✅ v1 Success! Status: ${response.status}`);
      console.log(`📦 Response type: ${typeof response.data}`);
      console.log(`📦 Response structure:`, Object.keys(response.data || {}));
      
      return response.data || [];
      
    } catch (v1Error) {
      console.log(`❌ v1 Failed: ${v1Error.message}`);
      console.log(`❌ v1 Status: ${v1Error.response?.status}`);
      console.log(`❌ v1 Data:`, v1Error.response?.data);
      
      // Try v2 endpoint as fallback
      console.log(`\n📡 Attempt 2 (v2): Trying v2 endpoint...`);
      const v2Url = `${WATI_BASE_URL}/api/v2/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
      
      try {
        const v2Response = await axios.get(v2Url, {
          headers: { Authorization: `${WATI_TOKEN}` }
        });
        
        console.log(`✅ v2 Success! Status: ${v2Response.status}`);
        return v2Response.data || [];
        
      } catch (v2Error) {
        console.log(`❌ v2 Failed: ${v2Error.message}`);
        console.log(`❌ v2 Status: ${v2Error.response?.status}`);
        console.log(`❌ v2 Data:`, v2Error.response?.data);
        return [];
      }
    }
  } catch (error) {
    console.error('❌ Unexpected error in fetch:', error.message);
    return [];
  } finally {
    console.log('📋 ===== END DEBUG ====\n');
  }
}

// ============================================
// ✅ GET CONTACT DETAILS WITH LOGGING
// ============================================
async function getContactDetails(whatsappNumber) {
  try {
    console.log(`\n👤 Fetching contact details for ${whatsappNumber}`);
    
    const url = `${WATI_BASE_URL}/api/v1/getContacts?pageSize=1&name=${whatsappNumber}`;
    
    const response = await axios.get(url, {
      headers: { Authorization: `${WATI_TOKEN}` }
    });
    
    console.log(`✅ Contact fetch success`);
    
    if (response.data && Array.isArray(response.data)) {
      return response.data[0] || null;
    } else if (response.data?.contacts && Array.isArray(response.data.contacts)) {
      return response.data.contacts[0] || null;
    } else if (response.data?.data && Array.isArray(response.data.data)) {
      return response.data.data[0] || null;
    }
    
    return null;
  } catch (error) {
    console.error(`❌ Error fetching contact:`, error.message);
    return null;
  }
}

// ============================================
// ✅ PROCESS FUNCTIONS WITH LOGGING
// ============================================
async function processManualEntry(chatId, patientName, testNames, branch, patientPhone) {
  console.log(`\n📝 === PROCESSING MANUAL ENTRY ===`);
  console.log(`📝 Chat ID: ${chatId}`);
  console.log(`📝 Patient: ${patientName}`);
  console.log(`📝 Tests: ${testNames}`);
  console.log(`📝 Branch: ${branch}`);
  console.log(`📝 Phone: ${patientPhone}`);
  
  const executiveNumber = getExecutiveNumber(branch);
  console.log(`📝 Executive Number: ${executiveNumber}`);
  
  const message = `
📋 *New Test Booking*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${patientName}
🔬 Tests: ${testNames}
🏥 Branch: ${branch}
📱 Patient: ${patientPhone}
📅 Time: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
🔗 Connect: ${SELF_URL}/connect-chat/${chatId}
✅ Convert: ${SELF_URL}/exec-action?action=convert&chat=${chatId}
⏳ Waiting: ${SELF_URL}/exec-action?action=waiting&chat=${chatId}
❌ Not Convert: ${SELF_URL}/exec-action?action=notconvert&chat=${chatId}
  `;
  
  console.log(`📤 Sending WhatsApp to ${executiveNumber}...`);
  
  try {
    await sendExecutiveNotification(executiveNumber, message);
    console.log(`✅ WhatsApp sent successfully!`);
  } catch (error) {
    console.error(`❌ WhatsApp send failed:`, error.message);
  }
  
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
  
  console.log(`📝 === END MANUAL PROCESSING ===\n`);
}

async function processImageUpload(chatId, patientName, branch, imageUrl, patientPhone) {
  console.log(`\n📸 === PROCESSING IMAGE UPLOAD ===`);
  console.log(`📸 Chat ID: ${chatId}`);
  console.log(`📸 Patient: ${patientName}`);
  console.log(`📸 Branch: ${branch}`);
  console.log(`📸 Image URL: ${imageUrl}`);
  
  const executiveNumber = getExecutiveNumber(branch);
  console.log(`📸 Executive Number: ${executiveNumber}`);
  
  console.log(`🔍 Calling OpenAI OCR...`);
  const extracted = await extractWithOpenAI(imageUrl);
  console.log(`✅ OCR Result:`, extracted);
  
  const message = `
📸 *New Prescription Received*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${extracted.patientName}
🔬 Tests: ${extracted.tests}
👨‍⚕️ Doctor: ${extracted.doctorName}
🏥 Branch: ${branch}
📱 Patient: ${patientPhone}
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
  
  console.log(`📤 Sending WhatsApp to ${executiveNumber}...`);
  
  try {
    await sendExecutiveNotification(executiveNumber, message);
    console.log(`✅ WhatsApp sent successfully!`);
  } catch (error) {
    console.error(`❌ WhatsApp send failed:`, error.message);
  }
  
  patientDB.set(chatId, {
    patientName,
    branch,
    imageUrl,
    extracted,
    patientPhone,
    executiveNumber,
    entryType: 'upload',
    status: 'processed',
    timestamp: new Date().toISOString(),
    chatId
  });
  
  processedImages.add(chatId);
  console.log(`📸 === END IMAGE PROCESSING ===\n`);
}

function getExecutiveNumber(branch) {
  const teamName = `${branch} Team`;
  return EXECUTIVES[teamName] || process.env.DEFAULT_EXECUTIVE || '917880261858';
}

// ============================================
// ✅ BACKGROUND CRON JOB WITH DETAILED LOGGING
// ============================================
cron.schedule('*/2 * * * *', async () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🔍 [${new Date().toLocaleTimeString()}] Starting fetch cycle...`);
  
  try {
    const messages = await fetchRecentChats();
    
    console.log(`📦 Raw messages data:`, messages);
    
    // Parse messages based on structure
    let messagesList = [];
    if (Array.isArray(messages)) {
      messagesList = messages;
      console.log(`✅ Found ${messagesList.length} messages in array format`);
    } else if (messages?.messages && Array.isArray(messages.messages)) {
      messagesList = messages.messages;
      console.log(`✅ Found ${messagesList.length} messages in .messages format`);
    } else if (messages?.data && Array.isArray(messages.data)) {
      messagesList = messages.data;
      console.log(`✅ Found ${messagesList.length} messages in .data format`);
    } else {
      console.log(`⚠️ Unexpected message format:`, messages);
      return;
    }
    
    if (messagesList.length === 0) {
      console.log(`ℹ️ No new messages found`);
      return;
    }
    
    for (const msg of messagesList) {
      console.log(`\n📨 Processing message:`, msg);
      
      const msgId = msg.id || msg.messageId || msg._id;
      if (!msgId) {
        console.log(`⚠️ Message has no ID, skipping`);
        continue;
      }
      
      if (processedChats.has(msgId)) {
        console.log(`⏭️ Message ${msgId} already processed, skipping`);
        continue;
      }
      
      const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
      if (!patientPhone) {
        console.log(`⚠️ Message has no phone number, skipping`);
        continue;
      }
      
      console.log(`📞 Patient Phone: ${patientPhone}`);
      
      const contact = await getContactDetails(patientPhone);
      
      let patientName = 'Patient';
      if (contact) {
        patientName = contact.name || 
                     contact.firstName || 
                     contact.fullName || 
                     contact.customAttributes?.patient_name || 
                     'Patient';
      }
      console.log(`👤 Patient Name: ${patientName}`);
      
      const branch = contact?.customAttributes?.branch_name || 'Main Branch';
      console.log(`🏥 Branch: ${branch}`);
      
      if (msg.type === 'text' || msg.messageType === 'text') {
        const text = msg.text || msg.body || '';
        console.log(`📝 Text message: "${text}"`);
        
        const lowerText = text.toLowerCase();
        if (lowerText.includes('manual') || 
            lowerText.includes('test') || 
            lowerText.includes('mri') || 
            lowerText.includes('ct') || 
            lowerText.includes('xray') ||
            lowerText.includes('blood')) {
          
          console.log(`✅ Detected as manual test entry`);
          await processManualEntry(msgId, patientName, text, branch, patientPhone);
          processedChats.add(msgId);
        } else {
          console.log(`⏭️ Not a manual test entry, skipping`);
        }
      }
      else if (msg.type === 'image' || msg.messageType === 'image') {
        console.log(`📸 Detected image message`);
        const imageUrl = msg.mediaUrl || msg.url || msg.image?.url;
        if (imageUrl) {
          console.log(`📸 Image URL: ${imageUrl}`);
          await processImageUpload(msgId, patientName, branch, imageUrl, patientPhone);
          processedChats.add(msgId);
          processedImages.add(msgId);
        } else {
          console.log(`⚠️ Image message has no URL`);
        }
      } else {
        console.log(`⏭️ Unhandled message type: ${msg.type}`);
      }
    }
  } catch (error) {
    console.error('❌ Error in cron job:', error.message);
    console.error(error.stack);
  }
  
  console.log('='.repeat(60) + '\n');
});

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
    console.log(`✅ OpenAI Response received`);
    
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
// ✅ TEST ENDPOINT: Send test message to executive
// ============================================
app.get('/test-exec', async (req, res) => {
  try {
    const { exec } = req.query;
    const executiveNumber = exec || '917880261858';
    
    console.log(`🧪 Testing executive message to ${executiveNumber}`);
    
    const testMessage = `
🧪 *TEST MESSAGE*
━━━━━━━━━━━━━━━━━━
This is a test message from your Render server.
Time: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
✅ If you see this, WhatsApp is working!
    `;
    
    await sendExecutiveNotification(executiveNumber, testMessage);
    
    res.json({
      success: true,
      message: `Test message sent to ${executiveNumber}`,
      time: new Date().toLocaleString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// ✅ TEST ENDPOINT: Check all configurations
// ============================================
app.get('/test-config', (req, res) => {
  res.json({
    success: true,
    config: {
      WATI_BASE_URL,
      TEMPLATE_NAME,
      executives: EXECUTIVES,
      branches: BRANCHES,
      processedChats: processedChats.size,
      processedImages: processedImages.size,
      patients: patientDB.size
    }
  });
});

// ============================================
// ✅ ADD CONTACT ENDPOINT
// ============================================
app.get('/add-contact/:number', async (req, res) => {
  try {
    const { number } = req.params;
    
    console.log(`📇 Adding contact ${number} to WATI...`);
    
    const response = await axios.post(
      `${WATI_BASE_URL}/api/v1/addContact/${number}`,
      { 
        name: `Executive_${number}`,
        customParams: [
          { name: "source", value: "render_server" },
          { name: "role", value: "executive" }
        ]
      },
      {
        headers: { 
          Authorization: `${WATI_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    res.json({ 
      success: true, 
      message: `✅ Contact ${number} added to WATI`,
      response: response.data 
    });
    
  } catch (error) {
    console.error('❌ Add contact error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: error.response?.data || error.message 
    });
  }
});

// ============================================
// ✅ EXECUTIVE SYSTEM ENDPOINTS
// ============================================
app.get('/connect-chat/:chatId', (req, res) => {
  const { chatId } = req.params;
  console.log(`🔗 Connect button clicked for chat ${chatId}`);
  res.redirect(`https://app.wati.io/chat/${chatId}`);
});

app.get('/exec-action', async (req, res) => {
  const { action, chat } = req.query;
  console.log(`🎯 Executive action: ${action} for chat ${chat}`);
  
  const patient = patientDB.get(chat);
  if (!patient) {
    return res.send('❌ Patient not found');
  }
  
  switch(action) {
    case 'convert':
      patient.status = 'converted';
      patientDB.set(chat, patient);
      await sendExecutiveNotification(patient.executiveNumber,
        `✅ Patient ${patient.patientName} marked as CONVERTED`);
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
        `📤 *Escalation*\nPatient: ${patient.patientName}\nBranch: ${patient.branch}\nExecutive: ${patient.executiveNumber}`);
      await sendExecutiveNotification(patient.executiveNumber,
        `❌ Patient ${patient.patientName} escalated to manager`);
      break;
  }
  
  res.send('✅ Action recorded!');
});

app.get('/open-session/:number', async (req, res) => {
  try {
    const { number } = req.params;
    
    console.log(`🔄 Opening session for ${number}...`);
    
    const response = await axios.post(
      `${WATI_BASE_URL}/api/v1/sendSessionMessage/${number}?messageText=🔧%20Session%20Open%20Test%20Message`,
      {},
      {
        headers: { Authorization: `${WATI_TOKEN}` }
      }
    );
    
    res.json({ success: true, message: `✅ Session opened for ${number}`, response: response.data });
    
  } catch (error) {
    console.error('❌ Open session error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.get('/direct-message', async (req, res) => {
  try {
    const { to, message } = req.query;
    
    if (!to || !message) {
      return res.status(400).json({ 
        error: 'Missing parameters. Use: /direct-message?to=917880261858&message=Hello' 
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

// ============================================
// ✅ SESSION KEEPER
// ============================================
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
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Failed for ${num}:`, error.message);
    }
  }
});

// ============================================
// ✅ TEST ENDPOINTS
// ============================================
app.get('/test-manual', async (req, res) => {
  try {
    const { patient, test, branch, exec } = req.query;
    
    if (!patient || !test || !branch || !exec) {
      return res.status(400).json({ 
        error: 'Missing parameters. Use: /test-manual?patient=Name&test=TestName&branch=Branch&exec=917880261858' 
      });
    }
    
    const chatId = `test-${Date.now()}`;
    console.log(`🧪 Manual test triggered for ${patient} to ${exec}`);
    
    const message = `
📋 *New Test Booking (TEST)*
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
        error: 'Missing parameters. Use: /test-upload?patient=Name&branch=Branch&exec=917880261858' 
      });
    }
    
    const chatId = `test-${Date.now()}`;
    console.log(`🧪 Upload test triggered for ${patient} to ${exec}`);
    
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
// ✅ MAIN ENDPOINTS
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
    const executive = context.executive || process.env.DEFAULT_EXECUTIVE || '917880261858';
    
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
    const finalExecutive = executive || context.executive || process.env.DEFAULT_EXECUTIVE || '917880261858';
    
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
// ✅ TEST ENDPOINTS
// ============================================
app.get('/test-template', async (req, res) => {
  try {
    const number = req.query.number || '919106959092';
    const branch = req.query.branch || 'Naroda';
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
    <p>Testing Mode - Every step is logged</p>
    <ul>
      <li>✅ <a href="/test-wati-api">Test WATI API</a> - Check if WATI is working</li>
      <li>✅ <a href="/test-config">Test Config</a> - Check your configuration</li>
      <li>✅ <a href="/test-exec?exec=917880261858">Test Executive</a> - Send test message to executive</li>
      <li>✅ <a href="/health">Health Check</a></li>
    </ul>
  `);
});

// ============================================
// ✅ START SERVER
// ============================================
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Template: ${TEMPLATE_NAME}`);
  console.log(`📍 OpenAI OCR: Active with GPT-4o`);
  console.log(`📍 Testing Executive: 917880261858`);
  console.log('📍 Test URLs:');
  console.log(`   - /test-wati-api - Check WATI connection`);
  console.log(`   - /test-config - View config`);
  console.log(`   - /test-exec?exec=917880261858 - Send test message`);
  console.log('='.repeat(60));
});
