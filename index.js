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
const DEDUPE_WINDOW_MS = 0; // 0 means no deduplication - हर miss call पर template जाएगा
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
    await patientsCollection.createIndex({ missCallCount: -1 });
    
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
// ✅ IN-MEMORY STORAGE (DISABLED)
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

// ============================================
// ✅ FIXED UPDATE PATIENT STAGE - Stage History को array में बदलता है
// ============================================
async function updatePatientStage(patientId, stage) {
  try {
    // पहले patient check करो
    const patient = await patientsCollection.findOne({ _id: patientId });
    
    if (patient) {
      // अगर stageHistory object है या null है तो उसे array में बदलो
      if (!patient.stageHistory || typeof patient.stageHistory === 'object' && !Array.isArray(patient.stageHistory)) {
        await patientsCollection.updateOne(
          { _id: patientId },
          { $set: { stageHistory: [] } }
        );
      }
      
      // अब array में stage add करो
      await patientsCollection.updateOne(
        { _id: patientId },
        { 
          $set: { currentStage: stage, lastStageUpdate: new Date() },
          $push: { stageHistory: { stage: stage, timestamp: new Date() } }
        }
      );
    }
    return true;
  } catch (error) {
    console.error('❌ Stage update failed:', error.message);
    return false;
  }
}

// ============================================
// ✅ WATI TEMPLATE SENDER
// ============================================
async function sendWatiTemplateMessage(whatsappNumber, templateName, parameters) {
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
    
    return response.data;
  } catch (error) {
    console.error(`❌ Template send FAILED:`, error.message);
    throw error;
  }
}

// ============================================
// ✅ LEAD NOTIFICATION
// ============================================
async function sendLeadNotification(executiveNumber, patientName, patientPhone, branch, testNames, sourceType, chatId) {
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
    return true;
  } catch (error) {
    await session.abortTransaction();
    return false;
  } finally {
    session.endSession();
  }
}

