require('dotenv').config();

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// CONFIGURATION - Environment variables से
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
// BRANCH CONFIGURATION - Virtual numbers mapping
// ============================================
const BRANCHES = {
  // जो भी number यहाँ add करोगे, उस पर miss call आने पर branch detect होगी
  [normalizeIndianNumber(process.env.SATELLITE_NUMBER || '9898989898')]: {
    name: 'Satellite',
    executive: normalizeWhatsAppNumber(process.env.SATELLITE_EXECUTIVE || process.env.DEFAULT_EXECUTIVE || '919825086011')
  },
  [normalizeIndianNumber(process.env.NARODA_NUMBER || '9898989899')]: {
    name: 'Naroda',
    executive: normalizeWhatsAppNumber(process.env.NARODA_EXECUTIVE || process.env.DEFAULT_EXECUTIVE || '919825086011')
  },
  [normalizeIndianNumber(process.env.USMANPURA_NUMBER || '9898989897')]: {
    name: 'Usmanpura',
    executive: normalizeWhatsAppNumber(process.env.USMANPURA_EXECUTIVE || process.env.DEFAULT_EXECUTIVE || '919825086011')
  },
  [normalizeIndianNumber(process.env.VADAJ_NUMBER || '9898989896')]: {
    name: 'Vadaj',
    executive: normalizeWhatsAppNumber(process.env.VADAJ_EXECUTIVE || process.env.DEFAULT_EXECUTIVE || '919825086011')
  },
  // Test Number - यहाँ हर वो नंबर add करो जिसे test करना है
  [normalizeIndianNumber('917969690935')]: {
    name: 'Test Branch',
    executive: normalizeWhatsAppNumber('917880261858')
  }
};

// ============================================
// IN-MEMORY STORAGE
// ============================================
const recentMissCalls = new Map();  // Duplicate prevention के लिए
const userContext = new Map();      // User session के लिए

// ============================================
// HELPER FUNCTIONS - Number normalization
// ============================================
function normalizeIndianNumber(number) {
  if (!number) return '';
  
  console.log('📱 Normalizing number:', number);
  
  // Remove all non-digits
  let digits = String(number).replace(/\D/g, '');
  
  // Remove leading 00 if present
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  
  // Handle different lengths
  if (digits.length === 10) {
    // 10-digit local number
    return '91' + digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    // 11-digit starting with 0
    return '91' + digits.slice(1);
  } else if (digits.length === 12) {
    // 12-digit - check if already has 91
    if (digits.startsWith('91')) {
      return digits;
    } else {
      return '91' + digits.slice(-10);
    }
  } else if (digits.length > 12) {
    // Take last 12 digits
    return digits.slice(-12);
  }
  
  return '';
}

function normalizeWhatsAppNumber(number) {
  const normalized = normalizeIndianNumber(number);
  if (!normalized) return '';
  // WhatsApp number = 91 + last 10 digits
  return '91' + normalized.slice(-10);
}

function getBranchByCalledNumber(calledNumber) {
  const normalized = normalizeIndianNumber(calledNumber);
  return BRANCHES[normalized] || {
    name: 'Main Branch',
    executive: normalizeWhatsAppNumber(process.env.DEFAULT_EXECUTIVE || '919825086011')
  };
}

function shouldSkipDuplicateMissCall(whatsappNumber, calledNumber) {
  const key = `${whatsappNumber}_${normalizeIndianNumber(calledNumber)}`;
  const now = Date.now();
  const lastHit = recentMissCalls.get(key);
  if (lastHit && (now - lastHit) < DEDUPE_WINDOW_MS) {
    return true;
  }
  recentMissCalls.set(key, now);
  return false;
}

// ============================================
// PAYLOAD EXTRACTION - Tata Tele fields
// ============================================
function getCallerNumberFromPayload(body) {
  console.log('🔍 Extracting caller number...');
  
  // All possible fields where caller number might appear
  const possibleFields = [
    'caller_id_number', 'caller_number', 'from', 'msisdn', 'mobile',
    'customer_number', 'customer_no_with_prefix', 'cli', 'caller',
    'phone', 'source', 'ani', 'calling_party', 'calling_number'
  ];
  
  for (let field of possibleFields) {
    if (body[field]) {
      console.log(`✅ Found in field '${field}':`, body[field]);
      return String(body[field]);
    }
  }
  
  // If not found in specific fields, search all fields
  for (let key in body) {
    const value = body[key];
    if (value && typeof value === 'string') {
      const digits = value.replace(/\D/g, '');
      if (digits.length >= 10) {
        console.log(`✅ Found in field '${key}': ${value}`);
        return value;
      }
    }
  }
  
  console.log('❌ No caller number found');
  return '';
}

