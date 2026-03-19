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
const HMAC_SECRET = process.env.HMAC_SECRET || 'tata_wati_hmac_2026';
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91';
const DEDUPE_WINDOW_MS = (parseInt(process.env.DEDUPE_WINDOW_SECONDS || '600', 10)) * 1000;
const TEMPLATE_NAME = process.env.MISSCALL_TEMPLATE_NAME || 'misscall_welcome_v3'; // Customer template
const LEAD_TEMPLATE_NAME = process.env.LEAD_TEMPLATE_NAME || 'lead_notification_v2'; // Executive template

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
    await patientsCollection.createIndex({ executiveActionTaken: 1 });
    
    console.log('✅ Indexes created');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    throw error;
  }
}

// ============================================
// ✅ EXECUTIVE NUMBERS MAPPING - All branches with same number
// ============================================
const EXECUTIVES = {
  'Naroda Team': '917880261858',
  'Usmanpura Team': '917880261858',
  'Vadaj Team': '917880261858',
  'Satellite Team': '917880261858',
  'Maninagar Team': '917880261858',
  'Bapunagar Team': '917880261858',
  'Juhapura Team': '917880261858',
  'Gandhinagar Team': '917880261858',
  'Manager': '917880261858'
};

console.log('✅ Executive numbers loaded (hardcoded):', EXECUTIVES);

// ============================================
// ✅ HELPER FUNCTIONS
// ============================================
function getExecutiveNumber(branchName) {
  // Format branch name properly (e.g., NARODA -> Naroda)
  const formattedBranch = branchName.charAt(0).toUpperCase() + branchName.slice(1).toLowerCase();
  const teamName = `${formattedBranch} Team`;
  return EXECUTIVES[teamName] || '917880261858';
}

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
  [normalizeIndianNumber(process.env.MANINAGAR_NUMBER || '9898989895')]: {
    name: 'Maninagar',
    executive: EXECUTIVES['Maninagar Team']
  },
  [normalizeIndianNumber(process.env.BAPUNAGAR_NUMBER || '9898989894')]: {
    name: 'Bapunagar',
    executive: EXECUTIVES['Bapunagar Team']
  },
  [normalizeIndianNumber(process.env.JUHAPURA_NUMBER || '9898989893')]: {
    name: 'Juhapura',
    executive: EXECUTIVES['Juhapura Team']
  },
  [normalizeIndianNumber(process.env.GANDHINAGAR_NUMBER || '9898989892')]: {
    name: 'Gandhinagar',
    executive: EXECUTIVES['Gandhinagar Team']
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
// ✅ UPDATE PATIENT STAGE
// ============================================
async function updatePatientStage(patientId, stage) {
  try {
    const patient = await patientsCollection.findOne({ _id: patientId });
    
    if (patient) {
      if (!patient.stageHistory || typeof patient.stageHistory === 'object' && !Array.isArray(patient.stageHistory)) {
        await patientsCollection.updateOne(
          { _id: patientId },
          { $set: { stageHistory: [] } }
        );
      }
      
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
// ✅ WATI TEMPLATE SENDER (Common function for all templates)
// ============================================
async function sendWatiTemplateMessage(whatsappNumber, templateName, parameters) {
  console.log(`📤 Sending template ${templateName} to ${whatsappNumber}`);
  
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
    
    console.log(`✅ Template ${templateName} sent successfully`);
    return response.data;
  } catch (error) {
    console.error(`❌ Template ${templateName} send FAILED:`, error.message);
    throw error;
  }
}

// ============================================
// ✅ LEAD NOTIFICATION (Executive template)
// ============================================
async function sendLeadNotification(executiveNumber, patientName, patientPhone, branch, testNames, sourceType, chatId) {
  console.log(`📤 Sending lead notification to executive ${executiveNumber}`);
  
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
      executiveActionTaken: { $ne: true }
    }, { session });
    
    if (!patient) {
      console.log(`⏭️ Executive already took action, skipping notification`);
      await session.abortTransaction();
      return false;
    }
    
    await notificationFunction();
    
    await session.commitTransaction();
    return true;
  } catch (error) {
    await session.abortTransaction();
    console.error(`❌ Atomic notification failed:`, error.message);
    return false;
  } finally {
    session.endSession();
  }
}

