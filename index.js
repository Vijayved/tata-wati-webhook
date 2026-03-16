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
// META CLOUD API CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3000;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'uic_webhook_2026';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91';
const DEDUPE_WINDOW_MS = (parseInt(process.env.DEDUPE_WINDOW_SECONDS || '600', 10)) * 1000;
const TEMPLATE_NAME = process.env.MISSCALL_TEMPLATE_NAME || 'misscall_welcome_v3';
const META_API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}`;

// OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Keep-alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://tata-wati-webhook.onrender.com';
if (SELF_URL) {
  setInterval(() => {
    axios.get(`${SELF_URL}/health`).catch(() => {});
  }, 14 * 60 * 1000);
}

if (!META_ACCESS_TOKEN || !PHONE_NUMBER_ID) {
  console.error('❌ Missing Meta Cloud API configuration in .env');
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
// META CLOUD API FUNCTIONS
// ============================================

// Send template message
async function sendMetaTemplateMessage(whatsappNumber, branchName) {
  try {
    console.log(`📱 Sending template to ${whatsappNumber} for branch ${branchName}`);
    
    const response = await axios.post(
      `${META_API_URL}/messages`,
      {
        messaging_product: "whatsapp",
        to: whatsappNumber,
        type: "template",
        template: {
          name: TEMPLATE_NAME,
          language: {
            code: "en_US"
          },
          components: [
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  text: branchName
                }
              ]
            }
          ]
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('❌ Meta API Error:', error.response?.data || error.message);
    throw error;
  }
}

// Send text message
async function sendMetaTextMessage(whatsappNumber, messageText) {
  try {
    console.log(`📤 Sending text to ${whatsappNumber}`);
    
    const response = await axios.post(
      `${META_API_URL}/messages`,
      {
        messaging_product: "whatsapp",
        to: whatsappNumber,
        type: "text",
        text: {
          body: messageText
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('❌ Meta API Error:', error.response?.data || error.message);
    throw error;
  }
}

// Send to executive
async function sendExecutiveNotification(executiveNumber, messageText) {
  return await sendMetaTextMessage(executiveNumber, messageText);
}

// Send patient template
async function sendPatientTemplate(whatsappNumber, branchName) {
  return await sendMetaTemplateMessage(whatsappNumber, branchName);
}

// ============================================
// META WEBHOOK - GET (Verification)
// ============================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode && token) {
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      console.log('✅ Webhook verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// ============================================
// META WEBHOOK - POST (Incoming messages)
// ============================================
app.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Meta Webhook:', JSON.stringify(req.body, null, 2));
    
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    
    if (!value) {
      return res.sendStatus(200);
    }
    
    const messages = value.messages;
    const contacts = value.contacts;
    
    if (!messages || !contacts) {
      return res.sendStatus(200);
    }
    
    const message = messages[0];
    const contact = contacts[0];
    const from = message.from;
    const patientName = contact.profile?.name || 'Patient';
    
    if (message.type === 'text') {
      const text = message.text.body.toLowerCase();
      
      if (text === '1') {
        await sendMetaTextMessage(from, `📅 *Book Test*\nKripya apna naam bataiye:`);
      } else if (text === '2') {
        await sendMetaTextMessage(from, `📸 *Upload Prescription*\nKripya prescription ki photo bhejiye.`);
      } else if (text === '3') {
        await sendMetaTextMessage(from, `👨‍💼 Aapko executive se connect kiya ja raha hai.`);
      }
    }
    else if (message.type === 'image' || message.type === 'document') {
      const mediaId = message.image?.id || message.document?.id;
      
      if (mediaId) {
        const mediaResponse = await axios.get(
          `https://graph.facebook.com/v18.0/${mediaId}`,
          {
            headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` }
          }
        );
        
        const imageUrl = mediaResponse.data.url;
        const extracted = await extractWithOpenAI(imageUrl);
        const executiveNumber = getExecutiveNumber('Main Branch');
        
        const execMessage = `
📸 *New Prescription Received*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${patientName}
🔬 Tests: ${extracted.tests}
👨‍⚕️ Doctor: ${extracted.doctorName}
📅 Time: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
📝 *OCR Preview:*
${extracted.rawText.substring(0, 300)}...
        `;
        
        await sendExecutiveNotification(executiveNumber, execMessage);
      }
    }
    
    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    res.sendStatus(200);
  }
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
// TATA TELE MISS CALL WEBHOOK
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
    
    await sendMetaTemplateMessage(whatsappNumber, branch.name);
    
    return res.json({ success: true, whatsappNumber, branch: branch.name });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// DIRECT MESSAGE TEST ENDPOINT
// ============================================
app.get('/direct-message', async (req, res) => {
  try {
    const { to, message } = req.query;
    
    if (!to || !message) {
      return res.status(400).json({ 
        error: 'Missing parameters. Use: /direct-message?to=919169959992&message=Hello' 
      });
    }
    
    console.log(`📤 Direct message to ${to}`);
    
    const response = await sendMetaTextMessage(to, message);
    
    res.json({ 
      success: true, 
      message: `✅ Message sent to ${to}`,
      response 
    });
    
  } catch (error) {
    console.error('❌ Direct message error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
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
    
    const message = `
📋 *New Manual Test Entry (TEST)*
━━━━━━━━━━━━━━━━━━
👤 Patient: ${patient}
🔬 Tests: ${test}
🏥 Branch: ${branch}
📅 Time: ${new Date().toLocaleString()}
    `;
    
    await sendExecutiveNotification(exec, message);
    
    res.json({ 
      success: true, 
      message: `Test manual entry sent to ${exec}`
    });
    
  } catch (error) {
    console.error('❌ Test error:', error);
    res.status(500).json({ error: error.message });
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
    patients: patientDB.size,
    uptime: process.uptime() 
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Tata-Meta Webhook Server</h1>
    <p>Meta Cloud API + OpenAI OCR Active</p>
    <ul>
      <li>✅ Webhook URL: /webhook</li>
      <li>✅ Verify Token: ${WEBHOOK_VERIFY_TOKEN}</li>
      <li>✅ POST /tata-misscall - Tata Tele webhook</li>
      <li>✅ GET /direct-message - Send test message</li>
      <li>✅ GET /health - Health check</li>
    </ul>
  `);
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Meta Cloud API: Active`);
  console.log(`📍 Webhook URL: https://tata-wati-webhook.onrender.com/webhook`);
  console.log(`📍 Verify Token: ${WEBHOOK_VERIFY_TOKEN}`);
  console.log(`📍 OpenAI OCR: Active with GPT-4o`);
  console.log('='.repeat(60));
});
