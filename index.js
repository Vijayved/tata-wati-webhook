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
// ✅ FIXED: Number Normalization Functions
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
  if (!number) return '';
  let digits = String(number).replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length > 12) return '91' + digits.slice(-10);
  return digits;
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
// ✅ FIXED: WATI API Functions with Hybrid Approach
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

// ============================================
// ✅ NEW: Hybrid Executive Notification
// ============================================
async function ensureContactInWATI(number) {
  try {
    const normalized = normalizeWhatsAppNumber(number);
    console.log(`📇 Ensuring contact ${normalized} exists...`);
    
    await axios.post(
      `${WATI_BASE_URL}/api/v1/addContact/${normalized}`,
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
    return true;
  } catch (error) {
    console.error('⚠️ Contact add warning:', error.response?.data || error.message);
    return false;
  }
}

async function openSession(number) {
  try {
    const normalized = normalizeWhatsAppNumber(number);
    console.log(`🔄 Opening session for ${normalized}...`);
    
    await axios.post(
      `${WATI_BASE_URL}/api/v1/sendSessionMessage/${normalized}?messageText=🔧%20System%20Ping%20Test%20Message`,
      {},
      {
        headers: { Authorization: `${WATI_TOKEN}` }
      }
    );
    return true;
  } catch (error) {
    console.error('⚠️ Session open warning:', error.response?.data || error.message);
    return false;
  }
}

async function sendExecutiveNotification(executiveNumber, messageText) {
  const normalized = normalizeWhatsAppNumber(executiveNumber);
  console.log(`\n📬 Sending to executive: ${normalized}`);
  
  // Step 1: Ensure contact exists
  await ensureContactInWATI(normalized);
  
  // Step 2: Try session message
  try {
    const result = await sendSessionTextMessage(normalized, messageText);
    console.log(`✅ Session message sent successfully`);
    return result;
  } catch (sessionError) {
    console.log(`⚠️ Session failed:`, sessionError.response?.data || sessionError.message);
    
    // Step 3: If session fails, open session and retry
    if (sessionError.response?.status === 404 || 
        sessionError.response?.data?.info === 'Invalid Conversation') {
      
      console.log(`🔄 Session not open, opening now...`);
      await openSession(normalized);
      
      // Wait 2 seconds for session to establish
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      try {
        const retryResult = await sendSessionTextMessage(normalized, messageText);
        console.log(`✅ Session message sent after opening session`);
        return retryResult;
      } catch (retryError) {
        console.log(`⚠️ Retry failed:`, retryError.message);
      }
    }
    
    // Step 4: Fallback to template message
    console.log(`⚠️ Falling back to template message...`);
    try {
      const templateResult = await sendWatiTemplateMessage(normalized, 'System');
      console.log(`✅ Template message sent as fallback`);
      return templateResult;
    } catch (templateError) {
      console.error(`❌ All sending methods failed`);
      throw templateError;
    }
  }
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
    
    console.log('\n📋 ===== WATI API FETCH DEBUG ====');
    console.log(`⏰ Time Range: ${from} to ${to}`);
    
    const url = `${WATI_BASE_URL}/api/v1/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
    console.log(`📡 Fetching: ${url}`);
    
    const response = await axios.get(url, {
      headers: { Authorization: `${WATI_TOKEN}` }
    });
    
    if (response.data && Array.isArray(response.data)) {
      return response.data;
    } else if (response.data?.messages) {
      return response.data.messages;
    } else if (response.data?.data) {
      return response.data.data;
    }
    
    return [];
    
  } catch (error) {
    console.error('❌ Error fetching chats:', error.message);
    return [];
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
    
    let messagesList = [];
    if (Array.isArray(messages)) {
      messagesList = messages;
    } else if (messages?.messages) {
      messagesList = messages.messages;
    } else if (messages?.data) {
      messagesList = messages.data;
    } else {
      console.log(`⚠️ No messages found`);
      return;
    }
    
    for (const msg of messagesList) {
      const msgId = msg.id || msg.messageId || msg._id;
      if (!msgId || processedChats.has(msgId)) continue;
      
      const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
      if (!patientPhone) continue;
      
      const contact = await getContactDetails(patientPhone);
      
      let patientName = 'Patient';
      if (contact) {
        patientName = contact.name || 
                     contact.firstName || 
                     contact.fullName || 
                     contact.customAttributes?.patient_name || 
                     'Patient';
      }
      
      const branch = contact?.customAttributes?.branch_name || 'Main Branch';
      
      if (msg.type === 'text' || msg.messageType === 'text') {
        const text = msg.text || msg.body || '';
        const lowerText = text.toLowerCase();
        
        if (lowerText.includes('manual') || 
            lowerText.includes('test') || 
            lowerText.includes('mri') || 
            lowerText.includes('ct') || 
            lowerText.includes('xray') ||
            lowerText.includes('blood')) {
          
          await processManualEntry(msgId, patientName, text, branch, patientPhone);
          processedChats.add(msgId);
        }
      }
      else if (msg.type === 'image' || msg.messageType === 'image') {
        const imageUrl = msg.mediaUrl || msg.url || msg.image?.url;
        if (imageUrl) {
          await processImageUpload(msgId, patientName, branch, imageUrl, patientPhone);
          processedChats.add(msgId);
          processedImages.add(msgId);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error in cron job:', error.message);
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
// ✅ ADD CONTACT ENDPOINT
// ============================================
app.get('/add-contact/:number', async (req, res) => {
  try {
    const { number } = req.params;
    await ensureContactInWATI(number);
    res.json({ success: true, message: `✅ Contact ${number} added to WATI` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ OPEN SESSION ENDPOINT
// ============================================
app.get('/open-session/:number', async (req, res) => {
  try {
    const { number } = req.params;
    await openSession(number);
    res.json({ success: true, message: `✅ Session opened for ${number}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ EXECUTIVE SYSTEM ENDPOINTS
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

// ============================================
// ✅ SESSION KEEPER
// ============================================
cron.schedule('0 */20 * * *', async () => {
  console.log('🔄 Keeping executive sessions alive...');
  
  for (const num of ALL_EXECUTIVE_NUMBERS) {
    try {
      await openSession(num);
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
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ HEALTH CHECK
// ============================================
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
    <p>Hybrid Executive Notification System</p>
    <ul>
      <li>✅ <a href="/test-wati-api">Test WATI API</a></li>
      <li>✅ <a href="/add-contact/917880261858">Add Contact</a></li>
      <li>✅ <a href="/open-session/917880261858">Open Session</a></li>
      <li>✅ <a href="/test-exec?exec=917880261858">Test Executive</a></li>
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
  console.log(`📍 Hybrid Notification System Active`);
  console.log(`📍 Step 1: /add-contact/917880261858`);
  console.log(`📍 Step 2: /open-session/917880261858`);
  console.log(`📍 Step 3: /test-exec?exec=917880261858`);
  console.log('='.repeat(60));
});
