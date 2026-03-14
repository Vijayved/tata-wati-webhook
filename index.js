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
// IMPROVED: iPhone number normalization
// ============================================
function normalizeIndianNumber(number) {
  if (!number) return '';
  
  console.log('📱 Normalizing number:', number);
  
  // Step 1: Remove all special characters
  let digits = String(number).replace(/[\s\-\+\(\)]/g, '');
  console.log('Step 1 - After removing special chars:', digits);
  
  // Step 2: Remove 00 prefix (international format)
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    console.log('Step 2 - After removing 00:', digits);
  }
  
  // Step 3: Handle different lengths and formats
  if (digits.length === 10) {
    // Local number: 9876543210 → 919876543210
    digits = '91' + digits;
    console.log('Step 3a - 10-digit number, added 91:', digits);
  }
  else if (digits.length === 11 && digits.startsWith('0')) {
    // 0XXXXXXXXXX → 91XXXXXXXXXX
    digits = '91' + digits.slice(1);
    console.log('Step 3b - 11-digit with leading 0, converted:', digits);
  }
  else if (digits.length === 12) {
    if (digits.startsWith('91')) {
      // Already correct format: 91XXXXXXXXXX
      console.log('Step 3c - Already in correct format:', digits);
    } else {
      // 12 digits but not starting with 91, take last 10 and add 91
      const last10 = digits.slice(-10);
      digits = '91' + last10;
      console.log('Step 3d - 12 digits not starting with 91, converted:', digits);
    }
  }
  else if (digits.length > 12) {
    // More than 12 digits, take last 12
    digits = digits.slice(-12);
    console.log('Step 3e - More than 12 digits, took last 12:', digits);
  }
  
  // Final validation: must be 12 digits starting with 91
  if (digits.length === 12 && digits.startsWith('91')) {
    console.log('✅ Valid Indian number:', digits);
    return digits;
  } else {
    console.log('❌ Failed to normalize number:', number, '→', digits);
    return '';
  }
}

