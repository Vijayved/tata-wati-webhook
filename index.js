require('dotenv').config();

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Branch Configuration
const BRANCHES = {
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
  // Test Number
  [normalizeIndianNumber('917969690935')]: {
    name: 'Test Branch',
    executive: normalizeWhatsAppNumber('917880261858')
  }
};

const recentMissCalls = new Map();
const userContext = new Map();

// ============================================
// IPHONE SPECIAL: किसी भी format को handle करेगा
// ============================================
function normalizeIndianNumber(number) {
  if (!number) return '';
  
  console.log('📱 iPhone Normalizing:', number);
  
  // Remove ALL non-digit characters
  let digits = String(number).replace(/\D/g, '');
  console.log('Step 1 - Only digits:', digits);
  
  // अगर कुछ नहीं बचा तो return
  if (!digits) return '';
  
  // Remove leading 00 (international format)
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    console.log('Step 2 - After removing 00:', digits);
  }
  
  // अगर 91 से start हो और length 12 हो
  if (digits.startsWith('91') && digits.length === 12) {
    console.log('✅ Valid Indian number:', digits);
    return digits;
  }
  
  // अगल 91 से start हो और length 12 से ज्यादा हो
  if (digits.startsWith('91') && digits.length > 12) {
    digits = digits.slice(0, 12);
    console.log('Step 3 - Trimmed to 12 digits:', digits);
    return digits;
  }
  
  // अगर 91 से नहीं start होता
  if (digits.length >= 10) {
    // Last 10 digits लो
    const last10 = digits.slice(-10);
    digits = '91' + last10;
    console.log('Step 4 - Took last 10 digits and added 91:', digits);
    return digits;
  }
  
  console.log('❌ Could not normalize:', number);
  return '';
}

