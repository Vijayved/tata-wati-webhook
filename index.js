require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const OpenAI = require('openai');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const { classifyWithStage, clearAICache, getCacheStats } = require('./classifier');

// ============================================
// ✅ FORCE PORT BINDING
// ============================================
const PORT = parseInt(process.env.PORT) || 10000;
process.env.PORT = PORT;

console.log(`🚀 Starting Miss Call System on PORT=${PORT}`);

// ============================================
// ✅ TIMEZONE SETUP - IST
// ============================================
process.env.TZ = 'Asia/Kolkata';

const app = express();

// Raw body for HMAC
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true, limit: '50mb', verify: (req, res, buf) => {
  req.rawBody = buf.toString();
} }));

// ============================================
// ✅ SIMPLE RATE LIMITING
// ============================================
const rateLimitMap = new Map();

function simpleRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 1000;
  const max = 20;
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }
  
  const timestamps = rateLimitMap.get(ip);
  const recent = timestamps.filter(t => t > now - windowMs);
  
  if (recent.length >= max) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  recent.push(now);
  rateLimitMap.set(ip, recent);
  next();
}

app.use('/wati-webhook', simpleRateLimit);
app.use('/tata-misscall-whatsapp', simpleRateLimit);

// ============================================
// ✅ HELPER FUNCTIONS
// ============================================
function getISTTime(date = new Date()) {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getISTDateTime(date = new Date()) {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function normalizeIndianNumber(number) {
  if (!number) return '';
  let digits = String(number).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  if (digits.length === 12) {
    if (digits.startsWith('91')) return digits.slice(0, 12);
    return '91' + digits.slice(-10);
  }
  if (digits.length > 12) {
    if (digits.startsWith('91')) return digits.slice(0, 12);
    return digits.slice(-12);
  }
  return '';
}

function normalizeWhatsAppNumber(number) {
  return normalizeIndianNumber(number) || '';
}

function getCallerNumberFromPayload(body) {
  return body.caller_id_number || body["customer_no_with_prefix "] || body.customer_number_with_prefix || body.cli || body.msisdn || body.mobile || body.caller_number || body.from || body.customer_number || '';
}

// ============================================
// CONFIGURATION
// ============================================
const WATI_TOKEN = process.env.WATI_TOKEN;
const WATI_BASE_URL = process.env.WATI_BASE_URL;
const MONGODB_URI = process.env.MONGODB_URI;
const TATA_SECRET = process.env.TATA_SECRET || 'tata_webhook_secret';
const TEMPLATE_NAME = process.env.MISSCALL_TEMPLATE_NAME || 'misscall_welcome_v3';
const LEAD_TEMPLATE_NAME = 'lead_notification_v6';

// ============================================
// ✅ EXECUTIVE NUMBERS & BRANCHES
// ============================================
const EXECUTIVES = {
  'Naroda Team': (process.env.NARODA_EXECUTIVE || '919106959092').toString().trim(),
  'Usmanpura Team': (process.env.USMANPURA_EXECUTIVE || '917490029085').toString().trim(),
  'Vadaj Team': (process.env.VADAJ_EXECUTIVE || '918488931212').toString().trim(),
  'Satellite Team': (process.env.SATELLITE_EXECUTIVE || '917490029085').toString().trim(),
  'Maninagar Team': (process.env.MANINAGAR_EXECUTIVE || '918488931212').toString().trim(),
  'Bapunagar Team': (process.env.BAPUNAGAR_EXECUTIVE || '919274682553').toString().trim(),
  'Juhapura Team': (process.env.JUHAPURA_EXECUTIVE || '919274682553').toString().trim(),
  'Gandhinagar Team': (process.env.GANDHINAGAR_EXECUTIVE || '919558591212').toString().trim(),
  'Rajkot Team': (process.env.RAJKOT_EXECUTIVE || '917880261858').toString().trim(),
  'Sabarmati Team': (process.env.SABARMATI_EXECUTIVE || '917880261858').toString().trim(),
  'Manager': (process.env.MANAGER_NUMBER || '917698011233').toString().trim()
};

function getExecutiveNumber(branchName) {
  const formattedBranch = branchName.charAt(0).toUpperCase() + branchName.slice(1).toLowerCase();
  const teamName = `${formattedBranch} Team`;
  return EXECUTIVES[teamName] || process.env.DEFAULT_EXECUTIVE || '917880261858';
}

const BRANCHES = {
  [normalizeIndianNumber(process.env.NARODA_NUMBER || '07969690935')]: { name: 'Naroda', executive: EXECUTIVES['Naroda Team'] },
  [normalizeIndianNumber('917969690922')]: { name: 'Naroda', executive: EXECUTIVES['Naroda Team'] },
  [normalizeIndianNumber(process.env.USMANPURA_NUMBER || '9898989897')]: { name: 'Usmanpura', executive: EXECUTIVES['Usmanpura Team'] },
  [normalizeIndianNumber('917969690952')]: { name: 'Usmanpura', executive: EXECUTIVES['Usmanpura Team'] },
  [normalizeIndianNumber(process.env.VADAJ_NUMBER || '9898989896')]: { name: 'Vadaj', executive: EXECUTIVES['Vadaj Team'] },
  [normalizeIndianNumber('917969690917')]: { name: 'Vadaj', executive: EXECUTIVES['Vadaj Team'] },
  [normalizeIndianNumber(process.env.SATELLITE_NUMBER || '9898989898')]: { name: 'Satellite', executive: EXECUTIVES['Satellite Team'] },
  [normalizeIndianNumber('917969690902')]: { name: 'Satellite', executive: EXECUTIVES['Satellite Team'] },
  [normalizeIndianNumber(process.env.MANINAGAR_NUMBER || '9898989895')]: { name: 'Maninagar', executive: EXECUTIVES['Maninagar Team'] },
  [normalizeIndianNumber('917969690904')]: { name: 'Maninagar', executive: EXECUTIVES['Maninagar Team'] },
  [normalizeIndianNumber(process.env.BAPUNAGAR_NUMBER || '9898989894')]: { name: 'Bapunagar', executive: EXECUTIVES['Bapunagar Team'] },
  [normalizeIndianNumber('917969690906')]: { name: 'Bapunagar', executive: EXECUTIVES['Bapunagar Team'] },
  [normalizeIndianNumber(process.env.JUHAPURA_NUMBER || '9898989893')]: { name: 'Juhapura', executive: EXECUTIVES['Juhapura Team'] },
  [normalizeIndianNumber('917969690909')]: { name: 'Juhapura', executive: EXECUTIVES['Juhapura Team'] },
  [normalizeIndianNumber(process.env.GANDHINAGAR_NUMBER || '9898989892')]: { name: 'Gandhinagar', executive: EXECUTIVES['Gandhinagar Team'] },
  [normalizeIndianNumber('917969690910')]: { name: 'Gandhinagar', executive: EXECUTIVES['Gandhinagar Team'] },
  [normalizeIndianNumber('917969690913')]: { name: 'Rajkot', executive: EXECUTIVES['Rajkot Team'] },
  [normalizeIndianNumber('917969690919')]: { name: 'Rajkot', executive: EXECUTIVES['Rajkot Team'] },
  [normalizeIndianNumber('917969690942')]: { name: 'Sabarmati', executive: EXECUTIVES['Sabarmati Team'] },
  [normalizeIndianNumber('917969690905')]: { name: 'Sabarmati', executive: EXECUTIVES['Sabarmati Team'] }
};

function getBranchByCalledNumber(calledNumber) {
  const normalized = normalizeIndianNumber(calledNumber);
  return BRANCHES[normalized] || { name: 'Main Branch', executive: process.env.DEFAULT_EXECUTIVE || '917880261858' };
}

const STAGES = {
  AWAITING_BRANCH: 'awaiting_branch',
  AWAITING_NAME: 'awaiting_name',
  AWAITING_TEST_TYPE: 'awaiting_test_type',
  AWAITING_TEST_DETAILS: 'awaiting_test_details',
  EXECUTIVE_NOTIFIED: 'executive_notified',
  CONNECTED: 'connected',
  CONVERTED: 'converted',
  WAITING: 'waiting',
  NOT_CONVERTED: 'not_converted',
  ESCALATED: 'escalated'
};

// ============================================
// ✅ RETRY LOGIC & DATABASE CONNECTION
// ============================================
async function sendWithRetry(fn, retries = 2, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      console.log(`⚠️ Retry attempt left: ${retries}, error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendWithRetry(fn, retries - 1, delay);
    }
    throw error;
  }
}

let db, processedCollection, patientsCollection, missCallsCollection, chatSessionsCollection, chatMessagesCollection, followupCollection;

async function connectDB() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    if (!MONGODB_URI) throw new Error('MONGODB_URI not defined');
    const client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000
    });
    await client.connect();
    console.log('✅ MongoDB connected');
    
    db = client.db('executive_system');
    processedCollection = db.collection('processed_messages');
    patientsCollection = db.collection('patients');
    missCallsCollection = db.collection('miss_calls');
    chatSessionsCollection = db.collection('chat_sessions');
    chatMessagesCollection = db.collection('chat_messages');
    followupCollection = db.collection('followups');
    
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await patientsCollection.createIndex({ patientPhone: 1, source: 1 }, { unique: true });
    await patientsCollection.createIndex({ patientPhone: 1, status: 1 });
    await patientsCollection.createIndex({ createdAt: -1 });
    await chatSessionsCollection.createIndex({ sessionToken: 1 }, { unique: true });
    await chatSessionsCollection.createIndex({ patientPhone: 1, status: 1 });
    await chatMessagesCollection.createIndex({ sessionToken: 1, timestamp: 1 });
    await followupCollection.createIndex({ patientId: 1, type: 1 });
    
    console.log('✅ Indexes created');
    return true;
  } catch (error) {
    console.error('❌ DB error:', error.message);
    throw error;
  }
}

async function isMessageProcessed(messageId) {
  if (!processedCollection) return false;
  return !!(await processedCollection.findOne({ messageId }));
}

async function markMessageProcessed(messageId) {
  if (!processedCollection) return;
  await processedCollection.updateOne(
    { messageId },
    { $set: { messageId, processedAt: new Date() } },
    { upsert: true }
  );
}

async function getOrCreateChatSession(patient) {
  try {
    const sessionToken = crypto.randomBytes(16).toString('hex');
    const result = await chatSessionsCollection.findOneAndUpdate(
      { patientPhone: patient.patientPhone, status: 'active' },
      {
        $setOnInsert: {
          sessionToken,
          executiveNumber: getExecutiveNumber(patient.branch),
          patientPhone: patient.patientPhone,
          patientName: patient.patientName || 'Patient',
          createdAt: new Date(),
          lastActivity: new Date(),
          status: 'active'
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
    return result.value || { sessionToken };
  } catch (error) {
    console.error('Session error:', error.message);
    return { sessionToken: crypto.randomBytes(16).toString('hex') };
  }
}

// ============================================
// ✅ WATI TEMPLATE SENDER
// ============================================
async function sendWatiTemplateMessage(whatsappNumber, templateName, parameters) {
  console.log(`📤 Sending ${templateName} to ${whatsappNumber}`);
  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
  const payload = {
    template_name: templateName,
    broadcast_name: `msg_${Date.now()}`,
    parameters: parameters || []
  };
  
  return await sendWithRetry(async () => {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `${WATI_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    console.log(`✅ Template sent successfully`);
    return response.data;
  });
}

async function sendLeadNotification(executiveNumber, patientName, patientPhone, branch, testDetails, testType, chatToken) {
  const istTime = getISTDateTime();
  
  const safePatientName = patientName || 'Patient';
  const safeBranch = branch || 'Main Branch';
  const safeTestType = testType || 'Not Specified';
  const safeTestDetails = testDetails || 'Not Specified';

  const welcomeText = `Hi ${safePatientName}, I am from UIC Support Team.\n\nYour Details:\nName: ${safePatientName}\nTest: ${safeTestType} - ${safeTestDetails}\nBranch: ${safeBranch}\nTime: ${istTime}\n\nHow can I help you?`;
  const whatsappLink = `https://wa.me/${patientPhone}?text=${encodeURIComponent(welcomeText)}`;
  
  const parameters = [
    { name: "1", value: safePatientName },
    { name: "2", value: patientPhone },
    { name: "3", value: safeBranch },
    { name: "4", value: safeTestDetails },
    { name: "5", value: safeTestType },
    { name: "6", value: istTime },
    { name: "7", value: whatsappLink }
  ];
  return await sendWatiTemplateMessage(executiveNumber, LEAD_TEMPLATE_NAME, parameters);
}

// ============================================
// ✅ TATA TELE WEBHOOK
// ============================================
app.post('/tata-misscall-whatsapp', async (req, res) => {
  try {
    console.log('\n📞 ========== TATA TELE WEBHOOK ==========');
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.TATA_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    if (!callerNumberRaw) {
      return res.status(400).json({ error: 'No caller number' });
    }
    
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    const calledNumber = req.body.call_to_number || '';
    const branch = getBranchByCalledNumber(calledNumber);
    
    console.log(`📱 Caller: ${whatsappNumber}, Branch: ${branch.name}`);
    
    await missCallsCollection.insertOne({
      phoneNumber: whatsappNumber,
      calledNumber,
      branch: branch.name,
      createdAt: new Date(),
      istTime: getISTTime()
    });
    
    const existingPatient = await patientsCollection.findOne({
      patientPhone: whatsappNumber,
      source: 'misscall'
    });
    
    const now = new Date();
    let shouldSendWelcome = true;

    if (existingPatient) {
      const lastCallTime = existingPatient.missCallTime ? new Date(existingPatient.missCallTime) : new Date(0);
      const hoursSinceLastCall = (now - lastCallTime) / (1000 * 60 * 60);
      
      if (hoursSinceLastCall < 2) {
        shouldSendWelcome = false;
        console.log(`⏳ Cooldown Active: ${whatsappNumber} called recently. Suppressing duplicate welcome.`);
      }

      await patientsCollection.updateOne(
        { _id: existingPatient._id },
        {
          $set: {
            missCallTime: now,
            missCallTimeIST: getISTTime(),
            branch: branch.name,
            status: 'pending',
            currentStage: STAGES.AWAITING_NAME,
            updatedAt: now
          },
          $inc: { missCallCount: 1 }
        }
      );
    } else {
      await patientsCollection.insertOne({
        patientName: '',
        patientPhone: whatsappNumber,
        branch: branch.name,
        testType: '',
        testDetails: '',
        sourceType: 'Miss Call',
        executiveNumber: branch.executive,
        status: 'pending',
        missCallCount: 1,
        missCallTime: now,
        missCallTimeIST: getISTTime(),
        createdAt: now,
        updatedAt: now,
        currentStage: STAGES.AWAITING_NAME,
        source: 'misscall',
        welcomeSent: false
      });
      console.log(`✅ New patient created for ${whatsappNumber} - Stage: ${STAGES.AWAITING_NAME}`);
    }
    
    if (shouldSendWelcome) {
      await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [{ name: '1', value: branch.name }]);
      console.log(`✅ Welcome template sent to ${whatsappNumber}`);
    }
    
    res.json({ success: true, whatsappNumber, branch: branch.name });
  } catch (error) {
    console.error('❌ Tata Tele error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ WATI WEBHOOK (With Hybrid AI Classifier)
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('\n📨 ========== WATI WEBHOOK ==========');
    
    const msg = req.body;
    const msgId = msg.id || msg.messageId;
    
    if (!msgId || await isMessageProcessed(msgId)) {
      return res.sendStatus(200);
    }
    
    const senderNumber = msg.whatsappNumber || msg.from || msg.waId;
    if (!senderNumber) {
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }

    if (msg.eventType && msg.eventType !== 'message') {
      console.log(`⏭️ Ignoring event type: ${msg.eventType}`);
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
    let messageText = (msg.text || msg.body || (msg.listReply && msg.listReply.title) || (msg.buttonReply && msg.buttonReply.title) || '').trim();
    
    if (!messageText) {
      console.log(`⚠️ Ignored blank or non-text message from ${senderNumber}`);
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
    console.log(`📝 Message: "${messageText}" from ${senderNumber}`);
    
    let patient = await patientsCollection.findOne({
      patientPhone: senderNumber,
      source: 'misscall'
    });
    
    if (!patient) {
      console.log(`⚠️ No patient found for ${senderNumber}, creating new patient...`);
      // Create new patient if not exists
      const result = await patientsCollection.insertOne({
        patientName: '',
        patientPhone: senderNumber,
        branch: 'Main Branch',
        testType: '',
        testDetails: '',
        source: 'misscall',
        currentStage: STAGES.AWAITING_NAME,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      });
      patient = await patientsCollection.findOne({ _id: result.insertedId });
    }
    
    console.log(`📋 Current State - Stage: ${patient.currentStage}, Name: "${patient.patientName || ''}", Test: "${patient.testType || ''}", Details: "${patient.testDetails || ''}"`);
    
    // Store message
    await patientsCollection.updateOne(
      { _id: patient._id },
      {
        $push: {
          patientMessages: {
            $each: [{ text: messageText, timestamp: new Date() }],
            $slice: -20
          }
        },
        $set: { lastMessageAt: new Date() }
      }
    );
    
    await chatMessagesCollection.insertOne({
      patientId: patient._id,
      patientPhone: patient.patientPhone,
      sender: 'patient',
      text: messageText,
      timestamp: new Date(),
      source: patient.source
    });
    
    // 🔥 HYBRID AI CLASSIFICATION
    const result = await classifyWithStage(messageText, patient.currentStage);
    
    console.log(`🔍 Classification: ${result.category} (${result.method}, confidence: ${result.confidence})`);
    
    let updateFields = {};
    let stageChanged = false;
    let shouldNotifyExecutive = false;
    
    if (result.confidence >= 0.65 && result.category !== 'IGNORE' && result.category !== 'UNKNOWN') {
      switch (result.category) {
        case 'PATIENT_NAME':
          updateFields.patientName = result.value;
          updateFields.currentStage = STAGES.AWAITING_TEST_TYPE;
          stageChanged = true;
          console.log(`✅ Name saved: "${result.value}" → Stage: ${STAGES.AWAITING_TEST_TYPE}`);
          break;
          
        case 'TEST_TYPE':
          updateFields.testType = result.value;
          updateFields.currentStage = STAGES.AWAITING_TEST_DETAILS;
          stageChanged = true;
          console.log(`✅ Test type saved: "${result.value}" → Stage: ${STAGES.AWAITING_TEST_DETAILS}`);
          break;
          
        case 'TEST_DETAILS':
          updateFields.testDetails = result.value;
          updateFields.currentStage = STAGES.EXECUTIVE_NOTIFIED;
          stageChanged = true;
          shouldNotifyExecutive = true;
          if (result.extractedTest && (!patient.testType || patient.testType === '')) {
            updateFields.testType = result.extractedTest;
            console.log(`✅ Auto-filled test type: ${result.extractedTest}`);
          }
          console.log(`✅ Test details saved: "${result.value}" → Stage: ${STAGES.EXECUTIVE_NOTIFIED}`);
          break;
          
        case 'GREETING':
          console.log(`👋 Greeting detected, no action needed`);
          break;
      }
      
      if (stageChanged) {
        await patientsCollection.updateOne({ _id: patient._id }, { $set: updateFields });
        patient = await patientsCollection.findOne({ _id: patient._id });
        console.log(`🔄 Patient updated - Name: "${patient.patientName}", Test: "${patient.testType}", Details: "${patient.testDetails}", Stage: ${patient.currentStage}`);
      }
    } else {
      console.log(`⏭️ Message ignored (confidence: ${result.confidence}, category: ${result.category})`);
    }
    
    // Send notification to executive when we have complete data
    if (shouldNotifyExecutive || (patient.currentStage === STAGES.EXECUTIVE_NOTIFIED && patient.testDetails && patient.testDetails !== '')) {
      const finalName = patient.patientName || 'Patient';
      const finalTestType = patient.testType || 'Not Specified';
      const finalTestDetails = patient.testDetails || 'Not Specified';
      
      const session = await getOrCreateChatSession(patient);
      const executiveNumber = getExecutiveNumber(patient.branch);
      
      console.log(`📤 Sending lead notification to executive: ${executiveNumber}`);
      console.log(`   Data: Name=${finalName}, Test=${finalTestType}, Details=${finalTestDetails}, Branch=${patient.branch}`);
      
      await sendLeadNotification(
        executiveNumber,
        finalName,
        senderNumber,
        patient.branch || 'Main Branch',
        finalTestDetails,
        finalTestType,
        session.sessionToken
      );
      console.log(`✅ Executive notification sent successfully`);
    }
    
    await markMessageProcessed(msgId);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.sendStatus(200);
  }
});

// ============================================
// ✅ EXECUTIVE CHAT INTERFACE
// ============================================
app.get('/executive-chat/:token', async (req, res) => {
  const { token } = req.params;
  const session = await chatSessionsCollection.findOne({ sessionToken: token, status: 'active' });
  if (!session) {
    return res.send('<h2>❌ Invalid Session</h2>');
  }
  
  const messages = await chatMessagesCollection.find({ sessionToken: token }).sort({ timestamp: 1 }).toArray();
  
  function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Chat - ${escapeHtml(session.patientName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #f0f2f5; height: 100vh; }
        .chat { max-width: 800px; margin: 0 auto; height: 100vh; display: flex; flex-direction: column; background: #fff; }
        .header { background: #075e54; color: #fff; padding: 15px; }
        .header strong { font-size: 1.1em; }
        .header small { font-size: 0.8em; opacity: 0.8; }
        .messages { flex: 1; overflow-y: auto; padding: 20px; background: #e5ddd5; }
        .message { margin: 10px 0; display: flex; }
        .message.patient { justify-content: flex-start; }
        .message.executive { justify-content: flex-end; }
        .bubble { max-width: 70%; padding: 10px 15px; border-radius: 18px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
        .message.executive .bubble { background: #dcf8c6; }
        .time { font-size: 0.7em; color: #999; margin-top: 5px; }
        .input-area { display: flex; padding: 15px; background: #f0f0f0; gap: 10px; border-top: 1px solid #ddd; }
        input { flex: 1; padding: 12px; border: none; border-radius: 25px; outline: none; font-size: 1em; }
        button { background: #075e54; color: #fff; border: none; padding: 10px 20px; border-radius: 25px; cursor: pointer; font-size: 1em; }
        button:hover { background: #054c44; }
      </style>
    </head>
    <body>
    <div class="chat">
      <div class="header">
        <strong>${escapeHtml(session.patientName)}</strong><br>
        <small>📞 ${escapeHtml(session.patientPhone)}</small>
      </div>
      <div class="messages" id="messages">
        ${messages.map(m => `
          <div class="message ${m.sender}">
            <div class="bubble">
              ${escapeHtml(m.text)}
              <div class="time">${new Date(m.timestamp).toLocaleTimeString()}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="input-area">
        <input type="text" id="msgInput" placeholder="Type message..." onkeypress="if(event.key==='Enter') send()">
        <button onclick="send()">Send</button>
      </div>
    </div>
    <script>
      const token = '${token}';
      let lastCount = ${messages.length};
      
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
      
      async function send() {
        const text = document.getElementById('msgInput').value.trim();
        if (!text) return;
        
        const response = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionToken: token, text })
        });
        
        if (response.ok) {
          const div = document.createElement('div');
          div.className = 'message executive';
          div.innerHTML = '<div class="bubble">' + escapeHtml(text) + '<div class="time">Just now</div></div>';
          document.getElementById('messages').appendChild(div);
          document.getElementById('msgInput').value = '';
          document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
          lastCount++;
        }
      }
      
      setInterval(async () => {
        const response = await fetch('/api/messages/' + token + '?since=' + lastCount);
        const data = await response.json();
        
        data.messages.forEach(msg => {
          const div = document.createElement('div');
          div.className = 'message ' + msg.sender;
          div.innerHTML = '<div class="bubble">' + escapeHtml(msg.text) + '<div class="time">' + new Date(msg.timestamp).toLocaleTimeString() + '</div></div>';
          document.getElementById('messages').appendChild(div);
        });
        
        lastCount += data.messages.length;
        document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
      }, 2000);
    </script>
    </body>
    </html>
  `);
});

app.post('/api/send', async (req, res) => {
  try {
    const { sessionToken, text } = req.body;
    const session = await chatSessionsCollection.findOne({ sessionToken, status: 'active' });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    await sendWithRetry(async () => {
      const url = `${WATI_BASE_URL}/api/v1/sendSessionMessage/${session.patientPhone}`;
      await axios.post(url, { messageText: text }, {
        headers: { 'Authorization': WATI_TOKEN, 'Content-Type': 'application/json' }
      });
    });
    
    await chatMessagesCollection.insertOne({
      sessionToken,
      sender: 'executive',
      text,
      timestamp: new Date()
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Send error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/messages/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const since = parseInt(req.query.since) || 0;
    const messages = await chatMessagesCollection.find({ sessionToken: token }).sort({ timestamp: 1 }).toArray();
    res.json({ messages: messages.slice(since), total: messages.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ ADMIN ENDPOINTS (Cache Management)
// ============================================
app.post('/admin/clear-cache', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== '2311') {
      return res.status(403).json({ error: 'Invalid password' });
    }
    const result = clearAICache();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/cache-stats', async (req, res) => {
  try {
    const stats = getCacheStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ OTHER ENDPOINTS
// ============================================
app.get('/health', (req, res) => {
  res.json({
    success: true,
    uptime: process.uptime(),
    mongodb: db ? 'connected' : 'disconnected',
    time: getISTTime(),
    system: 'Miss Call System with Hybrid AI',
    classifier: 'rules + openai'
  });
});

app.get('/', (req, res) => {
  res.json({
    message: '🚀 Miss Call System with Hybrid AI Classifier',
    version: '4.0.0',
    port: PORT,
    time: getISTTime(),
    features: {
      classification: 'Rules + OpenAI (80/20 hybrid)',
      anti_spam: '2-hour cooldown',
      rate_limit: '20 req/sec',
      cache: 'AI results cached (24h TTL)'
    },
    endpoints: {
      tata_misscall: '/tata-misscall-whatsapp',
      wati_webhook: '/wati-webhook',
      executive_chat: '/executive-chat/:token',
      health: '/health',
      admin: '/admin',
      cache_stats: '/admin/cache-stats',
      clear_cache: '/admin/clear-cache (POST with password)'
    }
  });
});

// ============================================
// ✅ DASHBOARD ROUTER
// ============================================
let dashboardRouter;
try {
  dashboardRouter = require('./dashboard');
  app.use('/admin', (req, res, next) => {
    req.patientsCollection = patientsCollection;
    req.processedCollection = processedCollection;
    req.missCallsCollection = missCallsCollection;
    req.chatSessionsCollection = chatSessionsCollection;
    req.chatMessagesCollection = chatMessagesCollection;
    req.followupCollection = followupCollection;
    req.STAGES = STAGES;
    next();
  }, dashboardRouter);
  console.log('✅ Dashboard router loaded');
} catch (err) {
  console.log('⚠️ Dashboard router not found, admin endpoint disabled');
  app.get('/admin', (req, res) => {
    res.json({ 
      message: 'Admin dashboard not configured', 
      status: 'available endpoints: /admin/cache-stats, /admin/clear-cache'
    });
  });
}

// ============================================
// ✅ START SERVER
// ============================================
async function startServer() {
  console.log('🔄 Initializing Miss Call System with Hybrid AI...');
  console.log(`📍 Configured PORT: ${PORT}`);
  console.log(`📍 Node version: ${process.version}`);
  
  try {
    await connectDB();
    console.log('✅ Database connected');
    
    const HOST = '0.0.0.0';
    console.log(`🔌 Binding to ${HOST}:${PORT}...`);
    
    const server = app.listen(PORT, HOST, () => {
      console.log('\n' + '='.repeat(60));
      console.log(`✅ MISS CALL SYSTEM RUNNING ON PORT ${PORT}`);
      console.log(`📍 Host: ${HOST}`);
      console.log(`📍 Time: ${getISTTime()}`);
      console.log(`📍 WATI Webhook: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/wati-webhook`);
      console.log(`📍 Miss Call Webhook: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/tata-misscall-whatsapp`);
      console.log(`📍 Executive Chat: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/executive-chat/:token`);
      console.log(`📍 Health Check: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/health`);
      console.log('='.repeat(60));
      console.log('🧠 HYBRID AI CLASSIFIER ENABLED:');
      console.log('   ✅ Fast Rules (0-5ms) - 80% of messages');
      console.log('   ✅ OpenAI Fallback (500-1500ms) - 20% of messages');
      console.log('   ✅ AI Cache (24h TTL) - Prevents duplicate calls');
      console.log('   ✅ Stage-aware Classification');
      console.log('   ✅ Hinglish Language Support');
      console.log('='.repeat(60));
      console.log('🛡️ OTHER FEATURES:');
      console.log('   ✅ Anti-Spam Cooldown (2 hours)');
      console.log('   ✅ Duplicate Webhook Blocker');
      console.log('   ✅ Blank Message Handler');
      console.log('   ✅ Rate Limiting (20 req/sec)');
      console.log('='.repeat(60) + '\n');
    });
    
    server.on('error', (err) => {
      console.error('❌ Server error:', err);
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use!`);
      }
      process.exit(1);
    });
    
    process.on('uncaughtException', (err) => {
      console.error('❌ Uncaught Exception:', err);
    });
    
    process.on('unhandledRejection', (reason) => {
      console.error('❌ Unhandled Rejection:', reason);
    });
    
    process.on('SIGTERM', () => {
      console.log('🛑 SIGTERM received, closing...');
      server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    });
    
  } catch (error) {
    console.error('❌ Startup failed:', error.message);
    process.exit(1);
  }
}

startServer();
