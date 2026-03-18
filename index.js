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
const FOLLOWUP_TEMPLATE = process.env.FOLLOWUP_TEMPLATE || 'followup_template';
const CONFIRMATION_TEMPLATE = process.env.CONFIRMATION_TEMPLATE || 'confirmation_template';
const ASK_DATE_TEMPLATE = process.env.ASK_DATE_TEMPLATE || 'ask_date_template';

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
// ✅ DATABASE CONNECTION WITH INDEX FIX
// ============================================
let db;
let processedCollection;
let patientsCollection;
let executivesCollection;
let missCallsCollection;

async function connectDB() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    console.log('MongoDB URI:', MONGODB_URI ? '✅ Present' : '❌ Missing');
    
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in environment variables');
    }
    
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ MongoDB connected successfully');
    
    db = client.db('executive_system');
    processedCollection = db.collection('processed_messages');
    patientsCollection = db.collection('patients');
    executivesCollection = db.collection('executives');
    missCallsCollection = db.collection('miss_calls');
    
    console.log('✅ Collections initialized');
    
    // ============================================
    // ✅ FIX INDEX CONFLICT - DROP AND RECREATE
    // ============================================
    
    // Get existing indexes
    const existingIndexes = await patientsCollection.indexes();
    console.log('📋 Existing indexes:', existingIndexes.map(idx => idx.name));
    
    // Check for chatId index and drop if exists
    const chatIdIndex = existingIndexes.find(idx => idx.name === 'chatId_1');
    if (chatIdIndex) {
      console.log('⚠️ Found existing chatId_1 index, dropping it...');
      await patientsCollection.dropIndex('chatId_1');
      console.log('✅ Dropped old chatId_1 index');
    }
    
    // Create new indexes safely
    const indexesToCreate = [
      {
        name: 'chatId_1',
        key: { chatId: 1 },
        unique: true,
        sparse: true
      },
      {
        name: 'patientPhone_1_status_1',
        key: { patientPhone: 1, status: 1 }
      },
      {
        name: 'patientPhone_1_createdAt_-1',
        key: { patientPhone: 1, createdAt: -1 }
      },
      {
        name: 'status_1_followupDate_1',
        key: { status: 1, followupDate: 1 }
      },
      {
        name: 'patientPhone_1_branch_1_status_1',
        key: { patientPhone: 1, branch: 1, status: 1 }
      },
      {
        name: 'followupDate_1',
        key: { followupDate: 1 }
      },
      {
        name: 'createdAt_1',
        key: { createdAt: 1 }
      },
      {
        name: 'lastNotificationSentAt_1',
        key: { lastNotificationSentAt: 1 }
      },
      {
        name: 'notificationSent_1',
        key: { notificationSent: 1 }
      },
      {
        name: 'currentStage_1',
        key: { currentStage: 1 }
      },
      {
        name: 'patientPhone_1_status_1_createdAt_-1',
        key: { patientPhone: 1, status: 1, createdAt: -1 }
      }
    ];
    
    for (const indexSpec of indexesToCreate) {
      try {
        await patientsCollection.createIndex(indexSpec.key, {
          name: indexSpec.name,
          unique: indexSpec.unique || false,
          sparse: indexSpec.sparse || false,
          background: true
        });
        console.log(`✅ Created index: ${indexSpec.name}`);
      } catch (indexError) {
        if (indexError.code === 85 || indexError.codeName === 'IndexOptionsConflict') {
          console.log(`⚠️ Index ${indexSpec.name} already exists with different options, skipping...`);
        } else {
          console.error(`❌ Failed to create index ${indexSpec.name}:`, indexError.message);
        }
      }
    }
    
    console.log('✅ All indexes verified successfully');
    
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
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
  AWAITING_PRESCRIPTION: 'awaiting_prescription',
  PRESCRIPTION_UPLOADED: 'prescription_uploaded',
  OCR_PROCESSING: 'ocr_processing',
  OCR_COMPLETED: 'ocr_completed',
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
// ✅ TOKEN GENERATION (HMAC) WITH SAFE COMPARE
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
// ✅ TIMEOUT HANDLER
// ============================================
function timeout(ms) {
  return new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  );
}

// ============================================
// ✅ RETRY MECHANISM WITH TIMEOUT
// ============================================
async function retryWithTimeout(fn, timeoutMs = 5000, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await Promise.race([
        fn(),
        timeout(timeoutMs)
      ]);
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`⚠️ Retry ${i + 1}/${retries} failed: ${error.message}`);
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
    }
  }
}

// ============================================
// ✅ RATE LIMIT DELAY
// ============================================
async function rateLimitDelay() {
  await new Promise(r => setTimeout(r, 300));
}

// ============================================
// ✅ PARSE DATE FUNCTION
// ============================================
function parseDate(text) {
  try {
    const [d, m, y] = text.split('/');
    const date = new Date(`${y}-${m}-${d}`);
    if (isNaN(date.getTime())) return null;
    return date;
  } catch {
    return null;
  }
}

// ============================================
// ✅ NUMBER NORMALIZATION FUNCTIONS
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

function getCalledNumberFromPayload(body) {
  return body.call_to_number || 
         body.called_number || 
         body.to || 
         body.destination || 
         body.did || 
         body.virtual_number || 
         '';
}

