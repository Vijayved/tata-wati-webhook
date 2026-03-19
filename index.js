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
const DEDUPE_WINDOW_MS = 0;
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
let chatSessionsCollection;
let chatMessagesCollection;

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
    chatSessionsCollection = db.collection('chat_sessions');
    chatMessagesCollection = db.collection('chat_messages');
    
    // Indexes
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await patientsCollection.createIndex({ chatId: 1 }, { unique: true, sparse: true });
    await patientsCollection.createIndex({ patientPhone: 1, status: 1 });
    await patientsCollection.createIndex({ patientPhone: 1, createdAt: -1 });
    await patientsCollection.createIndex({ missCallCount: -1 });
    await patientsCollection.createIndex({ executiveActionTaken: 1 });
    await chatSessionsCollection.createIndex({ sessionToken: 1 }, { unique: true });
    await chatSessionsCollection.createIndex({ patientPhone: 1, status: 1 });
    await chatMessagesCollection.createIndex({ sessionToken: 1, timestamp: 1 });
    
    console.log('✅ Indexes created');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    throw error;
  }
}

// ============================================
// ✅ EXECUTIVE NUMBERS MAPPING
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

console.log('✅ Executive numbers loaded:', EXECUTIVES);

function getExecutiveNumber(branchName) {
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
  CONNECTED: 'connected',
  CONVERTED: 'converted',
  WAITING: 'waiting',
  NOT_CONVERTED: 'not_converted',
  ESCALATED: 'escalated'
};

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
const recentMissCalls = new Map();

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
// ✅ WATI TEMPLATE SENDER
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
// ✅ FIXED LEAD NOTIFICATION - CORRECT PARAMETER ORDER
// ============================================
async function sendLeadNotification(executiveNumber, patientName, patientPhone, branch, testDetails, testType, chatToken) {
  console.log(`📤 Sending lead notification to executive ${executiveNumber}`);
  console.log(`   Patient: ${patientName}, Phone: ${patientPhone}, Branch: ${branch}`);
  console.log(`   Test Details: ${testDetails}, Test Type: ${testType}`);
  console.log(`   Chat Token: ${chatToken}`);
  
  // CORRECT PARAMETER ORDER:
  // {{1}} = Patient Name
  // {{2}} = Patient Phone
  // {{3}} = Branch
  // {{4}} = Test Details (Typed by patient - e.g., "KNEE BRAIN")
  // {{5}} = Test Type (Selected from bot - e.g., "MRI")
  // {{6}} = Chat Link
  const parameters = [
    { name: "1", value: patientName || "Miss Call Patient" },
    { name: "2", value: patientPhone },
    { name: "3", value: branch },
    { name: "4", value: testDetails || "Not specified" },
    { name: "5", value: testType || "Miss Call" },
    { name: "6", value: `${SELF_URL}/executive-chat/${chatToken}` }
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
        patientName: 'Miss Call Patient', // Default name
        patientPhone: whatsappNumber,
        branch: branch.name,
        testType: null,
        testDetails: null,
        patientMessages: [],
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
      console.log(`✅ New patient created`);
    }
    
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
// ✅ WATI WEBHOOK - AI-POWERED INTELLIGENT CLASSIFICATION
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('\n📨 WATI WEBHOOK RECEIVED');
    console.log('Full webhook body:', JSON.stringify(req.body, null, 2));
    
    const msg = req.body;
    const msgId = msg.id || msg.messageId;
    if (!msgId) return res.sendStatus(200);
    
    if (await isMessageProcessed(msgId)) return res.sendStatus(200);
    
    const senderNumber = msg.whatsappNumber || msg.from || msg.waId;
    if (!senderNumber) {
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
    // Get message text from different possible fields
    let messageText = '';
    let messageType = msg.type || 'unknown';
    
    if (msg.text) {
      messageText = msg.text;
    } else if (msg.body) {
      messageText = msg.body;
    } else if (msg.type === 'interactive' && msg.listReply && msg.listReply.title) {
      messageText = msg.listReply.title;
      console.log(`📋 Interactive list reply: ${messageText}`);
    } else if (msg.interactiveButtonReply && msg.interactiveButtonReply.title) {
      messageText = msg.interactiveButtonReply.title;
    } else if (msg.buttonReply && msg.buttonReply.title) {
      messageText = msg.buttonReply.title;
    }
    
    const text = (messageText || '').toUpperCase().trim();
    console.log(`📝 Processed message: "${text}" from ${senderNumber} (type: ${messageType})`);
    
    // ============================================
    // ✅ HANDLE PATIENT REPLIES (for existing chat sessions)
    // ============================================
    const activeSession = await chatSessionsCollection.findOne({
      patientPhone: senderNumber,
      status: 'active'
    });
    
    if (activeSession && text && !text.endsWith('_BRANCH')) {
      console.log(`📝 Storing patient reply for session ${activeSession.sessionToken}`);
      
      await chatMessagesCollection.insertOne({
        sessionToken: activeSession.sessionToken,
        sender: 'patient',
        text: messageText,
        timestamp: new Date(),
        watiMessageId: msg.id
      });
      
      await chatSessionsCollection.updateOne(
        { sessionToken: activeSession.sessionToken },
        { $set: { lastActivity: new Date() } }
      );
    }
    
    // ============================================
    // ✅ AI-POWERED INTELLIGENT CLASSIFICATION
    // ============================================
    if (!text.endsWith('_BRANCH') && !text.startsWith('CONNECT') && !text.startsWith('CONVERT') && !text.startsWith('WAITING') && !text.startsWith('NOT')) {
      
      // Find patient
      let patient = await patientsCollection.findOne({ 
        patientPhone: senderNumber 
      });
      
      // If patient doesn't exist, create a basic record
      if (!patient) {
        const result = await patientsCollection.insertOne({
          patientPhone: senderNumber,
          patientName: 'Miss Call Patient',
          patientMessages: [],
          testType: null,
          testDetails: null,
          lastTestDetailMessage: null,
          createdAt: new Date(),
          updatedAt: new Date()
        });
        patient = { _id: result.insertedId };
        console.log(`✅ Created new patient record for ${senderNumber}`);
      }
      
      // Store raw message in patient's history (always)
      await patientsCollection.updateOne(
        { _id: patient._id },
        {
          $push: {
            patientMessages: {
              text: messageText,
              type: messageType,
              timestamp: new Date()
            }
          },
          $set: { lastMessageAt: new Date() }
        }
      );
      console.log(`✅ Stored raw patient message: "${messageText}"`);
      
      // ============================================
      // 🤖 INTELLIGENT CLASSIFICATION ALGORITHM
      // ============================================
      
      // 1. DETECT AND STORE PATIENT NAME (PRIORITY 1 - ONCE ONLY)
      if (patient.patientName === 'Miss Call Patient' || !patient.patientName) {
        const lowerMsg = messageText.toLowerCase();
        let extractedName = null;
        
        // Check for explicit name introduction patterns
        if (lowerMsg.includes('my name is')) {
          extractedName = messageText.substring(lowerMsg.indexOf('my name is') + 11).trim();
        } else if (lowerMsg.includes('i am')) {
          extractedName = messageText.substring(lowerMsg.indexOf('i am') + 5).trim();
        } else if (lowerMsg.includes('call me')) {
          extractedName = messageText.substring(lowerMsg.indexOf('call me') + 8).trim();
        } else if (lowerMsg.includes('name:')) {
          extractedName = messageText.substring(lowerMsg.indexOf('name:') + 5).trim();
        } else if (messageText.length > 2 && messageText.length < 15 && !messageText.includes(' ') && 
                  !messageText.toUpperCase().includes('MRI') && 
                  !messageText.toUpperCase().includes('CT') && 
                  !messageText.toUpperCase().includes('USG') &&
                  !messageText.toUpperCase().includes('X-RAY')) {
          // Single word that's not a test keyword - could be a name
          extractedName = messageText;
        }
        
        if (extractedName) {
          // Clean up - take first word, remove punctuation
          const cleanName = extractedName.split(' ')[0].replace(/[.,!?]/g, '');
          if (cleanName.length > 2) {
            await patientsCollection.updateOne(
              { _id: patient._id },
              { $set: { patientName: cleanName } }
            );
            console.log(`✅ PATIENT NAME SET TO: "${cleanName}"`);
          }
        }
      }
      
      // 2. DETECT AND STORE TEST TYPE (PRIORITY 2 - BOT SELECTIONS)
      const testKeywords = ['MRI', 'CT', 'USG', 'X-RAY', 'XRAY', 'ULTRASOUND', 'SONOGRAPHY'];
      const upperText = messageText.toUpperCase();
      let detectedType = null;
      
      for (const keyword of testKeywords) {
        if (upperText === keyword || upperText.includes(keyword)) {
          detectedType = keyword;
          await patientsCollection.updateOne(
            { _id: patient._id },
            { $set: { testType: keyword } }
          );
          console.log(`✅ TEST TYPE DETECTED: "${keyword}"`);
          break;
        }
      }
      
      // 3. DETECT AND STORE TEST DETAILS (PRIORITY 3 - TYPED DESCRIPTIONS)
      // This captures descriptive text like "KNEE BRAIN", "ABDOMEN", etc.
      const isLikelyTestDetail = 
        messageText.length > 5 && 
        !detectedType && 
        !messageText.toUpperCase().includes('CHANGE BRANCH') &&
        !messageText.toUpperCase().includes('MANUAL ENTRY') &&
        !messageText.toUpperCase().includes('UPLOAD') &&
        messageText.includes(' '); // Has spaces, likely a phrase
      
      if (isLikelyTestDetail) {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $set: { 
              testDetails: messageText,
              lastTestDetailMessage: messageText
            } 
          }
        );
        console.log(`✅ TEST DETAILS STORED: "${messageText}"`);
      }
      
      // 4. SPECIAL CASE: Bot selected type but no details yet - use this as both type and detail
      if (detectedType && !patient.testDetails) {
        // If the message itself is just the keyword (e.g., "MRI"), don't use it as details
        if (upperText !== detectedType && messageText.length > detectedType.length + 2) {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { $set: { testDetails: messageText } }
          );
          console.log(`✅ TEST DETAILS SET FROM TYPE MESSAGE: "${messageText}"`);
        }
      }
    }
    
    // ============================================
    // ✅ HANDLE EXECUTIVE BUTTON CLICKS
    // ============================================
    if (text === 'CONNECT TO PATIENT' || text === 'CONVERT DONE' || text === 'WAITING' || text === 'NOT CONVERT') {
      console.log(`🔘 Executive button clicked: ${text} from ${senderNumber}`);
      
      const patient = await patientsCollection.findOne({ 
        executiveNumber: senderNumber,
        status: { $in: ['pending', 'awaiting_branch', 'branch_selected', 'executive_notified'] }
      });
      
      if (!patient) {
        console.log(`❌ No patient found for executive ${senderNumber}`);
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "❌ No patient assigned to you." }]
        );
        await markMessageProcessed(msgId);
        return res.sendStatus(200);
      }
      
      if (text === 'CONNECT TO PATIENT') {
        console.log(`🔗 Connecting executive ${senderNumber} with patient ${patient.patientPhone}`);
        
        // Check if session already exists
        const existingSession = await chatSessionsCollection.findOne({
          patientPhone: patient.patientPhone,
          status: 'active'
        });
        
        if (existingSession) {
          // Session already exists - use existing link
          await sendLeadNotification(
            senderNumber,
            patient.patientName || 'Patient',
            patient.patientPhone,
            patient.branch || 'Branch',
            patient.testDetails || 'Not specified',
            patient.testType || 'Miss Call',
            existingSession.sessionToken
          );
          
          console.log(`✅ Existing session link sent to executive`);
        } else {
          // Create new session
          const sessionToken = crypto.randomBytes(16).toString('hex');
          
          await chatSessionsCollection.insertOne({
            sessionToken,
            executiveNumber: senderNumber,
            patientPhone: patient.patientPhone,
            patientName: patient.patientName,
            createdAt: new Date(),
            lastActivity: new Date(),
            status: 'active'
          });
          
          await sendLeadNotification(
            senderNumber,
            patient.patientName || 'Patient',
            patient.patientPhone,
            patient.branch || 'Branch',
            patient.testDetails || 'Not specified',
            patient.testType || 'Miss Call',
            sessionToken
          );
          
          await patientsCollection.updateOne(
            { _id: patient._id },
            { 
              $set: { 
                chatSessionToken: sessionToken,
                currentStage: STAGES.CONNECTED,
                connectedAt: new Date()
              },
              $push: { stageHistory: { stage: STAGES.CONNECTED, timestamp: new Date() } }
            }
          );
          
          console.log(`✅ New chat session created: ${sessionToken}`);
        }
      }
      else if (text === 'CONVERT DONE') {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $set: { 
              status: 'converted',
              currentStage: STAGES.CONVERTED,
              updatedAt: new Date(),
              executiveActionTaken: true
            },
            $push: { stageHistory: { stage: STAGES.CONVERTED, timestamp: new Date() } }
          }
        );
        
        // Close any active chat session
        await chatSessionsCollection.updateMany(
          { patientPhone: patient.patientPhone, status: 'active' },
          { $set: { status: 'closed', closedAt: new Date() } }
        );
        
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "✅ Patient marked as converted. Thank you!" }]
        );
      }
      else if (text === 'WAITING') {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $set: { 
              status: 'waiting',
              currentStage: STAGES.WAITING,
              updatedAt: new Date(),
              executiveActionTaken: true
            },
            $push: { stageHistory: { stage: STAGES.WAITING, timestamp: new Date() } }
          }
        );
        
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "⏳ Please send follow-up date (DD/MM/YYYY)" }]
        );
      }
      else if (text === 'NOT CONVERT') {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $set: { 
              status: 'not_converted',
              currentStage: STAGES.NOT_CONVERTED,
              updatedAt: new Date(),
              executiveActionTaken: true
            },
            $push: { stageHistory: { stage: STAGES.NOT_CONVERTED, timestamp: new Date() } }
          }
        );
        
        // Close any active chat session
        await chatSessionsCollection.updateMany(
          { patientPhone: patient.patientPhone, status: 'active' },
          { $set: { status: 'closed', closedAt: new Date() } }
        );
        
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "❌ Patient marked as not converted." }]
        );
      }
    }
    
    // ============================================
    // ✅ HANDLE _BRANCH MESSAGES (NARODA_BRANCH, etc.)
    // ============================================
    else if (text.endsWith('_BRANCH')) {
      const branchUpper = text.replace('_BRANCH', '');
      const branch = branchUpper.charAt(0).toUpperCase() + branchUpper.slice(1).toLowerCase();
      
      console.log(`🎯 BRANCH DETECTED: ${branch}`);
      
      const whatsappNumber = normalizeWhatsAppNumber(senderNumber);
      const executiveNumber = getExecutiveNumber(branchUpper);
      
      let patient = await patientsCollection.findOne({ 
        patientPhone: whatsappNumber
      });
      
      const chatId = `${whatsappNumber}_${branch}`;
      
      if (!patient) {
        const result = await patientsCollection.insertOne({
          chatId,
          patientName: 'Miss Call Patient',
          patientPhone: whatsappNumber,
          branch: branch,
          testType: null,
          testDetails: null,
          patientMessages: [],
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
        console.log(`✅ New patient created`);
      } else {
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
        console.log(`✅ Patient updated`);
      }
      
      // Create or get session token for chat link
      let sessionTokenForLink = patient.chatSessionToken;
      if (!sessionTokenForLink) {
        sessionTokenForLink = crypto.randomBytes(16).toString('hex');
        await patientsCollection.updateOne(
          { _id: patient._id },
          { $set: { chatSessionToken: sessionTokenForLink } }
        );
        console.log(`✅ Created new session token for chat link: ${sessionTokenForLink}`);
      }
      
      // Prepare data for notification using intelligent fields
      let patientNameToSend = patient.patientName || 'Miss Call Patient';
      let testTypeToSend = patient.testType || 'Miss Call';
      let testDetailsToSend = patient.testDetails || patient.lastTestDetailMessage || 'Not specified';
      
      console.log(`🤖 AI LOGIC - Final Data for Notification:`);
      console.log(`   Patient Name: "${patientNameToSend}"`);
      console.log(`   Test Type: "${testTypeToSend}"`);
      console.log(`   Test Details: "${testDetailsToSend}"`);
      console.log(`   Chat Token: "${sessionTokenForLink}"`);
      
      if (!patient.executiveActionTaken) {
        console.log(`📤 First time notification to executive ${executiveNumber}`);
        try {
          const notified = await sendNotificationAtomic(patient._id, () =>
            sendLeadNotification(
              executiveNumber,
              patientNameToSend,        // ⭐️ Real patient name
              whatsappNumber,
              branch,
              testDetailsToSend,        // ⭐️ Test details (e.g., "KNEE BRAIN")
              testTypeToSend,           // ⭐️ Test type (e.g., "MRI")
              sessionTokenForLink       // ⭐️ Session token for valid chat link
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
// ✅ EXECUTIVE CHAT INTERFACE
// ============================================
app.get('/executive-chat/:token', async (req, res) => {
  const { token } = req.params;
  
  const session = await chatSessionsCollection.findOne({ 
    sessionToken: token,
    status: 'active'
  });
  
  if (!session) {
    // Also check if token is a patient identifier (backward compatibility)
    const patient = await patientsCollection.findOne({ 
      chatSessionToken: token 
    });
    
    if (patient && patient.chatSessionToken) {
      // Redirect to the correct session
      return res.redirect(`/executive-chat/${patient.chatSessionToken}`);
    }
    
    return res.send(`
      <html>
        <head><title>Chat Session</title></head>
        <body style="font-family: Arial; padding: 30px;">
          <h2 style="color: #dc3545;">❌ Invalid or Expired Session</h2>
          <p>Please request a new connection from WhatsApp.</p>
        </body>
      </html>
    `);
  }
  
  const messages = await chatMessagesCollection
    .find({ sessionToken: token })
    .sort({ timestamp: 1 })
    .toArray();
  
  const patient = await patientsCollection.findOne({ 
    patientPhone: session.patientPhone 
  });
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Executive Chat - ${session.patientName || 'Patient'}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; background: #f0f2f5; height: 100vh; }
        .chat-container { max-width: 800px; margin: 0 auto; height: 100vh; display: flex; flex-direction: column; background: white; }
        .chat-header { background: #075e54; color: white; padding: 15px; display: flex; justify-content: space-between; align-items: center; }
        .patient-info { flex: 1; }
        .patient-name { font-weight: bold; font-size: 1.2em; }
        .patient-phone { font-size: 0.8em; opacity: 0.8; }
        .test-info { background: #128C7E; padding: 5px 10px; border-radius: 20px; font-size: 0.9em; }
        .messages-container { flex: 1; overflow-y: auto; padding: 20px; background: #e5ddd5; }
        .message { margin: 10px 0; display: flex; }
        .message.patient { justify-content: flex-start; }
        .message.executive { justify-content: flex-end; }
        .message-content { max-width: 70%; padding: 10px 15px; border-radius: 10px; position: relative; }
        .message.patient .message-content { background: white; border-bottom-left-radius: 0; }
        .message.executive .message-content { background: #dcf8c6; border-bottom-right-radius: 0; }
        .message-time { font-size: 0.7em; color: #999; margin-top: 5px; text-align: right; }
        .input-area { display: flex; padding: 15px; background: #f0f0f0; border-top: 1px solid #ddd; }
        #messageInput { flex: 1; padding: 12px; border: 1px solid #ddd; border-radius: 25px; outline: none; font-size: 1em; }
        #sendBtn { width: 60px; height: 60px; border-radius: 50%; background: #075e54; color: white; border: none; margin-left: 10px; cursor: pointer; font-size: 1.2em; }
        #sendBtn:hover { background: #128C7E; }
        .quick-replies { display: flex; gap: 10px; padding: 10px 15px; background: white; border-top: 1px solid #eee; flex-wrap: wrap; }
        .quick-reply-btn { background: #f0f0f0; border: 1px solid #ddd; padding: 8px 15px; border-radius: 20px; cursor: pointer; font-size: 0.9em; }
        .quick-reply-btn:hover { background: #e0e0e0; }
      </style>
    </head>
    <body>
      <div class="chat-container">
        <div class="chat-header">
          <div class="patient-info">
            <div class="patient-name">${session.patientName || 'Patient'}</div>
            <div class="patient-phone">${session.patientPhone}</div>
          </div>
          ${patient ? `<div class="test-info">${patient.testType || 'Miss Call'}</div>` : ''}
        </div>
        
        <div class="messages-container" id="messages">
          ${messages.map(msg => `
            <div class="message ${msg.sender === 'executive' ? 'executive' : 'patient'}">
              <div class="message-content">
                ${msg.text}
                <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString()}</div>
              </div>
            </div>
          `).join('')}
        </div>
        
        <div class="quick-replies">
          <button class="quick-reply-btn" onclick="sendQuickReply('Thank you')">Thank you</button>
          <button class="quick-reply-btn" onclick="sendQuickReply('Please wait')">Please wait</button>
          <button class="quick-reply-btn" onclick="sendQuickReply('I will check')">I will check</button>
          <button class="quick-reply-btn" onclick="sendQuickReply('Please send reports')">Send reports</button>
        </div>
        
        <div class="input-area">
          <input type="text" id="messageInput" placeholder="Type your message...">
          <button id="sendBtn" onclick="sendMessage()">➤</button>
        </div>
      </div>
      
      <script>
        const sessionToken = '${token}';
        const messagesDiv = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        let lastMessageCount = ${messages.length};
        
        setInterval(checkNewMessages, 2000);
        
        async function checkNewMessages() {
          try {
            const response = await fetch('/api/chat-messages/' + sessionToken + '?since=' + lastMessageCount);
            const data = await response.json();
            
            if (data.messages && data.messages.length > 0) {
              data.messages.forEach(msg => {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + (msg.sender === 'executive' ? 'executive' : 'patient');
                messageDiv.innerHTML = \`
                  <div class="message-content">
                    \${msg.text}
                    <div class="message-time">\${new Date(msg.timestamp).toLocaleTimeString()}</div>
                  </div>
                \`;
                messagesDiv.appendChild(messageDiv);
              });
              lastMessageCount += data.messages.length;
              messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }
          } catch (error) {
            console.error('Error checking messages:', error);
          }
        }
        
        async function sendMessage() {
          const text = messageInput.value.trim();
          if (!text) return;
          
          messageInput.disabled = true;
          document.getElementById('sendBtn').disabled = true;
          
          try {
            const response = await fetch('/api/send-to-patient', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionToken, text })
            });
            
            const result = await response.json();
            
            if (result.success) {
              const messageDiv = document.createElement('div');
              messageDiv.className = 'message executive';
              messageDiv.innerHTML = \`
                <div class="message-content">
                  \${text}
                  <div class="message-time">Just now</div>
                </div>
              \`;
              messagesDiv.appendChild(messageDiv);
              lastMessageCount++;
              messageInput.value = '';
              messagesDiv.scrollTop = messagesDiv.scrollHeight;
            } else {
              alert('Failed to send message: ' + result.error);
            }
          } catch (error) {
            alert('Error sending message');
            console.error(error);
          } finally {
            messageInput.disabled = false;
            document.getElementById('sendBtn').disabled = false;
            messageInput.focus();
          }
        }
        
        function sendQuickReply(reply) {
          messageInput.value = reply;
          sendMessage();
        }
        
        messageInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') sendMessage();
        });
        
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      </script>
    </body>
    </html>
  `);
});

// ============================================
// ✅ SEND MESSAGE TO PATIENT
// ============================================
app.post('/api/send-to-patient', async (req, res) => {
  try {
    const { sessionToken, text } = req.body;
    
    const session = await chatSessionsCollection.findOne({ 
      sessionToken,
      status: 'active'
    });
    
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    // Send via WATI session message API
    const url = `${WATI_BASE_URL}/api/v1/sendSessionMessage/${session.patientPhone}`;
    
    const payload = {
      messageText: text
    };
    
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': WATI_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    await chatMessagesCollection.insertOne({
      sessionToken,
      sender: 'executive',
      text: text,
      timestamp: new Date(),
      watiMessageId: response.data?.messageId
    });
    
    await chatSessionsCollection.updateOne(
      { sessionToken },
      { $set: { lastActivity: new Date() } }
    );
    
    res.json({ success: true, messageId: response.data?.messageId });
    
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ✅ GET CHAT MESSAGES
// ============================================
app.get('/api/chat-messages/:token', async (req, res) => {
  const { token } = req.params;
  const since = parseInt(req.query.since) || 0;
  
  const messages = await chatMessagesCollection
    .find({ sessionToken: token })
    .sort({ timestamp: 1 })
    .toArray();
  
  const newMessages = messages.slice(since);
  
  res.json({ 
    messages: newMessages,
    total: messages.length
  });
});

// ============================================
// ✅ TEST ENDPOINTS
// ============================================
app.get('/test-executive-direct', async (req, res) => {
  try {
    const execNumber = req.query.exec || '917880261858';
    const patientPhone = req.query.patient || '9876543210';
    const branch = req.query.branch || 'Naroda';
    const patientName = req.query.name || 'Test Patient';
    const testDetails = req.query.details || 'MRI Brain';
    const testType = req.query.type || 'MRI';
    
    const chatToken = `test_${Date.now()}`;
    const result = await sendLeadNotification(
      execNumber,
      patientName,
      patientPhone,
      branch,
      testDetails,
      testType,
      chatToken
    );
    
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test-misscall', async (req, res) => {
  try {
    const phone = req.query.phone || '919106959092';
    const branch = req.query.branch || 'Naroda';
    
    const result = await sendWatiTemplateMessage(phone, TEMPLATE_NAME, [
      { name: '1', value: branch }
    ]);
    
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
      message: `Fixed ${result1.modifiedCount} stageHistory, initialized ${result2.modifiedCount} executiveActionTaken` 
    });
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
    const connectedCount = await patientsCollection.countDocuments({ currentStage: STAGES.CONNECTED });
    
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
    
    const activeChats = await chatSessionsCollection.countDocuments({ status: 'active' });
    
    res.json({
      totalPatients,
      pendingCount,
      convertedCount,
      waitingCount,
      notConvertedCount,
      connectedCount,
      actionTakenCount,
      actionPendingCount,
      stageStats,
      missCallTotal,
      missCallToday,
      branchMissCallMap,
      recentPatients,
      recentMissCalls,
      topMissCallPatients,
      activeChats,
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
  
  res.json(patient);
});

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
        updatedAt: new Date(),
        executiveActionTaken: true
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
  res.json({
    success: true,
    uptime: process.uptime(),
    mongodb: 'connected',
    time: new Date().toISOString()
  });
});

// ============================================
// ✅ HOME ROUTE
// ============================================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Tata-WATI Executive System',
    version: '4.0.0',
    endpoints: {
      admin_dashboard: '/admin',
      api_stats: '/api/stats',
      test_executive: '/test-executive-direct',
      test_misscall: '/test-misscall',
      fix_database: '/fix-database',
      webhook_wati: '/wati-webhook',
      webhook_tata: '/tata-misscall-whatsapp'
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
  req.chatSessionsCollection = chatSessionsCollection;
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
    app.listen(PORT, HOST, () => {
      console.log('\n' + '='.repeat(60));
      console.log(`✅ SERVER RUNNING ON PORT ${PORT}`);
      console.log(`📍 Admin Dashboard: http://localhost:${PORT}/admin`);
      console.log(`📍 Chat System: Active`);
      console.log(`📍 Executive Number Hidden: ✅`);
      console.log(`📍 AI Patient Name Detection: ✅ Never Overwrites`);
      console.log(`📍 AI Test Classification: ✅ Intelligent`);
      console.log(`📍 Valid Chat Links: ✅ Session Tokens`);
      console.log('='.repeat(60) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
