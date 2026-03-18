require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const OpenAI = require('openai');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');

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
const MONGODB_URI = process.env.MONGODB_URI;
const TATA_SECRET = process.env.TATA_SECRET || 'tata_webhook_secret';
const HMAC_SECRET = process.env.HMAC_SECRET || 'your_hmac_secret_key';
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91';
const DEDUPE_WINDOW_MS = (parseInt(process.env.DEDUPE_WINDOW_SECONDS || '600', 10)) * 1000;
const TEMPLATE_NAME = process.env.MISSCALL_TEMPLATE_NAME || 'misscall_welcome_v3';
const LEAD_TEMPLATE_NAME = process.env.LEAD_TEMPLATE_NAME || 'lead_notification_v2';

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
// ✅ DATABASE CONNECTION
// ============================================
let db;
let processedCollection;
let patientsCollection;
let executivesCollection;
let missCallsCollection;

async function connectDB() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    
    if (!MONGODB_URI) throw new Error('MONGODB_URI is not defined');
    
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ MongoDB connected successfully');
    
    db = client.db('executive_system');
    processedCollection = db.collection('processed_messages');
    patientsCollection = db.collection('patients');
    executivesCollection = db.collection('executives');
    missCallsCollection = db.collection('miss_calls');
    
    // Indexes
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await patientsCollection.createIndex({ chatId: 1 }, { unique: true, sparse: true });
    await patientsCollection.createIndex({ patientPhone: 1, status: 1 });
    await patientsCollection.createIndex({ patientPhone: 1, createdAt: -1 });
    
    console.log('✅ Indexes created');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    throw error;
  }
}

// ============================================
// EXECUTIVE NUMBERS MAPPING
// ============================================
const EXECUTIVES = {
  'Naroda Team': process.env.NARODA_EXECUTIVE || '917880261858',
  'Usmanpura Team': process.env.USMANPURA_EXECUTIVE || '919825086011',
  'Vadaj Team': process.env.VADAJ_EXECUTIVE || '919825086011',
  'Satellite Team': process.env.SATELLITE_EXECUTIVE || '919825086011',
  'Manager': process.env.MANAGER_NUMBER || '919825086011'
};

// ============================================
// BRANCH CONFIGURATION
// ============================================
const BRANCHES = {
  [normalizeIndianNumber(process.env.NARODA_NUMBER || '07969690935')]: {
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
  [normalizeIndianNumber(process.env.SATELLITE_NUMBER || '9898989898')]: {
    name: 'Satellite',
    executive: EXECUTIVES['Satellite Team']
  },
  [normalizeIndianNumber('917969690935')]: {
    name: 'Test Branch',
    executive: '917880261858'
  }
};

// ============================================
// ✅ STAGE TRACKING CONSTANTS
// ============================================
const STAGES = {
  MISS_CALL_RECEIVED: 'miss_call_received',
  AWAITING_BRANCH: 'awaiting_branch',
  BRANCH_SELECTED: 'branch_selected',
  EXECUTIVE_NOTIFIED: 'executive_notified',
  CONVERTED: 'converted',
  WAITING: 'waiting',
  NOT_CONVERTED: 'not_converted',
  ESCALATED: 'escalated'
};

// ============================================
// ✅ IN-MEMORY STORAGE
// ============================================
const recentMissCalls = new Map();

// ============================================
// ✅ TOKEN GENERATION
// ============================================
function generateToken(chatId) {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(chatId)
    .digest('hex');
}

function verifyToken(chatId, token) {
  const expectedToken = generateToken(chatId);
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
  } catch {
    return false;
  }
}

// ============================================
// ✅ HELPER FUNCTIONS
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
  return normalized || '';
}

function getExecutiveNumber(branchName) {
  const teamName = `${branchName} Team`;
  return EXECUTIVES[teamName] || process.env.DEFAULT_EXECUTIVE || '917880261858';
}