// ============================================
// ✅ TATA TELE WEBHOOK - Miss Call Handler
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
    
    // Track miss call
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
        executiveActionTaken: false,
        missCallCount: 1,
        missCallTime: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        currentStage: STAGES.AWAITING_BRANCH,
        stageHistory: [{ stage: STAGES.AWAITING_BRANCH, timestamp: new Date() }]
      });
      console.log(`✅ New patient created with executiveActionTaken=false`);
    }
    
    // Send customer template - MISSCALL_WELCOME_V3
    try {
      await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [
        { name: '1', value: branch.name }
      ]);
      console.log(`✅ Welcome template sent to customer ${whatsappNumber}`);
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
// ✅ WATI WEBHOOK - _BRANCH Message Handler (Updated)
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
    
    // ✅ Handle _BRANCH messages (NARODA_BRANCH, USMANPURA_BRANCH, etc.)
    if (text.endsWith('_BRANCH')) {
      const branchUpper = text.replace('_BRANCH', ''); // NARODA, USMANPURA, etc.
      // Format branch name properly (NARODA -> Naroda)
      const branch = branchUpper.charAt(0).toUpperCase() + branchUpper.slice(1).toLowerCase();
      
      console.log(`🎯 BRANCH DETECTED: ${branch}`);
      
      const whatsappNumber = normalizeWhatsAppNumber(patientPhone);
      const executiveNumber = getExecutiveNumber(branchUpper); // Pass uppercase for matching
      
      let patient = await patientsCollection.findOne({ 
        patientPhone: whatsappNumber
      });
      
      const chatId = `${whatsappNumber}_${branch}`;
      
      if (!patient) {
        // New patient
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
          executiveActionTaken: false,
          missCallCount: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          currentStage: STAGES.BRANCH_SELECTED,
          stageHistory: [{ stage: STAGES.BRANCH_SELECTED, timestamp: new Date() }]
        });
        patient = { _id: result.insertedId };
        console.log(`✅ New patient created with executiveActionTaken=false`);
      } else {
        // Update existing patient
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
        console.log(`✅ Patient updated, executiveActionTaken=${patient.executiveActionTaken || false}`);
      }
      
      // Send executive notification only if no action taken yet
      if (!patient.executiveActionTaken) {
        console.log(`📤 First time notification to executive ${executiveNumber}`);
        try {
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
            console.log(`✅✅ EXECUTIVE NOTIFICATION SENT to ${executiveNumber}`);
            
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
                  currentStage: STAGES.EXECUTIVE_NOTIFIED, 
                  lastStageUpdate: new Date() 
                },
                $push: { stageHistory: { stage: STAGES.EXECUTIVE_NOTIFIED, timestamp: new Date() } }
              }
            );
          }
        } catch (notifError) {
          console.error(`❌ Notification failed:`, notifError.message);
        }
      } else {
        console.log(`⏭️ Executive already took action, skipping notification`);
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
// ✅ EXECUTIVE ACTION HANDLER
// ============================================
app.get('/exec-action', async (req, res) => {
  const { action, chat } = req.query;
  
  const status = action === 'convert' ? 'converted' : action === 'waiting' ? 'waiting' : 'not_converted';
  const stage = action === 'convert' ? STAGES.CONVERTED : action === 'waiting' ? STAGES.WAITING : STAGES.NOT_CONVERTED;
  
  const result = await patientsCollection.updateOne(
    { chatId: chat },
    { 
      $set: { 
        status, 
        currentStage: stage, 
        updatedAt: new Date(),
        executiveActionTaken: true
      },
      $push: { stageHistory: { stage: stage, timestamp: new Date() } }
    }
  );
  
  if (result.modifiedCount > 0) {
    console.log(`✅ Executive action taken for chat ${chat}, executiveActionTaken set to true`);
    res.send(`✅ Patient marked as ${status} (future _BRANCH messages will be ignored)`);
  } else {
    res.send(`✅ Patient marked as ${status}`);
  }
});

// ============================================
// ✅ TEST ENDPOINTS
// ============================================

// Test executive notification
app.get('/test-executive-direct', async (req, res) => {
  try {
    const execNumber = req.query.exec || '917880261858';
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

// Test miss call template (customer template)
app.get('/test-misscall', async (req, res) => {
  try {
    const phone = req.query.phone || '919106959092';
    const branch = req.query.branch || 'Naroda';
    
    console.log(`🧪 Testing misscall template to ${phone} for branch ${branch}`);
    
    const result = await sendWatiTemplateMessage(phone, TEMPLATE_NAME, [
      { name: '1', value: branch }
    ]);
    
    res.json({ 
      success: true, 
      message: `Template ${TEMPLATE_NAME} sent to ${phone}`,
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
// ✅ API STATS ENDPOINT
// ============================================
app.get('/api/stats', async (req, res) => {
  try {
    const totalPatients = await patientsCollection.countDocuments();
    const pendingCount = await patientsCollection.countDocuments({ status: 'pending' });
    const convertedCount = await patientsCollection.countDocuments({ status: 'converted' });
    const waitingCount = await patientsCollection.countDocuments({ status: 'waiting' });
    const notConvertedCount = await patientsCollection.countDocuments({ status: 'not_converted' });
    
    const actionTakenCount = await patientsCollection.countDocuments({ executiveActionTaken: true });
    const actionPendingCount = await patientsCollection.countDocuments({ executiveActionTaken: false });
    
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
      actionTakenCount,
      actionPendingCount,
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
// ✅ FIX DATABASE ENDPOINT
// ============================================
app.get('/fix-database', async (req, res) => {
  try {
    const result1 = await patientsCollection.updateMany(
      { stageHistory: { $type: "object" } },
      { $set: { stageHistory: [] } }
    );
    
    const result2 = await patientsCollection.updateMany(
      { executiveActionTaken: { $exists: false } },
      { $set: { executiveActionTaken: false } }
    );
    
    res.json({ 
      success: true, 
      message: `Fixed ${result1.modifiedCount} stageHistory documents, initialized ${result2.modifiedCount} executiveActionTaken fields` 
    });
  } catch (error) {
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
  
  const actionStatus = patient.executiveActionTaken ? '✅ Action Taken' : '⏳ Pending';
  
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
        <p><strong>Executive Action:</strong> ${actionStatus}</p>
        <p><strong>Miss Calls:</strong> ${patient.missCallCount || 1}</p>
        <a href="https://wa.me/${patient.patientPhone}" target="_blank">💬 Chat on WhatsApp</a>
      </body>
    </html>
  `);
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
      test_misscall: '/test-misscall',
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
      console.log(`📍 Customer Template: ${TEMPLATE_NAME}`);
      console.log(`📍 Executive Template: ${LEAD_TEMPLATE_NAME}`);
      console.log(`📍 Branch Format: [BRANCH]_BRANCH (e.g., NARODA_BRANCH)`);
      console.log(`📍 Test Misscall: /test-misscall?phone=919106959092`);
      console.log('='.repeat(60) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
