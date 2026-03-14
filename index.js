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

function getCallerNumberFromPayload(body) {
  return (
    body.caller_number ||
    body.from ||
    body.msisdn ||
    body.caller_id_number ||
    body.mobile ||
    body.customer_number ||
    body.cli ||
    ''
  );
}

function getCalledNumberFromPayload(body) {
  return (
    body.called_number ||
    body.to ||
    body.destination ||
    body.call_to_number ||
    body.did ||
    body.virtual_number ||
    ''
  );
}

function getTextFromWatiPayload(body) {
  return (
    body?.text ||
    body?.message ||
    body?.data?.text ||
    body?.buttonText ||
    body?.interactiveButtonReply?.title ||
    ''
  );
}

function getMediaUrlFromWatiPayload(body) {
  return (
    body?.imageUrl ||
    body?.media?.url ||
    body?.data?.imageUrl ||
    body?.data?.media?.url ||
    body?.url ||
    ''
  );
}

async function callWatiApi(url, data) {
  try {
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${WATI_TOKEN}`,
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

/**
 * NOTE:
 * First outbound message after missed call should be a TEMPLATE message, not session message.
 * WATI template API path/payload can differ by account/version.
 * Confirm the exact endpoint from your WATI docs/dashboard and update this function if needed.
 */
async function sendWatiTemplateMessage(whatsappNumber, branchName) {
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

  // IMPORTANT:
  // This endpoint may differ in your WATI account version.
  // If your account uses another template send endpoint, replace only this URL/payload.
  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;

  return await callWatiApi(url, payload);
}

async function sendSessionTextMessage(whatsappNumber, messageText) {
  const url = `${WATI_BASE_URL}/api/v1/sendSessionMessage/${encodeURIComponent(whatsappNumber)}`;
  const payload = {
    messageText,
    messageType: 'TEXT'
  };
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
    return {
      patientName: 'OCR Failed',
      doctorName: 'OCR Failed',
      tests: 'OCR Failed',
      rawText: '',
      error: error.message
    };
  }
}

function parsePrescriptionText(text) {
  const cleanText = String(text || '').trim();

  const patientMatch =
    cleanText.match(/Patient(?:\s*Name)?[:\s]+([A-Za-z\s]+)/i) ||
    cleanText.match(/Name[:\s]+([A-Za-z\s]+)/i) ||
    cleanText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/);

  const doctorMatch =
    cleanText.match(/Dr\.?\s*([A-Za-z\s]+)/i) ||
    cleanText.match(/Doctor[:\s]+([A-Za-z\s]+)/i);

  const testKeywords = [
    'blood',
    'x-ray',
    'xray',
    'ultrasound',
    'cbc',
    'thyroid',
    'lipid',
    'liver',
    'kidney',
    'urine',
    'stool',
    'ecg',
    'mri',
    'ct scan',
    'ct',
    'vitamin',
    'sugar'
  ];

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

    if (!callerNumberRaw) {
      return res.status(400).json({ success: false, error: 'Caller number not found in webhook payload' });
    }

    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    const branch = getBranchByCalledNumber(calledNumberRaw);

    if (!whatsappNumber) {
      return res.status(400).json({ success: false, error: 'Invalid caller number after normalization' });
    }

    if (shouldSkipDuplicateMissCall(whatsappNumber, calledNumberRaw)) {
      console.log(`⚠️ Duplicate missed call skipped for ${whatsappNumber}`);
      return res.json({
        success: true,
        skipped: true,
        reason: 'Duplicate missed call within dedupe window'
      });
    }

    userContext.set(whatsappNumber, {
      branch: branch.name,
      executive: branch.executive,
      stage: 'welcome_sent',
      updatedAt: new Date().toISOString()
    });

    await sendWatiTemplateMessage(whatsappNumber, branch.name);

    return res.json({
      success: true,
      whatsappNumber,
      branch: branch.name
    });
  } catch (error) {
    console.error('❌ /tata-misscall error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

app.post('/ocr-prescription', async (req, res) => {
  try {
    const { imageUrl, whatsappNumber, branch, executive } = req.body;

    if (!imageUrl || !whatsappNumber) {
      return res.status(400).json({
        success: false,
        error: 'imageUrl and whatsappNumber are required'
      });
    }

    const extracted = await extractWithOCRSpace(imageUrl);

    const context = userContext.get(whatsappNumber) || {};
    const finalBranch = branch || context.branch || 'Not specified';
    const finalExecutive = executive || context.executive || normalizeWhatsAppNumber(process.env.DEFAULT_EXECUTIVE || '919825086011');

    const executiveMessage = `📸 *New Prescription Uploaded*
━━━━━━━━━━━━━━━━━━
🏥 *Branch:* ${finalBranch}
👤 *Patient:* ${extracted.patientName}
👨‍⚕️ *Doctor:* ${extracted.doctorName}
🔬 *Tests:* ${extracted.tests}
━━━━━━━━━━━━━━━━━━
📝 *OCR Preview:*
${extracted.rawText}

🔗 Image: ${imageUrl}`;

    await sendExecutiveNotification(finalExecutive, executiveMessage);

    await sendSessionTextMessage(
      whatsappNumber,
      '✅ Aapki prescription receive ho gayi hai. Hamari team check karke aapse contact karegi.'
    );

    userContext.set(whatsappNumber, {
      ...context,
      branch: finalBranch,
      executive: finalExecutive,
      stage: 'prescription_uploaded',
      updatedAt: new Date().toISOString()
    });

    return res.json({
      success: true,
      extracted
    });
  } catch (error) {
    console.error('❌ /ocr-prescription error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('📨 WATI Webhook Payload:', JSON.stringify(req.body, null, 2));

    const from = normalizeWhatsAppNumber(req.body.from || req.body.whatsappNumber || req.body.sender);
    const text = String(getTextFromWatiPayload(req.body) || '').trim();
    const mediaUrl = getMediaUrlFromWatiPayload(req.body);

    if (!from) {
      return res.json({ received: true, ignored: true, reason: 'No sender found' });
    }

    const context = userContext.get(from) || {};
    const branch = context.branch || 'Main Branch';
    const executive = context.executive || normalizeWhatsAppNumber(process.env.DEFAULT_EXECUTIVE || '919825086011');

    if (text === '1') {
      await sendSessionTextMessage(
        from,
        `📅 *Book Test - ${branch} Branch*\nKripya apna naam, test ka naam, aur preferred date/time bhejiye. Hamari team aapse contact karegi.`
      );

      userContext.set(from, {
        ...context,
        stage: 'book_test_requested',
        updatedAt: new Date().toISOString()
      });
    } else if (text === '2') {
      await sendSessionTextMessage(
        from,
        `📸 *Upload Prescription - ${branch} Branch*\nKripya prescription ki clear photo bhejiye.`
      );

      userContext.set(from, {
        ...context,
        stage: 'awaiting_prescription',
        updatedAt: new Date().toISOString()
      });
    } else if (text === '3') {
      await sendSessionTextMessage(
        from,
        `👨‍💼 Aapko ${branch} branch ke executive se connect kiya ja raha hai.`
      );

      await sendExecutiveNotification(
        executive,
        `📞 *Executive Assistance Required*\nCustomer: ${from}\nBranch: ${branch}\nReason: Talk to Executive`
      );

      userContext.set(from, {
        ...context,
        stage: 'executive_requested',
        updatedAt: new Date().toISOString()
      });
    } else if (mediaUrl && context.stage === 'awaiting_prescription') {
      const extracted = await extractWithOCRSpace(mediaUrl);

      await sendExecutiveNotification(
        executive,
        `📸 *Prescription Received*
🏥 Branch: ${branch}
📱 Customer: ${from}
👤 Patient: ${extracted.patientName}
👨‍⚕️ Doctor: ${extracted.doctorName}
🔬 Tests: ${extracted.tests}

📝 OCR Preview:
${extracted.rawText}

🔗 Image: ${mediaUrl}`
      );

      await sendSessionTextMessage(
        from,
        '✅ Aapki prescription receive ho gayi hai. Hamari team aapse jald contact karegi.'
      );

      userContext.set(from, {
        ...context,
        stage: 'prescription_uploaded',
        updatedAt: new Date().toISOString()
      });
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('❌ /wati-webhook error:', error.response?.data || error.message);
    return res.status(500).json({
      received: false,
      error: error.response?.data || error.message
    });
  }
});

app.get('/test-wati-session', async (req, res) => {
  try {
    const number = normalizeWhatsAppNumber(req.query.number || '919106959092');
    await sendSessionTextMessage(number, '✅ Test session message');
    res.json({ success: true, number });
  } catch (error) {
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

app.get('/test-template', async (req, res) => {
  try {
    const number = normalizeWhatsAppNumber(req.query.number || '919106959092');
    const branch = req.query.branch || 'Satellite';
    const result = await sendWatiTemplateMessage(number, branch);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

app.get('/test-ocr', async (req, res) => {
  try {
    const imageUrl = req.query.image;
    if (!imageUrl) {
      return res.status(400).json({ success: false, error: 'image query parameter required' });
    }
    const result = await extractWithOCRSpace(imageUrl);
    return res.json({ success: true, result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Tata-WATI Webhook Server</h1>
    <ul>
      <li>POST /tata-misscall</li>
      <li>POST /wati-webhook</li>
      <li>POST /ocr-prescription</li>
      <li>GET /test-template?number=91XXXXXXXXXX&branch=Satellite</li>
      <li>GET /test-wati-session?number=91XXXXXXXXXX</li>
      <li>GET /test-ocr?image=IMAGE_URL</li>
      <li>GET /health</li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Base URL ready`);
  console.log(`📍 POST /tata-misscall`);
  console.log(`📍 POST /wati-webhook`);
  console.log(`📍 POST /ocr-prescription`);
  console.log('='.repeat(60));
});