// ============================================
// ✅ DATABASE HELPER FUNCTIONS
// ============================================
async function isMessageProcessed(messageId) {
  if (!processedCollection) return false;
  const processed = await processedCollection.findOne({ messageId });
  return !!processed;
}

async function markMessageProcessed(messageId) {
  if (!processedCollection) return;
  await processedCollection.updateOne(
    { messageId },
    { $set: { messageId, processedAt: new Date() } },
    { upsert: true }
  );
}

function getPriority(testNames) {
  const tests = testNames.toLowerCase();
  if (tests.includes('mri') || tests.includes('ct') || tests.includes('emergency')) {
    return 'high';
  }
  if (tests.includes('blood') || tests.includes('x-ray')) {
    return 'medium';
  }
  return 'low';
}

function getExecutiveNumber(branchName) {
  const teamName = `${branchName} Team`;
  return EXECUTIVES[teamName] || process.env.DEFAULT_EXECUTIVE || '917880261858';
}

function safeJSONParse(content) {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { patientName: 'Not found', tests: 'Not found' };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      patientName: parsed.patientName || 'Not found',
      tests: parsed.tests || 'Not found'
    };
  } catch {
    return { patientName: 'Not found', tests: 'Not found' };
  }
}

// ============================================
// ✅ UPDATE PATIENT STAGE
// ============================================
async function updatePatientStage(patientId, stage, metadata = {}) {
  try {
    const updateData = {
      currentStage: stage,
      lastStageUpdate: new Date(),
      ...metadata
    };
    
    // Add stage history
    updateData[`stageHistory.${stage}`] = new Date();
    
    await patientsCollection.updateOne(
      { _id: patientId },
      { $set: updateData }
    );
    
    console.log(`📍 Stage updated for patient ${patientId}: ${stage}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to update stage:`, error.message);
    return false;
  }
}

// ============================================
// ✅ WATI TEMPLATE SENDER
// ============================================
async function sendWatiTemplateMessage(whatsappNumber, templateName, parameters) {
  try {
    console.log(`📱 Sending template ${templateName} to ${whatsappNumber}`);
    
    const payload = {
      template_name: templateName,
      broadcast_name: `msg_${Date.now()}`,
      parameters: parameters || []
    };
    
    const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
    
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
    console.error('❌ Template send failed:', error.response?.data || error.message);
    throw error;
  }
}