// ============================================
// ✅ TATA TELE WEBHOOK
// ============================================
app.post('/tata-misscall-whatsapp', async (req, res) => {
  try {
    console.log('\n📞 TATA TELE WEBHOOK RECEIVED');
    
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.TATA_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    if (!callerNumberRaw) return res.status(400).json({ error: 'Caller number not found' });
    
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    const calledNumber = req.body.call_to_number || '';
    const branch = getBranchByCalledNumber(calledNumber);
    
    console.log(`📱 Caller: ${whatsappNumber}, Branch: ${branch.name}`);
    
    // MISS CALL TRACKING
    await missCallsCollection.insertOne({
      phoneNumber: whatsappNumber,
      calledNumber: calledNumber,
      branch: branch.name,
      createdAt: new Date()
    });
    
    const chatId = `${whatsappNumber}_${branch.name}`;
    
    const existingPatient = await patientsCollection.findOne({ 
      patientPhone: whatsappNumber
    });
    
    if (existingPatient) {
      await patientsCollection.updateOne(
        { _id: existingPatient._id },
        { 
          $set: { 
            missCallTime: new Date(),
            updatedAt: new Date(),
            branch: branch.name,
            status: 'awaiting_branch',
            currentStage: STAGES.AWAITING_BRANCH
          },
          $inc: { missCallCount: 1 }
        }
      );
      console.log(`✅ Patient updated, total miss calls: ${(existingPatient.missCallCount || 0) + 1}`);
    } else {
      // New patient के लिए stageHistory array initialize करो
      await patientsCollection.insertOne({
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
        missCallCount: 1,
        missCallTime: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        currentStage: STAGES.AWAITING_BRANCH,
        stageHistory: [{ stage: STAGES.AWAITING_BRANCH, timestamp: new Date() }]
      });
      console.log(`✅ New patient created`);
    }
    
    try {
      await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [
        { name: '1', value: branch.name }
      ]);
      console.log(`✅ Welcome template sent to ${whatsappNumber}`);
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
// ✅ WATI WEBHOOK - FIXED WITH STAGE HISTORY HANDLING
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('\n📨 WATI WEBHOOK RECEIVED');
    
    const msg = req.body;
    const msgId = msg.id || msg.messageId;
    if (!msgId) return res.sendStatus(200);
    
    if (await isMessageProcessed(msgId)) return res.sendStatus(200);
    
    const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
    if (!patientPhone) {
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
    const text = (msg.text || msg.body || '').toUpperCase().trim();
    console.log(`📝 Message: "${text}" from ${patientPhone}`);
    
    if (text.startsWith('DONE_')) {
      const branch = text.replace('DONE_', '');
      console.log(`🎯 BRANCH DETECTED: ${branch}`);
      
      const whatsappNumber = normalizeWhatsAppNumber(patientPhone);
      const executiveNumber = getExecutiveNumber(branch);
      
      let patient = await patientsCollection.findOne({ 
        patientPhone: whatsappNumber
      });
      
      const chatId = `${whatsappNumber}_${branch}`;
      
      if (!patient) {
        // New patient create with array
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
          missCallCount: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          currentStage: STAGES.BRANCH_SELECTED,
          stageHistory: [{ stage: STAGES.BRANCH_SELECTED, timestamp: new Date() }]
        });
        patient = { _id: result.insertedId };
        console.log(`✅ New patient created from DONE_ message`);
      } else {
        // Update existing patient - पहले stageHistory को array में बदलो अगर object है
        if (patient.stageHistory && typeof patient.stageHistory === 'object' && !Array.isArray(patient.stageHistory)) {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { $set: { stageHistory: [] } }
          );
        }
        
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
            $push: { stageHistory: { stage: STAGES.BRANCH_SELECTED, timestamp: new Date() } }
          }
        );
        console.log(`✅ Patient updated from DONE_ message`);
      }
      
      // Send executive notification
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
          
          // Update stage after notification
          if (patient.stageHistory && typeof patient.stageHistory === 'object' && !Array.isArray(patient.stageHistory)) {
            await patientsCollection.updateOne(
              { _id: patient._id },
              { $set: { stageHistory: [] } }
            );
          }
          
          await patientsCollection.updateOne(
            { _id: patient._id },
            {
              $set: { currentStage: STAGES.EXECUTIVE_NOTIFIED, lastStageUpdate: new Date() },
              $push: { stageHistory: { stage: STAGES.EXECUTIVE_NOTIFIED, timestamp: new Date() } }
            }
          );
        } else {
          console.log(`ℹ️ Notification already sent previously`);
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
// ✅ EMERGENCY FIX - CLEAN STAGE HISTORY
// ============================================
app.get('/fix-database', async (req, res) => {
  try {
    // सभी patients को ढूंढो जहाँ stageHistory object है
    const result = await patientsCollection.updateMany(
      { stageHistory: { $type: "object" } },
      { $set: { stageHistory: [] } }
    );
    
    res.json({ 
      success: true, 
      message: `Fixed ${result.modifiedCount} documents` 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ API STATS ENDPOINT
// ============================================
app.get('/api/stats', async (req, res) => {
  try {
    const totalPatients = await patientsCollection.countDocuments();
    const pendingCount = await patientsCollection.countDocuments({ status: 'pending' });
    const convertedCount = await patientsCollection.countDocuments({ status: 'converted' });
    const waitingCount = await patientsCollection.countDocuments({ status: 'waiting' });
    const notConvertedCount = await patientsCollection.countDocuments({ status: 'not_converted' });
    
    const stageStats = {};
    for (const stage of Object.values(STAGES)) {
      stageStats[stage] = await patientsCollection.countDocuments({ currentStage: stage }) || 0;
    }
    
    const missCallTotal = await missCallsCollection.countDocuments();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const missCallToday = await missCallsCollection.countDocuments({
      createdAt: { $gte: today }
    });
    
    const branchStats = await missCallsCollection.aggregate([
      { $group: { _id: '$branch', count: { $sum: 1 } } }
    ]).toArray();
    
    const branchMissCallMap = {};
    branchStats.forEach(b => { branchMissCallMap[b._id] = b.count; });
    
    const recentPatients = await patientsCollection.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    
    const recentMissCalls = await missCallsCollection.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    
    const topMissCallPatients = await patientsCollection.find()
      .sort({ missCallCount: -1 })
      .limit(5)
      .toArray();
    
    res.json({
      totalPatients,
      pendingCount,
      convertedCount,
      waitingCount,
      notConvertedCount,
      stageStats,
      missCallTotal,
      missCallToday,
      branchMissCallMap,
      recentPatients,
      recentMissCalls,
      topMissCallPatients,
      uptime: process.uptime()
    });
  } catch (error) {
    console.error('API Stats Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ CONNECT CHAT ENDPOINT
// ============================================
app.get('/connect-chat/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { token } = req.query;
  
  if (!verifyToken(chatId, token)) {
    return res.status(403).send('<h2>🔒 Unauthorized Access</h2>');
  }
  
  const patient = await patientsCollection.findOne({ chatId });
  if (!patient) return res.send('<h2>❌ Patient not found</h2>');
  
  res.send(`
    <html>
      <head><title>Patient Details</title></head>
      <body style="font-family: Arial; padding: 20px;">
        <h1>👤 Patient Details</h1>
        <p><strong>Name:</strong> ${patient.patientName || 'N/A'}</p>
        <p><strong>Phone:</strong> ${patient.patientPhone || 'N/A'}</p>
        <p><strong>Branch:</strong> ${patient.branch || 'N/A'}</p>
        <p><strong>Tests:</strong> ${patient.testNames || patient.tests || 'N/A'}</p>
        <p><strong>Status:</strong> ${patient.status || 'pending'}</p>
        <p><strong>Miss Calls:</strong> ${patient.missCallCount || 1}</p>
        <a href="https://wa.me/${patient.patientPhone}" target="_blank">💬 Chat on WhatsApp</a>
      </body>
    </html>
  `);
});

// ============================================
// ✅ EXECUTIVE ACTION
// ============================================
app.get('/exec-action', async (req, res) => {
  const { action, chat } = req.query;
  
  const status = action === 'convert' ? 'converted' : action === 'waiting' ? 'waiting' : 'not_converted';
  const stage = action === 'convert' ? STAGES.CONVERTED : action === 'waiting' ? STAGES.WAITING : STAGES.NOT_CONVERTED;
  
  await patientsCollection.updateOne(
    { chatId: chat },
    { 
      $set: { 
        status, 
        currentStage: stage, 
        updatedAt: new Date() 
      },
      $push: { stageHistory: { stage: stage, timestamp: new Date() } }
    }
  );
  
  res.send(`✅ Patient marked as ${status}`);
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
// ✅ HOME ROUTE
// ============================================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Tata-WATI Executive System',
    version: '2.0.0',
    endpoints: {
      admin_dashboard: '/admin',
      api_stats: '/api/stats',
      test_executive: '/test-executive-direct',
      health: '/health',
      webhook_wati: '/wati-webhook',
      webhook_tata: '/tata-misscall-whatsapp',
      fix_database: '/fix-database'
    }
  });
});

// ============================================
// ✅ DASHBOARD ROUTE
// ============================================
const dashboardRouter = require('./dashboard');

app.use('/admin', (req, res, next) => {
  if (!patientsCollection || !processedCollection) {
    return res.status(503).send(`
      <html>
        <head><title>Dashboard Unavailable</title></head>
        <body style="font-family: Arial; padding: 30px;">
          <h2 style="color: #dc3545;">⏳ Dashboard Initializing</h2>
          <p>Database connection is being established. Please refresh in a few seconds.</p>
          <button onclick="location.reload()" style="background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">Refresh Page</button>
        </body>
      </html>
    `);
  }
  req.patientsCollection = patientsCollection;
  req.processedCollection = processedCollection;
  req.missCallsCollection = missCallsCollection;
  req.STAGES = STAGES;
  req.PORT = PORT;
  next();
}, dashboardRouter);

app.get('/dashboard', (req, res) => {
  res.redirect('/admin');
});

// ============================================
// ✅ START SERVER
// ============================================
async function startServer() {
  try {
    console.log('🔄 Starting server...');
    await connectDB();
    
    const HOST = '0.0.0.0';
    app.listen(PORT, HOST, () => {
      console.log('\n' + '='.repeat(60));
      console.log(`✅ SERVER RUNNING ON PORT ${PORT}`);
      console.log(`📍 Admin Dashboard: http://localhost:${PORT}/admin`);
      console.log(`📍 Fix Database: http://localhost:${PORT}/fix-database`);
      console.log('='.repeat(60) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