function getCallerNumberFromPayload(body) {
  return body.caller_id_number || 
         body["customer_no_with_prefix "] || 
         body.customer_number_with_prefix ||
         body.cli || 
         body.msisdn || 
         body.mobile || 
         body.caller_number || 
         body.from || 
         body.customer_number ||
         '';
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

// ============================================
// ✅ DATABASE FUNCTIONS
// ============================================
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

async function updatePatientStage(patientId, stage) {
  try {
    await patientsCollection.updateOne(
      { _id: patientId },
      { 
        $set: { currentStage: stage, lastStageUpdate: new Date() },
        $push: { stageHistory: { [stage]: new Date() } }
      }
    );
    console.log(`📍 Stage updated: ${stage}`);
    return true;
  } catch (error) {
    console.error(`❌ Stage update failed:`, error.message);
    return false;
  }
}

// ============================================
// ✅ WATI TEMPLATE SENDER
// ============================================
async function sendWatiTemplateMessage(whatsappNumber, templateName, parameters) {
  console.log(`\n📤 SENDING TEMPLATE: ${templateName} to ${whatsappNumber}`);
  console.log(`📦 Parameters:`, JSON.stringify(parameters));
  
  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
  
  const payload = {
    template_name: templateName,
    broadcast_name: `msg_${Date.now()}`,
    parameters: parameters || []
  };
  
  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `${WATI_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    
    console.log(`✅ Template sent successfully`);
    return response.data;
  } catch (error) {
    console.error(`❌ Template send FAILED:`, {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
}

// ============================================
// ✅ LEAD NOTIFICATION
// ============================================
async function sendLeadNotification(executiveNumber, patientName, patientPhone, branch, testNames, sourceType, chatId) {
  console.log(`\n📤 Preparing lead notification for executive ${executiveNumber}`);
  
  const parameters = [
    { name: "1", value: patientName || "Miss Call Patient" },
    { name: "2", value: patientPhone },
    { name: "3", value: branch },
    { name: "4", value: testNames || "Miss Call" },
    { name: "5", value: sourceType || "Miss Call" },
    { name: "6", value: `${SELF_URL}/connect-chat/${chatId}?token=${generateToken(chatId)}` }
  ];
  
  return await sendWatiTemplateMessage(executiveNumber, LEAD_TEMPLATE_NAME, parameters);
}

// ============================================
// ✅ ATOMIC NOTIFICATION SENDER
// ============================================
async function sendNotificationAtomic(patientId, notificationFunction) {
  const session = patientsCollection.client.startSession();
  
  try {
    session.startTransaction();
    
    const patient = await patientsCollection.findOne({
      _id: patientId,
      $or: [
        { notificationSent: { $ne: true } },
        { notificationSent: { $exists: false } }
      ]
    }, { session });
    
    if (!patient) {
      console.log(`⏭️ Notification already sent, skipping`);
      await session.abortTransaction();
      return false;
    }
    
    await notificationFunction();
    
    await patientsCollection.updateOne(
      { _id: patientId },
      { $set: { notificationSent: true, lastNotificationSentAt: new Date() } },
      { session }
    );
    
    await session.commitTransaction();
    console.log(`✅ Atomic notification sent`);
    return true;
  } catch (error) {
    await session.abortTransaction();
    console.error(`❌ Atomic notification failed:`, error.message);
    throw error;
  } finally {
    session.endSession();
  }
}

// ============================================
// ✅ FIXED TATA TELE WEBHOOK - WITH DUPLICATE HANDLING
// ============================================
app.post('/tata-misscall-whatsapp', async (req, res) => {
  try {
    console.log('\n📞 TATA TELE WEBHOOK RECEIVED');
    
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.TATA_SECRET) {
      console.log('❌ Unauthorized');
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    if (!callerNumberRaw) return res.status(400).json({ error: 'Caller number not found' });
    
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    const calledNumber = req.body.call_to_number || '';
    const branch = getBranchByCalledNumber(calledNumber);
    
    console.log(`📱 Caller: ${whatsappNumber}, Branch: ${branch.name}`);
    
    if (shouldSkipDuplicateMissCall(whatsappNumber, calledNumber)) {
      console.log('⏭️ Skipping duplicate miss call');
      return res.json({ skipped: true });
    }
    
    const chatId = `${whatsappNumber}_${branch.name}`;
    
    // Check if patient already exists
    const existingPatient = await patientsCollection.findOne({ 
      patientPhone: whatsappNumber,
      status: 'awaiting_branch'
    });
    
    if (existingPatient) {
      console.log('ℹ️ Patient already exists, updating...');
      await patientsCollection.updateOne(
        { _id: existingPatient._id },
        { 
          $set: { 
            missCallTime: new Date(),
            updatedAt: new Date()
          }
        }
      );
    } else {
      // Create new patient
      const result = await patientsCollection.insertOne({
        chatId,
        patientName: 'Miss Call Patient',
        patientPhone: whatsappNumber,
        branch: branch.name,
        testNames: 'Awaiting details',
        sourceType: 'Miss Call',
        executiveNumber: branch.executive,
        priority: 'low',
        status: 'awaiting_branch',
        notificationSent: false,
        missCallTime: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        currentStage: STAGES.AWAITING_BRANCH,
        stageHistory: { [STAGES.AWAITING_BRANCH]: new Date() }
      });
      console.log(`✅ New patient created`);
    }
    
    // Send welcome template
    try {
      await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [
        { name: '1', value: branch.name }
      ]);
    } catch (templateError) {
      console.error('❌ Failed to send welcome template:', templateError.message);
    }
    
    res.json({ success: true, whatsappNumber, branch: branch.name });
    
  } catch (error) {
    console.error('❌ Tata Tele error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ FIXED WATI WEBHOOK - WITH BRANCH DETECTION
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    // TEMPORARILY DISABLE AUTH FOR TESTING
    // if (req.headers['authorization'] !== `Bearer ${WATI_TOKEN}`) {
    //   console.log('⚠️ Unauthorized webhook attempt');
    //   return res.sendStatus(403);
    // }
    
    console.log('\n📨 WATI WEBHOOK RECEIVED');
    
    const msg = req.body;
    const msgId = msg.id || msg.messageId;
    if (!msgId) return res.sendStatus(200);
    
    if (await isMessageProcessed(msgId)) {
      console.log(`⏭️ Message already processed`);
      return res.sendStatus(200);
    }
    
    const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
    if (!patientPhone) {
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
    const text = (msg.text || msg.body || '').toUpperCase().trim();
    console.log(`📝 Message: "${text}" from ${patientPhone}`);
    
    // DETECT DONE_ MESSAGES
    if (text.startsWith('DONE_')) {
      const branch = text.replace('DONE_', '');
      console.log(`🎯 BRANCH DETECTED: ${branch}`);
      
      const whatsappNumber = normalizeWhatsAppNumber(patientPhone);
      const executiveNumber = getExecutiveNumber(branch);
      
      console.log(`👤 Executive for ${branch}: ${executiveNumber}`);
      
      // Find patient - first try awaiting_branch, then any
      let patient = await patientsCollection.findOne({ 
        patientPhone: whatsappNumber,
        status: 'awaiting_branch'
      });
      
      if (!patient) {
        patient = await patientsCollection.findOne({ patientPhone: whatsappNumber });
      }
      
      const chatId = `${whatsappNumber}_${branch}`;
      
      if (!patient) {
        // Create new patient
        console.log(`🆕 Creating new patient`);
        const result = await patientsCollection.insertOne({
          chatId,
          patientName: 'Miss Call Patient',
          patientPhone: whatsappNumber,
          branch: branch,
          testNames: 'Chatbot Flow',
          sourceType: 'Miss Call',
          executiveNumber: executiveNumber,
          priority: 'low',
          status: 'pending',
          notificationSent: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          currentStage: STAGES.BRANCH_SELECTED,
          stageHistory: { [STAGES.BRANCH_SELECTED]: new Date() }
        });
        patient = { _id: result.insertedId };
      } else {
        // Update existing patient
        console.log(`📝 Updating patient ${patient._id}`);
        await patientsCollection.updateOne(
          { _id: patient._id },
          {
            $set: {
              branch: branch,
              status: 'pending',
              executiveNumber: executiveNumber,
              currentStage: STAGES.BRANCH_SELECTED,
              updatedAt: new Date()
            },
            $push: { stageHistory: { [STAGES.BRANCH_SELECTED]: new Date() } }
          }
        );
      }
      
      // SEND EXECUTIVE NOTIFICATION
      try {
        console.log(`📤 Sending notification to executive ${executiveNumber}`);
        const notified = await sendNotificationAtomic(patient._id, () =>
          sendLeadNotification(
            executiveNumber,
            'Miss Call Patient',
            whatsappNumber,
            branch,
            'Chatbot Flow',
            '📞 Miss Call',
            chatId
          )
        );
        
        if (notified) {
          console.log(`✅✅ EXECUTIVE NOTIFICATION SENT`);
          await updatePatientStage(patient._id, STAGES.EXECUTIVE_NOTIFIED);
        }
      } catch (notifError) {
        console.error(`❌ Notification failed:`, notifError.message);
      }
    }
    
    await markMessageProcessed(msgId);
    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.sendStatus(200);
  }
});

// ============================================
// ✅ TEST ENDPOINT
// ============================================
app.get('/test-executive-direct', async (req, res) => {
  try {
    const execNumber = req.query.exec || '919106959092';
    const patientPhone = req.query.patient || '9876543210';
    const branch = req.query.branch || 'Naroda';
    
    console.log(`\n🧪 Testing executive notification to ${execNumber}`);
    
    const chatId = `test_${Date.now()}`;
    const result = await sendLeadNotification(
      execNumber,
      'Test Patient',
      patientPhone,
      branch,
      'Test MRI, Blood Test',
      'Test',
      chatId
    );
    
    res.json({ 
      success: true, 
      message: `Template sent to ${execNumber}`,
      result 
    });
  } catch (error) {
    console.error('❌ Test failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      response: error.response?.data 
    });
  }
});

// ============================================
// ✅ DEBUG ENDPOINTS
// ============================================
app.get('/debug-patient/:phone', async (req, res) => {
  try {
    const phone = normalizeWhatsAppNumber(req.params.phone);
    const patient = await patientsCollection.findOne({ patientPhone: phone });
    res.json(patient || { error: 'Not found', phone });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/debug-token', (req, res) => {
  res.json({
    token_exists: !!WATI_TOKEN,
    token_preview: WATI_TOKEN ? WATI_TOKEN.substring(0, 20) + '...' : null,
    base_url: WATI_BASE_URL,
    template_name: TEMPLATE_NAME,
    lead_template: LEAD_TEMPLATE_NAME
  });
});

app.get('/test-ping', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Server is running!',
    time: new Date().toISOString()
  });
});

// ============================================
// ✅ HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
  try {
    const patientCount = await patientsCollection?.countDocuments() || 0;
    res.json({
      success: true,
      uptime: process.uptime(),
      mongodb: 'connected',
      patients: patientCount,
      time: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      success: true,
      uptime: process.uptime(),
      mongodb: 'error',
      time: new Date().toISOString()
    });
  }
});

// ============================================
// ✅ EXECUTIVE DASHBOARD (CONNECT-CHAT)
// ============================================
app.get('/connect-chat/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { token } = req.query;
  
  if (!verifyToken(chatId, token)) {
    return res.status(403).send('<h2>🔒 Unauthorized Access</h2>');
  }
  
  if (!patientsCollection) {
    return res.status(500).send('<h2>❌ Database not initialized</h2>');
  }
  
  const patient = await patientsCollection.findOne({ chatId });
  
  if (!patient) {
    return res.send('<h2>❌ Patient not found</h2>');
  }
  
  res.send(`
    <html>
      <head>
        <title>Patient Details</title>
        <style>
          body { font-family: Arial; padding: 20px; background: #f5f5f5; }
          .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
          .detail-row { margin: 15px 0; padding: 10px; background: #f8f9fa; border-radius: 5px; }
          .btn { padding: 10px 20px; margin: 5px; border: none; border-radius: 5px; cursor: pointer; }
          .btn-convert { background: #28a745; color: white; }
          .btn-waiting { background: #ffc107; color: black; }
          .btn-notconvert { background: #dc3545; color: white; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>👤 Patient Details</h1>
          <div class="detail-row"><strong>Patient:</strong> ${patient.patientName || 'N/A'}</div>
          <div class="detail-row"><strong>Phone:</strong> ${patient.patientPhone || 'N/A'}</div>
          <div class="detail-row"><strong>Branch:</strong> ${patient.branch || 'N/A'}</div>
          <div class="detail-row"><strong>Tests:</strong> ${patient.testNames || patient.tests || 'N/A'}</div>
          <div class="detail-row"><strong>Status:</strong> ${patient.status || 'pending'}</div>
          <div class="detail-row"><strong>Stage:</strong> ${patient.currentStage || 'pending'}</div>
          <a href="https://wa.me/${patient.patientPhone}" target="_blank">Chat on WhatsApp</a>
        </div>
      </body>
    </html>
  `);
});

// ============================================
// ✅ EXECUTIVE ACTION HANDLER
// ============================================
app.get('/exec-action', async (req, res) => {
  const { action, chat } = req.query;
  
  const status = 
    action === 'convert' ? 'converted' :
    action === 'waiting' ? 'waiting' : 'not_converted';
  
  const stage = 
    action === 'convert' ? STAGES.CONVERTED :
    action === 'waiting' ? STAGES.WAITING : STAGES.NOT_CONVERTED;
  
  await patientsCollection.updateOne(
    { chatId: chat },
    { 
      $set: { 
        status, 
        updatedAt: new Date(),
        currentStage: stage
      },
      $push: {
        stageHistory: { [stage]: new Date() }
      }
    }
  );
  
  res.send(`✅ Patient marked as ${status}`);
});

// ============================================
// ✅ API ENDPOINTS
// ============================================
app.get('/api/stage-stats', async (req, res) => {
  try {
    const stages = Object.values(STAGES);
    const stats = {};
    for (const stage of stages) {
      stats[stage] = await patientsCollection.countDocuments({ currentStage: stage });
    }
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/misscall-stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const total = await missCallsCollection?.countDocuments() || 0;
    const today_count = await missCallsCollection?.countDocuments({
      createdAt: { $gte: today }
    }) || 0;
    
    res.json({ total, today: today_count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ HOME ROUTE
// ============================================
app.get('/', (req, res) => {
  res.json({
    message: 'Tata-WATI Webhook Server',
    endpoints: {
      test_executive: '/test-executive-direct?exec=919106959092',
      test_ping: '/test-ping',
      health: '/health',
      webhook_wati: '/wati-webhook',
      webhook_tata: '/tata-misscall-whatsapp',
      dashboard: '/admin',
      stage_stats: '/api/stage-stats',
      misscall_stats: '/api/misscall-stats'
    }
  });
});

// ============================================
// ✅ DASHBOARD ROUTE
// ============================================
const dashboardRouter = require('./dashboard');
app.use('/admin', (req, res, next) => {
  if (!patientsCollection || !processedCollection) {
    return res.status(503).send('Dashboard unavailable');
  }
  req.patientsCollection = patientsCollection;
  req.processedCollection = processedCollection;
  req.missCallsCollection = missCallsCollection;
  req.STAGES = STAGES;
  req.PORT = PORT;
  next();
}, dashboardRouter);

// ============================================
// ✅ START SERVER
// ============================================
async function startServer() {
  try {
    console.log('🔄 Starting server...');
    await connectDB();
    
    const HOST = '0.0.0.0';
    const server = app.listen(PORT, HOST, () => {
      console.log('\n' + '='.repeat(60));
      console.log(`✅ SERVER RUNNING ON PORT ${PORT}`);
      console.log(`📍 WATI Webhook: /wati-webhook`);
      console.log(`📍 Tata Webhook: /tata-misscall-whatsapp`);
      console.log(`📍 Dashboard: /admin`);
      console.log(`📍 Test Executive: /test-executive-direct?exec=919106959092`);
      console.log('='.repeat(60) + '\n');
    });

    server.on('error', (err) => {
      console.error('❌ Server error:', err.message);
      process.exit(1);
    });

  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