// ============================================
// ✅ LEAD NOTIFICATION - WITH ATOMIC FLAG
// ============================================
async function sendLeadNotification(
  executiveNumber, 
  patientName, 
  patientPhone, 
  branch, 
  testNames, 
  sourceType, 
  chatId
) {
  console.log(`📤 Preparing lead notification for executive ${executiveNumber}`);
  
  const safePatientName = patientName || "Miss Call Patient";
  const safeTestNames = testNames || "Miss Call";
  const safeSourceType = sourceType || "Miss Call";
  
  const parameters = [
    { name: "1", value: safePatientName },
    { name: "2", value: patientPhone },
    { name: "3", value: branch },
    { name: "4", value: safeTestNames },
    { name: "5", value: safeSourceType },
    { name: "6", value: `${SELF_URL}/connect-chat/${chatId}?token=${generateToken(chatId)}` }
  ];
  
  console.log(`📦 Parameters:`, JSON.stringify(parameters));
  
  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${executiveNumber}`;
  const payload = {
    template_name: LEAD_TEMPLATE_NAME,
    broadcast_name: `lead_${Date.now()}`,
    parameters: parameters
  };
  
  const response = await axios.post(url, payload, {
    headers: {
      'Authorization': WATI_TOKEN,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
  
  console.log(`✅ Lead notification sent successfully to ${executiveNumber}`);
  return response.data;
}

// ============================================
// ✅ ATOMIC NOTIFICATION SENDER (RACE CONDITION FREE)
// ============================================
async function sendNotificationAtomic(patientId, notificationFunction) {
  const session = patientsCollection.client.startSession();
  
  try {
    session.startTransaction();
    
    // Atomic check using $or for null/missing
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
    
    // Execute notification
    await notificationFunction();
    
    // Mark as sent
    await patientsCollection.updateOne(
      { _id: patientId },
      { 
        $set: { 
          notificationSent: true,
          lastNotificationSentAt: new Date()
        } 
      },
      { session }
    );
    
    await session.commitTransaction();
    console.log(`✅ Atomic notification sent successfully`);
    return true;
    
  } catch (error) {
    await session.abortTransaction();
    console.error(`❌ Atomic notification failed:`, error);
    throw error;
  } finally {
    session.endSession();
  }
}

// ============================================
// ✅ ATOMIC LEAD CREATION/UPSERT
// ============================================
async function createOrUpdateLead(chatId, patientName, patientPhone, branch, testNames, sourceType, executiveNumber, priority, imageUrl = null) {
  if (!patientsCollection) return false;
  
  const now = new Date();
  
  const result = await patientsCollection.updateOne(
    { 
      patientPhone, 
      branch, 
      status: { $in: ['pending', 'waiting'] } 
    },
    {
      $setOnInsert: {
        chatId,
        patientName,
        patientPhone,
        branch,
        testNames,
        sourceType,
        executiveNumber,
        priority,
        status: 'pending',
        notificationSent: false,
        followupDate: null,
        createdAt: now,
        updatedAt: now,
        missCallTime: sourceType === 'Miss Call' ? now : null,
        currentStage: sourceType === 'Miss Call' ? STAGES.MISS_CALL_RECEIVED : STAGES.AWAITING_PRESCRIPTION,
        stageHistory: {
          [sourceType === 'Miss Call' ? STAGES.MISS_CALL_RECEIVED : STAGES.AWAITING_PRESCRIPTION]: now
        }
      },
      $set: imageUrl ? { imageUrl, updatedAt: now } : { updatedAt: now }
    },
    { upsert: true }
  );
  
  return result.upsertedCount > 0;
}

// ============================================
// ✅ PROCESS MANUAL ENTRY
// ============================================
async function processManualEntry(messageId, patientName, testNames, branch, patientPhone) {
  console.log(`\n📝 Processing manual entry`);
  
  const executiveNumber = getExecutiveNumber(branch);
  const priority = getPriority(testNames);
  const chatId = `${patientPhone}_${branch}`;
  
  const isNew = await createOrUpdateLead(
    chatId, patientName, patientPhone, branch, testNames, 'Manual', 
    executiveNumber, priority
  );
  
  if (isNew) {
    // For new leads, we need to get the inserted ID
    const patient = await patientsCollection.findOne({ chatId });
    if (patient) {
      await updatePatientStage(patient._id, STAGES.AWAITING_PRESCRIPTION);
      await sendNotificationAtomic(patient._id, () => 
        sendLeadNotification(
          executiveNumber, patientName, patientPhone, branch, testNames, "Manual", chatId
        )
      );
      await updatePatientStage(patient._id, STAGES.EXECUTIVE_NOTIFIED);
    }
  } else {
    console.log(`ℹ️ Lead already exists, skipping notification`);
  }
  
  await markMessageProcessed(messageId);
}

// ============================================
// ✅ PRODUCTION-READY PROCESS IMAGE UPLOAD
// ============================================
async function processImageUpload(messageId, patientName, branch, imageUrl, patientPhone) {
  console.log(`\n📸 Processing image upload for ${patientPhone}`);
  
  try {
    // Find active patient
    const patient = await patientsCollection.findOne({
      patientPhone: patientPhone,
      status: { $in: ['awaiting_branch', 'pending', 'waiting'] }
    }, { 
      sort: { createdAt: -1 },
      limit: 1 
    });
    
    if (!patient) {
      console.log(`❌ No active patient found for ${patientPhone}, creating temporary`);
      
      // Create temporary patient
      const tempChatId = `${patientPhone}_${branch}`;
      const insertResult = await patientsCollection.insertOne({
        chatId: tempChatId,
        patientName: 'Miss Call Patient',
        patientPhone: patientPhone,
        branch: branch,
        testNames: 'Awaiting details',
        sourceType: 'Miss Call',
        executiveNumber: getExecutiveNumber(branch),
        priority: 'low',
        status: 'pending',
        notificationSent: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        currentStage: STAGES.AWAITING_PRESCRIPTION,
        stageHistory: { [STAGES.AWAITING_PRESCRIPTION]: new Date() }
      });
      
      patient._id = insertResult.insertedId;
    }
    
    await updatePatientStage(patient._id, STAGES.PRESCRIPTION_UPLOADED);
    
    const finalBranch = patient.branch || branch;
    const executiveNumber = getExecutiveNumber(finalBranch);
    const chatId = patient.chatId || `${patientPhone}_${finalBranch}`;
    
    console.log(`🏥 Using branch: ${finalBranch}, Executive: ${executiveNumber}`);
    
    // Perform OCR with safe fallback
    await updatePatientStage(patient._id, STAGES.OCR_PROCESSING);
    
    let extracted = { patientName: patientName, tests: 'Unknown' };
    try {
      extracted = await retryWithTimeout(() => extractWithOpenAI(imageUrl), 10000, 2);
      console.log(`✅ OCR successful:`, extracted);
      await updatePatientStage(patient._id, STAGES.OCR_COMPLETED);
    } catch (ocrError) {
      console.error(`❌ OCR failed, using fallback:`, ocrError.message);
    }
    
    const priority = getPriority(extracted.tests);
    
    // Update patient record
    await patientsCollection.updateOne(
      { _id: patient._id },
      {
        $set: {
          patientName: extracted.patientName || patientName,
          testNames: extracted.tests,
          imageUrl: imageUrl,
          updatedAt: new Date(),
          priority: priority,
          status: 'pending',
          lastUploadTime: new Date()
        }
      }
    );
    
    console.log(`✅ Patient record updated with OCR data`);
    
    // Send notification atomically
    const notified = await sendNotificationAtomic(patient._id, () => 
      sendLeadNotification(
        executiveNumber,
        extracted.patientName || patientName,
        patientPhone,
        finalBranch,
        extracted.tests,
        "📸 Prescription Upload",
        chatId
      )
    );
    
    if (notified) {
      await updatePatientStage(patient._id, STAGES.EXECUTIVE_NOTIFIED);
    }
    
    return true;
    
  } catch (error) {
    console.error(`❌ processImageUpload error:`, error);
    return false;
  } finally {
    await markMessageProcessed(messageId);
  }
}

// ============================================
// ✅ OPENAI OCR WITH TIMEOUT
// ============================================
async function extractWithOpenAI(imageUrl) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Extract patient name and tests from this medical prescription. Return JSON with keys: patientName, tests`
          },
          {
            type: "image_url",
            image_url: { url: imageUrl }
          }
        ]
      }
    ],
    max_tokens: 300
  });
  
  const content = response.choices[0].message.content;
  return safeJSONParse(content);
}