function getCalledNumberFromPayload(body) {
  const possibleFields = [
    'call_to_number', 'called_number', 'to', 'destination',
    'did', 'virtual_number', 'called_party'
  ];
  
  for (let field of possibleFields) {
    if (body[field]) {
      console.log(`✅ Found called number in field '${field}':`, body[field]);
      return String(body[field]);
    }
  }
  
  return '';
}

// ============================================
// WATI API FUNCTIONS - Universal sending
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
  try {
    console.log(`📱 Sending template to ANY number: ${whatsappNumber} for branch ${branchName}`);
    
    const payload = {
      template_name: TEMPLATE_NAME,
      broadcast_name: `misscall_${Date.now()}`,
      parameters: [
        { 
          name: '1', 
          value: branchName 
        }
      ]
    };
    
    const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
    
    const response = await callWatiApi(url, payload);
    console.log(`✅ Template sent to ${whatsappNumber}`);
    
    // Store in context
    userContext.set(whatsappNumber, {
      branch: branchName,
      lastMessage: new Date().toISOString(),
      stage: 'welcome_sent'
    });
    
    return response;
    
  } catch (error) {
    console.error(`❌ Template failed for ${whatsappNumber}, trying session message...`);
    
    // Fallback: session message
    try {
      const sessionPayload = {
        messageText: `Namaste! Aapne miss call kiya tha (${branchName} branch). Main aapki kya help kar sakta hoon?\n\n1. Book Test\n2. Upload Prescription\n3. Talk to Executive`,
        messageType: 'TEXT'
      };
      
      const sessionUrl = `${WATI_BASE_URL}/api/v1/sendSessionMessage/${encodeURIComponent(whatsappNumber)}`;
      
      const sessionResponse = await axios.post(sessionUrl, sessionPayload, {
        headers: {
          Authorization: WATI_TOKEN,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });
      
      console.log(`✅ Session message sent to ${whatsappNumber}`);
      return sessionResponse.data;
      
    } catch (sessionError) {
      console.error(`❌ Both template and session failed for ${whatsappNumber}`);
      throw sessionError;
    }
  }
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
    return { patientName: 'OCR Failed', doctorName: 'OCR Failed', tests: 'OCR Failed', rawText: '', error: error.message };
  }
}

function parsePrescriptionText(text) {
  const cleanText = String(text || '').trim();
  const patientMatch = cleanText.match(/Patient(?:\s*Name)?[:\s]+([A-Za-z\s]+)/i) || cleanText.match(/Name[:\s]+([A-Za-z\s]+)/i) || cleanText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/);
  const doctorMatch = cleanText.match(/Dr\.?\s*([A-Za-z\s]+)/i) || cleanText.match(/Doctor[:\s]+([A-Za-z\s]+)/i);
  const testKeywords = ['blood', 'x-ray', 'xray', 'ultrasound', 'cbc', 'thyroid', 'lipid', 'liver', 'kidney', 'urine', 'stool', 'ecg', 'mri', 'ct scan', 'ct', 'vitamin', 'sugar'];
  const foundTests = [];
  const lower = cleanText.toLowerCase();
  for (const keyword of testKeywords) {
    if (lower.includes(keyword)) {
      foundTests.push(keyword.toUpperCase());
    }
  }
  return {
    patientName: patientMatch ? patientMatch[1].trim() : 'Not found',
    doctorName: doctorMatch ? doctorMatch[1].trim() : 'Not found',
    tests: foundTests.length ? [...new Set(foundTests)].join(', ') : 'Not found',
    rawText: cleanText ? cleanText.slice(0, 500) : 'No OCR text found'
  };
}

