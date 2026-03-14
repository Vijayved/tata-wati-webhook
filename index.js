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

if (!WATI_TOKEN || !WATI_BASE_URL) {
  console.error('❌ Missing WATI configuration in .env');
  process.exit(1);
}

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

function normalizeIndianNumber(number) {
  if (!number) return '';
  let digits = String(number).replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length > 10) {
    digits = digits.slice(-10);
  } else if (digits.length > 10) {
    digits = digits.slice(-10);
  }
  return digits;
}

function normalizeWhatsAppNumber(number) {
  const local = normalizeIndianNumber(number);
  return local ? `${DEFAULT_COUNTRY_CODE}${local}` : '';
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
// ✅ FIXED: Tata Tele field names के साथ
// ============================================
function getCallerNumberFromPayload(body) {
  return body.caller_id_number ||      // नया field (screenshot में दिखा)
         body.caller_number || 
         body.from || 
         body.msisdn || 
         body.caller_id_number || 
         body.mobile || 
         body.customer_number ||
         body.customer_no_with_prefix || // नया field
         body.cli || 
         '';
}

function getCalledNumberFromPayload(body) {
  return body.call_to_number ||        // नया field (screenshot में दिखा)
         body.called_number || 
         body.to || 
         body.destination || 
         body.did || 
         body.virtual_number || 
         '';
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

app.post('/tata-misscall', async (req, res) => {
  try {
    console.log('📞 Tata Miss Call Payload:', JSON.stringify(req.body, null, 2));
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    const calledNumberRaw = getCalledNumberFromPayload(req.body);
    if (!callerNumberRaw) return res.status(400).json({ success: false, error: 'Caller number not found' });
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    const branch = getBranchByCalledNumber(calledNumberRaw);
    if (!whatsappNumber) return res.status(400).json({ success: false, error: 'Invalid caller number' });
    if (shouldSkipDuplicateMissCall(whatsappNumber, calledNumberRaw)) {
      console.log(`⚠️ Duplicate missed call skipped for ${whatsappNumber}`);
      return res.json({ success: true, skipped: true });
    }
    userContext.set(whatsappNumber, { branch: branch.name, executive: branch.executive, stage: 'welcome_sent', updatedAt: new Date().toISOString() });
    await sendWatiTemplateMessage(whatsappNumber, branch.name);
    return res.json({ success: true, whatsappNumber, branch: branch.name });
  } catch (error) {
    console.error('❌ /tata-misscall error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('📨 WATI Webhook Payload:', JSON.stringify(req.body, null, 2));
    const from = normalizeWhatsAppNumber(req.body.from || req.body.whatsappNumber || req.body.sender);
    const text = String(getTextFromWatiPayload(req.body) || '').trim();
    const mediaUrl = getMediaUrlFromWatiPayload(req.body);
    if (!from) return res.json({ received: true, ignored: true });
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
    <p>Production Ready Version 2.0</p>
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

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('='.repeat(60));
});