function normalizeWhatsAppNumber(number) {
  const normalized = normalizeIndianNumber(number);
  if (!normalized) return '';
  // WhatsApp number should be 91 + last 10 digits
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
// IPHONE SPECIAL: हर possible field से number ढूंढो
// ============================================
function getCallerNumberFromPayload(body) {
  console.log('🔍 iPhone: Searching for caller number...');
  console.log('🔍 Full Payload:', JSON.stringify(body, null, 2));
  
  // ALL possible fields where caller number might hide
  const possibleFields = [
    'caller_id_number', 'caller_number', 'from', 'msisdn', 'mobile',
    'customer_number', 'customer_no_with_prefix', 'cli', 'caller',
    'phone', 'source', 'destination_number', 'ani', 'calling_party',
    'calling_number', 'callerid', 'callerId', 'caller_id',
    'calleridnumber', 'callerid_number', 'source_number',
    'originating_number', 'originating', 'source_did',
    'caller_number_raw', 'caller_number_formatted'
  ];
  
  // First check all known fields
  for (let field of possibleFields) {
    if (body[field]) {
      console.log(`✅ iPhone: Found in field '${field}':`, body[field]);
      return String(body[field]);
    }
  }
  
  // If not found, search through EVERY field in the payload
  console.log('🔍 iPhone: Scanning ALL fields for numbers...');
  for (let key in body) {
    const value = body[key];
    if (value && typeof value === 'string') {
      // Check if string contains at least 10 digits
      const digits = value.replace(/\D/g, '');
      if (digits.length >= 10) {
        console.log(`✅ iPhone: Found number in field '${key}': ${value} (digits: ${digits})`);
        return value;
      }
    } else if (value && typeof value === 'number') {
      // If value is number, convert to string
      const strValue = String(value);
      if (strValue.length >= 10) {
        console.log(`✅ iPhone: Found number in field '${key}': ${strValue}`);
        return strValue;
      }
    }
  }
  
  // Special case: कहीं पूरा payload ही number तो नहीं?
  try {
    const stringified = JSON.stringify(body);
    const matches = stringified.match(/\d{10,}/);
    if (matches) {
      console.log(`✅ iPhone: Found number in stringified payload: ${matches[0]}`);
      return matches[0];
    }
  } catch (e) {}
  
  console.log('❌ iPhone: No caller number found anywhere!');
  return '';
}

function getCalledNumberFromPayload(body) {
  console.log('🔍 iPhone: Extracting called number...');
  
  const possibleFields = [
    'call_to_number', 'called_number', 'to', 'destination',
    'did', 'virtual_number', 'called_party', 'called_id',
    'calledid', 'calledid_number', 'destination_number',
    'terminating_number', 'terminating'
  ];
  
  for (let field of possibleFields) {
    if (body[field]) {
      console.log(`✅ iPhone: Found called number in field '${field}':`, body[field]);
      return String(body[field]);
    }
  }
  
  console.log('❌ iPhone: No called number found');
  return '';
}

function getTextFromWatiPayload(body) {
  return body?.text || body?.message || body?.data?.text || body?.buttonText || body?.interactiveButtonReply?.title || '';
}

function getMediaUrlFromWatiPayload(body) {
  return body?.imageUrl || body?.media?.url || body?.data?.imageUrl || body?.data?.media?.url || body?.url || '';
}

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
// MAIN ENDPOINT - iPhone Special
// ============================================
app.post('/tata-misscall', async (req, res) => {
  try {
    console.log('📞 Tata Miss Call Payload (iPhone check):', JSON.stringify(req.body, null, 2));
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    const calledNumberRaw = getCalledNumberFromPayload(req.body);
    
    if (!callerNumberRaw) {
      console.log('❌ iPhone: Caller number not found!');
      return res.status(400).json({ 
        success: false, 
        error: 'Caller number not found',
        message: 'Please check /debug-payload endpoint to see what iPhone is sending'
      });
    }
    
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    if (!whatsappNumber) {
      console.log('❌ iPhone: Invalid caller number after normalization:', callerNumberRaw);
      return res.status(400).json({ success: false, error: 'Invalid caller number' });
    }
    
    const branch = getBranchByCalledNumber(calledNumberRaw);
    console.log(`📞 iPhone Caller: ${callerNumberRaw} | WhatsApp: ${whatsappNumber} | Branch: ${branch.name}`);
    
    if (shouldSkipDuplicateMissCall(whatsappNumber, calledNumberRaw)) {
      console.log(`⚠️ iPhone: Duplicate missed call skipped for ${whatsappNumber}`);
      return res.json({ success: true, skipped: true });
    }
    
    userContext.set(whatsappNumber, { 
      branch: branch.name, 
      executive: branch.executive, 
      stage: 'welcome_sent', 
      updatedAt: new Date().toISOString() 
    });
    
    await sendWatiTemplateMessage(whatsappNumber, branch.name);
    console.log(`✅ iPhone: WhatsApp template sent to ${whatsappNumber} for branch ${branch.name}`);
    
    return res.json({ success: true, whatsappNumber, branch: branch.name });
    
  } catch (error) {
    console.error('❌ iPhone Error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// IPHONE DEBUG ENDPOINT - यहाँ से पकड़ में आएगा
// ============================================
app.post('/iphone-debug', (req, res) => {
  console.log('📱 IPHONE DEBUG - Full Payload:', JSON.stringify(req.body, null, 2));
  
  const result = {
    message: 'iPhone payload received',
    fields: {},
    possibleNumbers: []
  };
  
  // Check EVERY field
  for (let key in req.body) {
    const value = req.body[key];
    result.fields[key] = value;
    
    if (value && typeof value === 'string') {
      const digits = value.replace(/\D/g, '');
      if (digits.length >= 10) {
        result.possibleNumbers.push({
          field: key,
          original: value,
          digits: digits,
          normalized: '91' + digits.slice(-10)
        });
      }
    }
  }
  
  console.log('📱 iPhone Analysis:', JSON.stringify(result, null, 2));
  res.json(result);
});

app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('📨 WATI Webhook Payload:', JSON.stringify(req.body, null, 2));
    const from = normalizeWhatsAppNumber(req.body.from || req.body.whatsappNumber || req.body.sender);
    const text = String(getTextFromWatiPayload(req.body) || '').trim().toLowerCase();
    const mediaUrl = getMediaUrlFromWatiPayload(req.body);
    
    if (!from) {
      console.log('⚠️ No sender found in WATI webhook');
      return res.json({ received: true, ignored: true });
    }
    
    const context = userContext.get(from) || {};
    const branch = context.branch || 'Main Branch';
    const executive = context.executive || normalizeWhatsAppNumber(process.env.DEFAULT_EXECUTIVE || '919825086011');
    
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
      await sendExecutiveNotification(executive, `📸 *Prescription Received*\n🏥 Branch: ${branch}\n📱 Customer: ${from}\n👤 Patient: ${extracted.patientName}\n👨‍⚕️ Doctor: ${extracted.doctorName}\n🔬 Tests: ${extracted.tests}\n\n🔗 Image: ${mediaUrl}`);
      await sendSessionTextMessage(from, '✅ Aapki prescription receive ho gayi hai.');
      userContext.set(from, { ...context, stage: 'prescription_uploaded' });
    }
    
    return res.json({ received: true });
  } catch (error) {
    console.error('❌ /wati-webhook error:', error.message);
    return res.status(500).json({ received: false, error: error.message });
  }
});

app.post('/ocr-prescription', async (req, res) => {
  try {
    const { imageUrl, whatsappNumber, branch, executive } = req.body;
    if (!imageUrl || !whatsappNumber) {
      return res.status(400).json({ success: false, error: 'imageUrl and whatsappNumber are required' });
    }
    
    const extracted = await extractWithOCRSpace(imageUrl);
    const context = userContext.get(whatsappNumber) || {};
    const finalBranch = branch || context.branch || 'Not specified';
    const finalExecutive = executive || context.executive || normalizeWhatsAppNumber(process.env.DEFAULT_EXECUTIVE || '919825086011');
    
    const executiveMessage = `📸 *New Prescription Uploaded*\n━━━━━━━━━━━━━━━━━━\n🏥 *Branch:* ${finalBranch}\n👤 *Patient:* ${extracted.patientName}\n👨‍⚕️ *Doctor:* ${extracted.doctorName}\n🔬 *Tests:* ${extracted.tests}\n━━━━━━━━━━━━━━━━━━\n📝 *OCR Preview:*\n${extracted.rawText}\n\n🔗 Image: ${imageUrl}`;
    
    await sendExecutiveNotification(finalExecutive, executiveMessage);
    await sendSessionTextMessage(whatsappNumber, '✅ Aapki prescription receive ho gayi hai. Hamari team check karke aapse contact karegi.');
    
    userContext.set(whatsappNumber, { ...context, branch: finalBranch, executive: finalExecutive, stage: 'prescription_uploaded', updatedAt: new Date().toISOString() });
    
    return res.json({ success: true, extracted });
  } catch (error) {
    console.error('❌ /ocr-prescription error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/test-template', async (req, res) => {
  try {
    const number = normalizeWhatsAppNumber(req.query.number || '919106959092');
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
    <p>iPhone Special Version</p>
    <ul>
      <li>POST /tata-misscall - Tata Tele webhook</li>
      <li>POST /wati-webhook - WATI webhook</li>
      <li>POST /ocr-prescription - OCR endpoint</li>
      <li><b>POST /iphone-debug - iPhone Debug (use this first!)</b></li>
      <li>GET /test-template?number=91XXXX&branch=Satellite - Test template</li>
      <li>GET /test-ocr?image=URL - Test OCR</li>
      <li>GET /health - Health check</li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 iPhone Debug: POST /iphone-debug`);
  console.log('='.repeat(60));
});