// ============================================
// MAIN ENDPOINT - Tata Tele Webhook
// ============================================
app.post('/tata-misscall', async (req, res) => {
  try {
    console.log('📞 Tata Miss Call Payload:', JSON.stringify(req.body, null, 2));
    
    // Extract numbers from payload
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    const calledNumberRaw = getCalledNumberFromPayload(req.body);
    
    if (!callerNumberRaw) {
      console.log('❌ No caller number found');
      return res.status(400).json({ success: false, error: 'Caller number not found' });
    }
    
    // Normalize to WhatsApp format (91 + 10 digits)
    let whatsappNumber = String(callerNumberRaw).replace(/\D/g, '');
    if (whatsappNumber.length >= 10) {
      whatsappNumber = '91' + whatsappNumber.slice(-10);
    } else {
      console.log('❌ Invalid number format:', callerNumberRaw);
      return res.status(400).json({ success: false, error: 'Invalid number format' });
    }
    
    // Get branch from called number
    const branch = getBranchByCalledNumber(calledNumberRaw);
    
    console.log(`📞 Caller: ${callerNumberRaw} | WhatsApp: ${whatsappNumber} | Branch: ${branch.name}`);
    
    // Duplicate check - 10 minute window
    if (shouldSkipDuplicateMissCall(whatsappNumber, calledNumberRaw)) {
      console.log(`⏳ Duplicate call skipped for ${whatsappNumber}`);
      return res.json({ success: true, skipped: true });
    }
    
    // SEND WHATSAPP - किसी भी number पर
    await sendWatiTemplateMessage(whatsappNumber, branch.name);
    
    return res.json({ 
      success: true, 
      whatsappNumber, 
      branch: branch.name 
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// WATI WEBHOOK - Handle user replies
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('📨 WATI Webhook:', JSON.stringify(req.body, null, 2));
    
    const from = normalizeWhatsAppNumber(req.body.from || req.body.whatsappNumber || req.body.sender);
    const text = String(req.body.text || req.body.message || '').trim().toLowerCase();
    const mediaUrl = req.body.imageUrl || req.body.media?.url || '';
    
    if (!from) {
      return res.json({ received: true, ignored: true });
    }
    
    const context = userContext.get(from) || {};
    const branch = context.branch || 'Main Branch';
    const executive = context.executive || normalizeWhatsAppNumber(process.env.DEFAULT_EXECUTIVE || '919825086011');
    
    // Handle user replies
    if (text === '1') {
      await sendSessionTextMessage(from, `📅 *Book Test - ${branch} Branch*\nKripya apna naam, test ka naam, aur preferred date/time bhejiye.`);
      userContext.set(from, { ...context, stage: 'book_test_requested' });
      
    } else if (text === '2') {
      await sendSessionTextMessage(from, `📸 *Upload Prescription - ${branch} Branch*\nKripya prescription ki clear photo bhejiye.`);
      userContext.set(from, { ...context, stage: 'awaiting_prescription' });
      
    } else if (text === '3') {
      await sendSessionTextMessage(from, `👨‍💼 Aapko ${branch} branch ke executive se connect kiya ja raha hai.`);
      await sendExecutiveNotification(executive, `📞 *Executive Required*\nCustomer: ${from}\nBranch: ${branch}`);
      userContext.set(from, { ...context, stage: 'executive_requested' });
      
    } else if (mediaUrl && context.stage === 'awaiting_prescription') {
      const extracted = await extractWithOCRSpace(mediaUrl);
      await sendExecutiveNotification(executive, 
        `📸 *Prescription Received*\n🏥 Branch: ${branch}\n📱 Customer: ${from}\n👤 Patient: ${extracted.patientName}\n👨‍⚕️ Doctor: ${extracted.doctorName}\n🔬 Tests: ${extracted.tests}\n\n🔗 Image: ${mediaUrl}`
      );
      await sendSessionTextMessage(from, '✅ Aapki prescription receive ho gayi hai.');
      userContext.set(from, { ...context, stage: 'prescription_uploaded' });
    }
    
    return res.json({ received: true });
    
  } catch (error) {
    console.error('❌ WATI webhook error:', error.message);
    return res.status(500).json({ received: false, error: error.message });
  }
});

// ============================================
// OCR ENDPOINT
// ============================================
app.post('/ocr-prescription', async (req, res) => {
  try {
    const { imageUrl, whatsappNumber, branch, executive } = req.body;
    
    if (!imageUrl || !whatsappNumber) {
      return res.status(400).json({ success: false, error: 'imageUrl and whatsappNumber required' });
    }
    
    const extracted = await extractWithOCRSpace(imageUrl);
    const context = userContext.get(whatsappNumber) || {};
    const finalBranch = branch || context.branch || 'Not specified';
    const finalExecutive = executive || context.executive || normalizeWhatsAppNumber(process.env.DEFAULT_EXECUTIVE);
    
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
    <p>Universal WhatsApp Sending - किसी भी unique number पर message जाएगा!</p>
    <ul>
      <li>POST /tata-misscall - Tata Tele webhook</li>
      <li>POST /wati-webhook - WATI webhook</li>
      <li>POST /ocr-prescription - OCR endpoint</li>
      <li>GET /test-template?number=91XXXX&branch=Satellite - Test template</li>
      <li>GET /test-ocr?image=URL - Test OCR</li>
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
  console.log(`📍 Duplicate window: ${DEDUPE_WINDOW_MS/1000} seconds`);
  console.log('='.repeat(60));
});