// ============================================
// ✅ TATA TELE WEBHOOK
// ============================================
app.post('/tata-misscall-whatsapp', async (req, res) => {
  try {
    console.log('='.repeat(60));
    console.log('📞 TATA TELE WEBBOOK RECEIVED');
    
    // Verify API key
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.TATA_SECRET) {
      console.log('❌ Unauthorized');
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    if (!callerNumberRaw) {
      return res.status(400).json({ error: 'Caller number not found' });
    }
    
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    if (!whatsappNumber) {
      return res.status(400).json({ error: 'Invalid number' });
    }
    
    const calledNumber = req.body.call_to_number || '';
    const branch = getBranchByCalledNumber(calledNumber);
    
    if (shouldSkipDuplicateMissCall(whatsappNumber, calledNumber)) {
      return res.json({ skipped: true });
    }
    
    // Save to patients collection
    const chatId = `${whatsappNumber}_${branch.name}`;
    const existingPatient = await patientsCollection.findOne({ 
      patientPhone: whatsappNumber,
      status: { $in: ['awaiting_branch', 'pending', 'waiting'] }
    });
    
    let patientId;
    if (!existingPatient) {
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
      patientId = result.insertedId;
      console.log('✅ New patient created (awaiting_branch)');
    } else {
      patientId = existingPatient._id;
      await updatePatientStage(patientId, STAGES.AWAITING_BRANCH);
    }
    
    // Send welcome template
    await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [
      { name: '1', value: branch.name }
    ]);
    
    res.json({ success: true, whatsappNumber, branch: branch.name, patientId });
    
  } catch (error) {
    console.error('❌ Tata Tele error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ WATI WEBHOOK - WITH COMPLETE BRANCH HANDLING
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    // Security check
    if (req.headers['authorization'] !== `Bearer ${WATI_TOKEN}`) {
      console.log('⚠️ Unauthorized webhook attempt');
      return res.sendStatus(403);
    }
    
    console.log('📨 WATI Webhook received');
    
    const msg = req.body;
    const msgId = msg.id || msg.messageId || msg._id;
    
    if (!msgId || await isMessageProcessed(msgId)) {
      return res.sendStatus(200);
    }
    
    const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
    if (!patientPhone) {
      return res.sendStatus(200);
    }
    
    const branchNames = ['Naroda', 'Usmanpura', 'Vadaj', 'Satellite', 'Test Branch'];
    
    // Handle button clicks
    if (msg.buttonText || msg.button) {
      const action = msg.buttonText || msg.button;
      console.log(`🔘 Button clicked: "${action}"`);
      
      // Branch selection
      if (branchNames.includes(action)) {
        // Find patient atomically
        const patient = await patientsCollection.findOneAndUpdate(
          {
            patientPhone: patientPhone,
            status: 'awaiting_branch'
          },
          {
            $set: {
              branch: action,
              status: 'pending',
              executiveNumber: getExecutiveNumber(action),
              updatedAt: new Date(),
              currentStage: STAGES.BRANCH_SELECTED
            },
            $push: {
              stageHistory: { [STAGES.BRANCH_SELECTED]: new Date() }
            }
          },
          {
            sort: { createdAt: -1 },
            returnDocument: 'before'
          }
        );
        
        if (patient.value) {
          console.log(`✅ Branch updated for patient`);
          await updatePatientStage(patient.value._id, STAGES.BRANCH_SELECTED);
          
          // Send notification if not already sent
          if (!patient.value.notificationSent) {
            await sendNotificationAtomic(patient.value._id, () =>
              sendLeadNotification(
                getExecutiveNumber(action),
                patient.value.patientName,
                patientPhone,
                action,
                'Branch Selected',
                '📞 Miss Call',
                `${patientPhone}_${action}`
              )
            );
            await updatePatientStage(patient.value._id, STAGES.EXECUTIVE_NOTIFIED);
          }
        } else {
          console.log(`⚠️ No awaiting_branch patient found, creating new`);
          
          // Create new patient
          const chatId = `${patientPhone}_${action}`;
          const execNumber = getExecutiveNumber(action);
          const result = await patientsCollection.insertOne({
            chatId,
            patientName: 'Miss Call Patient',
            patientPhone: patientPhone,
            branch: action,
            testNames: 'Branch selected',
            sourceType: 'Miss Call',
            executiveNumber: execNumber,
            priority: 'low',
            status: 'pending',
            notificationSent: true,
            lastNotificationSentAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
            currentStage: STAGES.EXECUTIVE_NOTIFIED,
            stageHistory: {
              [STAGES.BRANCH_SELECTED]: new Date(),
              [STAGES.EXECUTIVE_NOTIFIED]: new Date()
            }
          });
          
          // Send notification
          await sendLeadNotification(
            execNumber,
            'Miss Call Patient',
            patientPhone,
            action,
            'Branch Selected',
            '📞 Miss Call',
            chatId
          );
        }
        
        await markMessageProcessed(msgId);
        return res.sendStatus(200);
      }
      
      // Handle other buttons (Convert, Waiting, Not Convert)
      if (action === '✅ Convert Done') {
        const patient = await patientsCollection.findOneAndUpdate(
          { patientPhone, status: { $in: ['pending', 'waiting'] } },
          { 
            $set: { 
              status: 'converted', 
              updatedAt: new Date(),
              currentStage: STAGES.CONVERTED
            },
            $push: {
              stageHistory: { [STAGES.CONVERTED]: new Date() }
            }
          },
          { sort: { createdAt: -1 } }
        );
        
        if (patient.value) {
          await sendWatiTemplateMessage(patientPhone, CONFIRMATION_TEMPLATE, [
            { name: "1", value: "✅ Patient marked as converted" }
          ]);
        }
      }
      else if (action === '⏳ Waiting') {
        const patient = await patientsCollection.findOneAndUpdate(
          { patientPhone, status: 'pending' },
          { 
            $set: { 
              awaiting_followup: true,
              currentStage: STAGES.WAITING
            },
            $push: {
              stageHistory: { [STAGES.WAITING]: new Date() }
            }
          },
          { sort: { createdAt: -1 } }
        );
        
        if (patient.value) {
          await sendWatiTemplateMessage(patientPhone, ASK_DATE_TEMPLATE, [
            { name: "1", value: "Please send follow-up date (DD/MM/YYYY)" }
          ]);
        }
      }
      else if (action === '❌ Not Convert') {
        const patient = await patientsCollection.findOneAndUpdate(
          { patientPhone, status: { $in: ['pending', 'waiting'] } },
          { 
            $set: { 
              status: 'not_converted', 
              updatedAt: new Date(),
              currentStage: STAGES.NOT_CONVERTED
            },
            $push: {
              stageHistory: { [STAGES.NOT_CONVERTED]: new Date() }
            }
          },
          { sort: { createdAt: -1 } }
        );
        
        if (patient.value) {
          await sendLeadNotification(
            EXECUTIVES['Manager'],
            'Escalation Alert',
            EXECUTIVES['Manager'],
            'ALL',
            'Not Converted',
            '⚠️ Escalation',
            patient.value.chatId
          );
          await updatePatientStage(patient.value._id, STAGES.ESCALATED);
        }
      }
      
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
    // Handle image messages
    if (msg.type === 'image' || msg.messageType === 'image') {
      const imageUrl = msg.mediaUrl || msg.url || msg.image?.url;
      if (imageUrl) {
        await processImageUpload(msgId, 'Patient', 'Naroda', imageUrl, patientPhone);
      } else {
        await markMessageProcessed(msgId);
      }
      return res.sendStatus(200);
    }
    
    // Handle text messages
    if (msg.type === 'text' || msg.messageType === 'text') {
      const text = msg.text || msg.body || '';
      if (text.toLowerCase().includes('manual') || text.toLowerCase().includes('test')) {
        await processManualEntry(msgId, 'Patient', text, 'Naroda', patientPhone);
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
// ✅ FOLLOW-UP DATE HANDLER
// ============================================
app.post('/webhook/followup-date', async (req, res) => {
  try {
    const { patientPhone, followupDate, branch } = req.body;
    const date = parseDate(followupDate);
    
    if (!date) {
      return res.status(400).json({ error: 'Invalid date format. Use DD/MM/YYYY' });
    }
    
    const result = await patientsCollection.updateOne(
      { patientPhone, branch, status: 'pending' },
      { 
        $set: { 
          followupDate: date,
          status: 'waiting',
          awaiting_followup: false,
          updatedAt: new Date(),
          currentStage: STAGES.WAITING
        },
        $push: {
          stageHistory: { [STAGES.WAITING]: new Date() }
        }
      }
    );
    
    res.json({ success: true, matched: result.matchedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ CRON JOBS
// ============================================
cron.schedule('*/5 * * * *', async () => {
  console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Fallback check for missed messages...`);
  
  try {
    const from = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const to = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    let url;
    if (WATI_BASE_URL.includes('/api/v1')) {
      url = `${WATI_BASE_URL}/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
    } else {
      url = `${WATI_BASE_URL}/api/v1/getMessages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=50`;
    }
    
    console.log('🔍 Fetching messages from:', url);
    
    const response = await axios.get(url, {
      headers: { Authorization: `${WATI_TOKEN}` }
    });
    
    let messages = [];
    if (Array.isArray(response.data)) messages = response.data;
    else if (response.data?.messages) messages = response.data.messages;
    else if (response.data?.data) messages = response.data.data;
    
    console.log(`📨 Found ${messages.length} messages`);
    
    for (const msg of messages) {
      await rateLimitDelay();
      
      const msgId = msg.id || msg.messageId || msg._id;
      if (!msgId || await isMessageProcessed(msgId)) continue;
      
      const patientPhone = msg.whatsappNumber || msg.from || msg.waId;
      if (!patientPhone) continue;
      
      const branch = 'Naroda';
      
      if (msg.type === 'text' || msg.messageType === 'text') {
        const text = msg.text || msg.body || '';
        if (text.toLowerCase().includes('manual') || text.toLowerCase().includes('test')) {
          await processManualEntry(msgId, 'Patient', text, branch, patientPhone);
        } else {
          await markMessageProcessed(msgId);
        }
      }
      else if (msg.type === 'image' || msg.messageType === 'image') {
        const imageUrl = msg.mediaUrl || msg.url || msg.image?.url;
        if (imageUrl) {
          await processImageUpload(msgId, 'Patient', branch, imageUrl, patientPhone);
        } else {
          await markMessageProcessed(msgId);
        }
      } else {
        await markMessageProcessed(msgId);
      }
    }
  } catch (error) {
    console.error('❌ Fallback cron error:', error.response?.status ? 
      `Status ${error.response.status}: ${error.response.data}` : error.message);
  }
});

// ============================================
// ✅ AUTO FOLLOW-UP
// ============================================
cron.schedule('*/30 * * * *', async () => {
  console.log('⏰ Checking for pending leads...');
  
  if (!patientsCollection) {
    console.error('❌ patientsCollection is undefined in follow-up cron');
    return;
  }
  
  try {
    const pendingLeads = await patientsCollection.find({
      status: 'waiting',
      followupDate: { $lt: new Date() },
      $or: [
        { lastNotificationSentAt: null },
        { lastNotificationSentAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
      ]
    }).toArray();
    
    console.log(`📊 Found ${pendingLeads.length} pending leads for follow-up`);
    
    for (const lead of pendingLeads) {
      await sendLeadNotification(
        lead.executiveNumber,
        lead.patientName,
        lead.patientPhone,
        lead.branch,
        lead.testNames || lead.tests || 'Follow-up',
        '⏰ Follow-up Reminder',
        lead.chatId
      );
      
      await patientsCollection.updateOne(
        { _id: lead._id },
        { 
          $set: { 
            lastNotificationSentAt: new Date(),
            currentStage: STAGES.EXECUTIVE_NOTIFIED 
          },
          $push: {
            stageHistory: { [STAGES.EXECUTIVE_NOTIFIED]: new Date() }
          }
        }
      );
    }
  } catch (error) {
    console.error('❌ Follow-up cron error:', error.message);
  }
});

// ============================================
// ✅ MANAGER ESCALATION
// ============================================
cron.schedule('0 21 * * *', async () => {
  if (!patientsCollection) {
    console.error('❌ patientsCollection is undefined in manager escalation');
    return;
  }
  
  try {
    const notConverted = await patientsCollection.find({
      status: 'not_converted',
      createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }).toArray();
    
    if (notConverted.length > 0) {
      const summary = notConverted.map(p => 
        `❌ ${p.patientName} (${p.branch})`
      ).join('\n');
      
      await sendLeadNotification(
        EXECUTIVES['Manager'],
        'Daily Escalation Summary',
        EXECUTIVES['Manager'],
        'ALL',
        `${notConverted.length} leads not converted today`,
        '📊 Summary',
        `summary-${Date.now()}`
      );
      
      for (const patient of notConverted) {
        await updatePatientStage(patient._id, STAGES.ESCALATED);
      }
    }
  } catch (error) {
    console.error('❌ Manager escalation error:', error.message);
  }
});

// ============================================
// ✅ EXECUTIVE DASHBOARD
// ============================================
app.get('/connect-chat/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { token } = req.query;
  
  if (!verifyToken(chatId, token)) {
    return res.status(403).send(`
      <html>
        <head><title>Unauthorized</title></head>
        <body style="font-family: Arial; padding: 30px;">
          <h2>🔒 Unauthorized Access</h2>
          <p>Invalid access token</p>
        </body>
      </html>
    `);
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
          .priority-high { border-left: 4px solid #dc3545; }
          .priority-medium { border-left: 4px solid #ffc107; }
          .priority-low { border-left: 4px solid #28a745; }
          .detail-row { margin: 15px 0; padding: 10px; background: #f8f9fa; border-radius: 5px; }
          .whatsapp-btn { display: inline-block; background: #25D366; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .btn-group { margin-top: 30px; display: flex; gap: 10px; flex-wrap: wrap; }
          .btn { padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
          .btn-convert { background: #28a745; color: white; }
          .btn-waiting { background: #ffc107; color: black; }
          .btn-notconvert { background: #dc3545; color: white; }
          .stage-badge { display: inline-block; padding: 4px 8px; border-radius: 12px; font-size: 0.8em; font-weight: 600; margin-left: 10px; }
          .stage-misscall { background: #fef3c7; color: #92400e; }
          .stage-branch { background: #dbeafe; color: #1e40af; }
          .stage-ocr { background: #d1fae5; color: #065f46; }
          .stage-executive { background: #ede9fe; color: #5b21b6; }
        </style>
      </head>
      <body>
        <div class="container priority-${patient.priority || 'low'}">
          <h1>👤 Patient Details 
            <span class="stage-badge stage-${patient.currentStage || 'pending'}">
              ${patient.currentStage?.replace(/_/g, ' ') || 'pending'}
            </span>
          </h1>
          
          <div class="detail-row">
            <strong>Patient:</strong> ${patient.patientName || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Phone:</strong> ${patient.patientPhone || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Branch:</strong> ${patient.branch || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Tests:</strong> ${patient.testNames || patient.tests || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Source:</strong> ${patient.sourceType || patient.entryType || 'N/A'}
          </div>
          <div class="detail-row">
            <strong>Priority:</strong> ${patient.priority || 'low'}
          </div>
          <div class="detail-row">
            <strong>Status:</strong> ${patient.status || 'pending'}
          </div>
          <div class="detail-row">
            <strong>Current Stage:</strong> ${patient.currentStage?.replace(/_/g, ' ') || 'pending'}
          </div>
          <div class="detail-row">
            <strong>Miss Call Time:</strong> ${patient.missCallTime ? new Date(patient.missCallTime).toLocaleString() : 'N/A'}
          </div>
          
          ${patient.imageUrl ? `
            <div class="detail-row">
              <h3>📄 Prescription</h3>
              <iframe src="${patient.imageUrl}" style="width:100%; height:300px;"></iframe>
            </div>
          ` : ''}
          
          <a href="https://wa.me/${patient.patientPhone}" target="_blank" class="whatsapp-btn">
            💬 Chat on WhatsApp
          </a>
          
          <div class="btn-group">
            <button class="btn btn-convert" onclick="updateStatus('convert')">✅ Convert</button>
            <button class="btn btn-waiting" onclick="updateStatus('waiting')">⏳ Waiting</button>
            <button class="btn btn-notconvert" onclick="updateStatus('notconvert')">❌ Not Convert</button>
          </div>
        </div>
        
        <script>
          function updateStatus(action) {
            fetch('/exec-action?action=' + action + '&chat=${patient.chatId}')
              .then(response => response.text())
              .then(data => alert(data))
              .then(() => setTimeout(() => location.reload(), 1000));
          }
        </script>
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
// ✅ STAGE STATS ENDPOINT
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

// ============================================
// ✅ MISS CALL STATS ENDPOINT
// ============================================
app.get('/api/misscall-stats', async (req, res) => {
  try {
    if (!missCallsCollection || !patientsCollection) {
      return res.json({ total: 0, today: 0, byBranch: {}, awaitingBranch: 0 });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const total = await missCallsCollection.countDocuments();
    const today_count = await missCallsCollection.countDocuments({
      createdAt: { $gte: today }
    });
    
    const awaitingBranch = await patientsCollection.countDocuments({
      currentStage: STAGES.AWAITING_BRANCH
    });
    
    const byBranch = await missCallsCollection.aggregate([
      { $group: { _id: '$branch', count: { $sum: 1 } } }
    ]).toArray();
    
    const branchStats = {};
    byBranch.forEach(b => { branchStats[b._id] = b.count; });
    
    res.json({
      total,
      today: today_count,
      byBranch: branchStats,
      awaitingBranch
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ TEST ENDPOINTS
// ============================================
app.get('/test-exec', async (req, res) => {
  try {
    const { exec } = req.query;
    const executiveNumber = exec || '917880261858';
    const chatId = `test-${Date.now()}`;
    
    await sendLeadNotification(
      executiveNumber, 
      'Test Patient', 
      executiveNumber, 
      'Test Branch', 
      'MRI Brain, CT Scan', 
      'Test', 
      chatId
    );
    
    res.json({
      success: true,
      message: `Template sent to ${executiveNumber}`,
      chatId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ DIRECT EXECUTIVE TEMPLATE TEST
// ============================================
app.get('/test-executive-direct', async (req, res) => {
  try {
    const execNumber = req.query.exec || '919106959092';
    const patientPhone = req.query.patient || '9876543210';
    
    console.log(`🧪 Direct test called with exec=${execNumber}, patient=${patientPhone}`);
    
    const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${execNumber}`;
    const payload = {
      template_name: "lead_notification_v2",
      broadcast_name: `lead_${Date.now()}`,
      parameters: [
        { name: "1", value: "Test Patient" },
        { name: "2", value: patientPhone },
        { name: "3", value: "Naroda" },
        { name: "4", value: "MRI Brain, Blood Test" },
        { name: "5", value: "Test" },
        { name: "6", value: "https://example.com" }
      ]
    };
    
    console.log(`📤 Sending to WATI:`, JSON.stringify(payload));
    
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': WATI_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log(`✅ WATI response:`, response.data);
    res.json({ 
      success: true, 
      message: `Template sent to ${execNumber}`,
      response: response.data 
    });
    
  } catch (error) {
    console.error(`❌ Direct test failed:`, error.message);
    if (error.response) {
      console.error(`WATI error response:`, error.response.data);
    }
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.response?.data || 'No response from WATI'
    });
  }
});

app.get('/test-misscall', async (req, res) => {
  const testPhone = req.query.phone || '9876543210';
  const testBranch = req.query.branch || 'Naroda';
  
  const whatsappNumber = normalizeWhatsAppNumber(testPhone);
  const branch = BRANCHES[normalizeIndianNumber(process.env.NARODA_NUMBER)] || {
    name: testBranch,
    executive: process.env.DEFAULT_EXECUTIVE
  };
  
  console.log('🧪 Test miss call:', { whatsappNumber, branch });
  
  try {
    const chatId = `${whatsappNumber}_${branch.name}`;
    const result = await patientsCollection.insertOne({
      chatId,
      patientName: 'Test Patient',
      patientPhone: whatsappNumber,
      branch: branch.name,
      testNames: 'Test Miss Call',
      sourceType: 'Test',
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
    
    await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [
      { name: '1', value: branch.name }
    ]);
    
    res.json({ 
      success: true, 
      message: 'Test miss call processed',
      whatsappNumber,
      branch: branch.name,
      executive: branch.executive,
      patientId: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ DEBUG PATIENT ENDPOINT
// ============================================
app.get('/debug-patient/:phone', async (req, res) => {
  const phone = req.params.phone;
  const normalizedPhone = normalizeWhatsAppNumber(phone);
  const patient = await patientsCollection.findOne({ 
    patientPhone: normalizedPhone 
  });
  res.json(patient || { error: 'Not found', searchedPhone: normalizedPhone });
});

app.get('/health', async (req, res) => {
  if (!patientsCollection || !processedCollection) {
    return res.status(503).json({
      success: false,
      error: 'Database not initialized',
      patientsCollection: !!patientsCollection,
      processedCollection: !!processedCollection
    });
  }
  
  try {
    const patientCount = await patientsCollection.countDocuments();
    const processedCount = await processedCollection.countDocuments();
    const missCallCount = missCallsCollection ? await missCallsCollection.countDocuments() : 0;
    const awaitingBranchCount = await patientsCollection.countDocuments({ currentStage: STAGES.AWAITING_BRANCH });
    
    const stageStats = {};
    for (const stage of Object.values(STAGES)) {
      stageStats[stage] = await patientsCollection.countDocuments({ currentStage: stage });
    }
    
    res.json({
      success: true,
      patients: patientCount,
      processed: processedCount,
      missCalls: missCallCount,
      awaitingBranch: awaitingBranchCount,
      stageStats,
      uptime: process.uptime(),
      mongodb: 'connected'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Production Executive System</title>
      <style>
        body { font-family: Arial; padding: 30px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
        h1 { color: #333; }
        .endpoint { background: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #007bff; }
        .btn { display: inline-block; background: #28a745; color: white; padding: 8px 15px; text-decoration: none; border-radius: 4px; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 Production Executive System</h1>
        <p>✅ Tata Tele Webhooks + WATI + MongoDB + Stage Tracking</p>
        
        <div class="endpoint">
          <div><span class="code">POST</span> /tata-misscall-whatsapp</div>
          <small>Main Tata Tele webhook</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/test-misscall?phone=9876543210">/test-misscall?phone=9876543210</a></div>
          <small>Test miss call flow</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/test-exec?exec=917880261858">/test-exec?exec=917880261858</a></div>
          <small>Send test template to executive</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/test-executive-direct?exec=919106959092">/test-executive-direct?exec=919106959092</a></div>
          <small>Direct executive template test</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/debug-patient/919106959092">/debug-patient/919106959092</a></div>
          <small>Check patient status</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/api/stage-stats">/api/stage-stats</a></div>
          <small>Stage wise statistics</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/api/misscall-stats">/api/misscall-stats</a></div>
          <small>Miss call statistics</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/health">/health</a></div>
          <small>Health check</small>
        </div>
        
        <div class="endpoint">
          <div><span class="code">GET</span> <a href="/admin">/admin</a></div>
          <small>Admin Dashboard</small>
        </div>
      </div>
    </body>
    </html>
  `);
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
          <h2>⏳ Dashboard Initializing</h2>
          <p>Database connection is being established. Please refresh in a few seconds.</p>
          <p>Collections: patients=${!!patientsCollection}, processed=${!!processedCollection}</p>
          <button onclick="location.reload()">Refresh Page</button>
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

// ============================================
// ✅ START SERVER - FIXED WITH HOST 0.0.0.0
// ============================================
async function startServer() {
  try {
    console.log('🔄 Starting server...');
    
    await connectDB();
    
    if (!patientsCollection || !processedCollection) {
      throw new Error('Collections not initialized properly after connectDB()');
    }
    
    console.log('✅ All collections verified, starting server...');

    // ⭐️ FIX: होस्ट '0.0.0.0' को स्पष्ट रूप में जोड़ें
    const HOST = '0.0.0.0';
    console.log(`🟡 Attempting to start server on host: ${HOST}, port: ${PORT}`);

    const server = app.listen(PORT, HOST, () => {
      console.log('='.repeat(60));
      console.log(`✅ SUCCESS: Server is listening on port ${PORT}`);
      console.log(`🚀 PRODUCTION SERVER running on port ${PORT}`);
      console.log(`📍 Host: ${HOST}`);
      console.log(`📍 Tata Tele Webhook: /tata-misscall-whatsapp`);
      console.log(`📍 WATI Webhook: /wati-webhook`);
      console.log(`📍 Test Endpoint: /test-misscall`);
      console.log(`📍 Direct Test: /test-executive-direct`);
      console.log(`📍 Debug Patient: /debug-patient/:phone`);
      console.log(`📍 Stage Tracking: ${Object.keys(STAGES).length} stages`);
      console.log(`📍 Cron: Fallback (5 min)`);
      console.log(`📍 MongoDB: Connected ✅`);
      console.log(`📍 Security: HMAC + API Key + WATI Auth`);
      console.log(`📍 Templates: misscall_welcome_v3, lead_notification_v2`);
      console.log('='.repeat(60));
    });

    server.on('error', (err) => {
      console.error(`❌ FAILED: Server could not start. Error:`, err.message);
      process.exit(1);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