function normalizeWhatsAppNumber(number) {
  const local = normalizeIndianNumber(number);
  return local ? `${DEFAULT_COUNTRY_CODE}${local.slice(-10)}` : '';
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
// IMPROVED: iPhone caller number extraction
// ============================================
function getCallerNumberFromPayload(body) {
  console.log('🔍 Extracting caller number from payload...');
  
  // Comprehensive list of all possible fields where caller number might appear
  const possibleFields = [
    { key: 'caller_id_number', value: body.caller_id_number },
    { key: 'caller_number', value: body.caller_number },
    { key: 'from', value: body.from },
    { key: 'msisdn', value: body.msisdn },
    { key: 'mobile', value: body.mobile },
    { key: 'customer_number', value: body.customer_number },
    { key: 'customer_no_with_prefix', value: body.customer_no_with_prefix },
    { key: 'cli', value: body.cli },
    { key: 'caller', value: body.caller },
    { key: 'phone', value: body.phone },
    { key: 'source', value: body.source },
    { key: 'destination_number', value: body.destination_number },
    { key: 'ani', value: body.ani },  // Automatic Number Identification
    { key: 'calling_party', value: body.calling_party },
    { key: 'calling_number', value: body.calling_number }
  ];
  
  // First check all possible fields
  for (let field of possibleFields) {
    if (field.value) {
      console.log(`✅ Found caller number in field '${field.key}': ${field.value}`);
      return field.value;
    }
  }
  
  // If not found in specific fields, search through all fields for any number
  console.log('🔍 Searching all fields for numbers...');
  for (let key in body) {
    const value = body[key];
    if (value && typeof value === 'string') {
      // Look for patterns that look like phone numbers (at least 10 digits)
      const numbers = value.match(/\d{10,}/g);
      if (numbers) {
        console.log(`🔍 Found potential number in field '${key}': ${value} → extracted: ${numbers[0]}`);
        return numbers[0];
      }
    }
  }
  
  console.log('❌ No caller number found in payload');
  return '';
}

function getCalledNumberFromPayload(body) {
  console.log('🔍 Extracting called number from fields...');
  
  const possibleFields = [
    { key: 'call_to_number', value: body.call_to_number },
    { key: 'called_number', value: body.called_number },
    { key: 'to', value: body.to },
    { key: 'destination', value: body.destination },
    { key: 'did', value: body.did },
    { key: 'virtual_number', value: body.virtual_number },
    { key: 'called_party', value: body.called_party },
    { key: 'called_id', value: body.called_id }
  ];
  
  for (let field of possibleFields) {
    if (field.value) {
      console.log(`✅ Found called number in field '${field.key}': ${field.value}`);
      return field.value;
    }
  }
  
  console.log('❌ No called number found in payload');
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
// MAIN ENDPOINT - FIXED for iPhone
// ============================================
app.post('/tata-misscall', async (req, res) => {
  try {
    console.log('📞 Tata Miss Call Payload:', JSON.stringify(req.body, null, 2));
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    const calledNumberRaw = getCalledNumberFromPayload(req.body);
    
    if (!callerNumberRaw) {
      console.log('❌ Caller number not found in payload');
      return res.status(400).json({ success: false, error: 'Caller number not found' });
    }
    
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    if (!whatsappNumber) {
      console.log('❌ Invalid caller number after normalization:', callerNumberRaw);
      return res.status(400).json({ success: false, error: 'Invalid caller number' });
    }
    
    const branch = getBranchByCalledNumber(calledNumberRaw);
    console.log(`📞 Caller: ${callerNumberRaw} | WhatsApp: ${whatsappNumber} | Branch: ${branch.name}`);
    
    if (shouldSkipDuplicateMissCall(whatsappNumber, calledNumberRaw)) {
      console.log(`⚠️ Duplicate missed call skipped for ${whatsappNumber}`);
      return res.json({ success: true, skipped: true });
    }
    
    userContext.set(whatsappNumber, { 
      branch: branch.name, 
      executive: branch.executive, 
      stage: 'welcome_sent', 
      updatedAt: new Date().toISOString() 
    });
    
    await sendWatiTemplateMessage(whatsappNumber, branch.name);
    console.log(`✅ WhatsApp template sent to ${whatsappNumber} for branch ${branch.name}`);
    
    return res.json({ success: true, whatsappNumber, branch: branch.name });
    
  } catch (error) {
    console.error('❌ /tata-misscall error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// DEBUG ENDPOINT - Test iPhone payload
// ============================================
app.post('/debug-payload', (req, res) => {
  console.log('🔍 DEBUG - Full Payload:', JSON.stringify(req.body, null, 2));
  
  // Find all fields containing numbers
  const numbers = [];
  Object.keys(req.body).forEach(key => {
    const value = req.body[key];
    if (value && typeof value === 'string') {
      const matches = value.match(/\d{10,}/g);
      if (matches) {
        numbers.push({ key, value, extracted: matches[0] });
      }
    }
  });
  
  res.json({
    message: 'Payload received',
    fields: Object.keys(req.body),
    possibleNumbers: numbers,
    fullPayload: req.body
  });
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
    <p>Production Ready Version 3.0 - iPhone Fixed</p>
    <ul>
      <li>POST /tata-misscall - Tata Tele webhook</li>
      <li>POST /wati-webhook - WATI webhook</li>
      <li>POST /ocr-prescription - OCR endpoint</li>
      <li>POST /debug-payload - Debug iPhone payload</li>
      <li>GET /test-template?number=91XXXX&branch=Satellite - Test template</li>
      <li>GET /test-ocr?image=URL - Test OCR</li>
      <li>GET /health - Health check</li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Keep-alive URL: ${SELF_URL}/health`);
  console.log(`📍 iPhone Debug: POST /debug-payload`);
  console.log('='.repeat(60));
});
