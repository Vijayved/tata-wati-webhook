require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const OpenAI = require('openai');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');

// ============================================
// ✅ TIMEZONE SETUP - IST (Indian Standard Time)
// ============================================
process.env.TZ = 'Asia/Kolkata';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// ✅ IST TIME HELPER FUNCTIONS
// ============================================
function getISTTime(date = new Date()) {
  return date.toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getISTDateTime(date = new Date()) {
  return date.toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

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
const DEDUPE_WINDOW_MS = 5000;
const TEMPLATE_NAME = process.env.MISSCALL_TEMPLATE_NAME || 'misscall_welcome_v3';
const LEAD_TEMPLATE_NAME = 'lead_notification_v6';

// ✅ Follow-up Template Names
const FOLLOWUP_NO_REPLY_TEMPLATE = 'followup_no_reply';
const FOLLOWUP_WAITING_TEMPLATE = 'following_waiting';
const ESCALATION_MANAGER_TEMPLATE = 'escalation_manager';
const EXECUTIVE_REPORT_TEMPLATE = 'executive_report';

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
let followupCollection;

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
    followupCollection = db.collection('followups');
    
    // Indexes
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await patientsCollection.createIndex({ chatId: 1 }, { unique: true, sparse: true });
    await patientsCollection.createIndex({ patientPhone: 1, status: 1 });
    await patientsCollection.createIndex({ patientPhone: 1, createdAt: -1 });
    await patientsCollection.createIndex({ missCallCount: -1 });
    await patientsCollection.createIndex({ executiveActionTaken: 1 });
    await patientsCollection.createIndex({ currentStage: 1 });
    await chatSessionsCollection.createIndex({ sessionToken: 1 }, { unique: true });
    await chatSessionsCollection.createIndex({ patientPhone: 1, status: 1 });
    await chatMessagesCollection.createIndex({ sessionToken: 1, timestamp: 1 });
    await followupCollection.createIndex({ patientId: 1, type: 1, createdAt: -1 });
    await followupCollection.createIndex({ scheduledAt: 1, status: 1 });
    
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

console.log('✅ Executive numbers loaded');

function getExecutiveNumber(branchName) {
  const formattedBranch = branchName.charAt(0).toUpperCase() + branchName.slice(1).toLowerCase();
  const teamName = `${formattedBranch} Team`;
  const execNumber = EXECUTIVES[teamName] || process.env.DEFAULT_EXECUTIVE || '917880261858';
  return execNumber.toString().trim();
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

// ============================================
// ✅ BRANCH CONFIGURATION
// ============================================
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

// ============================================
// ✅ STAGE TRACKING CONSTANTS
// ============================================
const STAGES = {
  MISS_CALL_RECEIVED: 'miss_call_received',
  AWAITING_BRANCH: 'awaiting_branch',
  BRANCH_SELECTED: 'branch_selected',
  AWAITING_NAME: 'awaiting_name',
  AWAITING_TEST_TYPE: 'awaiting_test_type',
  AWAITING_TEST_DETAILS: 'awaiting_test_details',
  OCR_PROCESSING: 'ocr_processing',
  OCR_COMPLETED: 'ocr_completed',
  EXECUTIVE_NOTIFIED: 'executive_notified',
  CONNECTED: 'connected',
  CONVERTED: 'converted',
  WAITING: 'waiting',
  NOT_CONVERTED: 'not_converted',
  ESCALATED: 'escalated'
};

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
// ✅ SESSION FUNCTIONS (NO EXPIRY)
// ============================================

async function createChatSession(executiveNumber, patientPhone, patientName) {
  const sessionToken = crypto.randomBytes(16).toString('hex');
  
  await chatSessionsCollection.insertOne({
    sessionToken,
    executiveNumber: executiveNumber,
    patientPhone: patientPhone,
    patientName: patientName || 'Patient',
    createdAt: new Date(),
    lastActivity: new Date(),
    status: 'active',
    expiresAt: null
  });
  
  return sessionToken;
}

async function getOrCreateChatSession(patient) {
  let session = await chatSessionsCollection.findOne({ 
    patientPhone: patient.patientPhone,
    status: 'active'
  });
  
  if (!session) {
    console.log(`🔄 No active session found for ${patient.patientPhone}, creating new...`);
    const executiveNumber = getExecutiveNumber(patient.branch);
    const sessionToken = await createChatSession(executiveNumber, patient.patientPhone, patient.patientName);
    
    await patientsCollection.updateOne(
      { _id: patient._id },
      { $set: { chatSessionToken: sessionToken } }
    );
    
    session = await chatSessionsCollection.findOne({ sessionToken });
  }
  
  return session;
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
// ✅ SEND SESSION MESSAGE TO PATIENT
// ============================================
async function sendWhatsAppMessageToPatient(executiveNumber, patientPhone, message) {
  console.log(`📤 Sending message from executive to patient ${patientPhone}`);
  
  const url = `${WATI_BASE_URL}/api/v1/sendSessionMessage/${patientPhone}`;
  
  const payload = {
    messageText: message
  };
  
  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': WATI_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    
    console.log(`✅ Message sent successfully to patient`);
    return response.data;
  } catch (error) {
    console.error(`❌ Failed to send message:`, error.message);
    throw error;
  }
}

// ============================================
// ✅ FOLLOW-UP FUNCTIONS (WITH WHATSAPP DIRECT LINK)
// ============================================

// 1. No Reply Follow-up (every 20 min) - WITH WHATSAPP DIRECT LINK
async function sendNoReplyFollowup(patient) {
  console.log(`📢 Sending no-reply followup for ${patient.patientName}`);
  
  const executiveNumber = getExecutiveNumber(patient.branch);
  
  // ✅ Create WhatsApp direct link (not executive-chat link)
  const welcomeText = `Hi ${patient.patientName}, I am from UIC Support Team.

Your Details:
Name: ${patient.patientName}
Test: ${patient.testType} - ${patient.testDetails}
Branch: ${patient.branch}
Miss Call Time: ${patient.missCallTimeIST || getISTTime(new Date(patient.missCallTime))}

How can I help you?`;
  
  const whatsappLink = `https://wa.me/${patient.patientPhone}?text=${encodeURIComponent(welcomeText)}`;
  
  // ✅ IST Time Format
  const istMissCallTime = patient.missCallTimeIST || getISTTime(new Date(patient.missCallTime));
  const istLastMessageAt = patient.lastMessageAt ? getISTTime(new Date(patient.lastMessageAt)) : "No message";
  
  const parameters = [
    { name: "1", value: patient.patientName || "Patient" },
    { name: "2", value: patient.patientPhone },
    { name: "3", value: patient.branch || "Main Branch" },
    { name: "4", value: patient.testType || "Not specified" },
    { name: "5", value: patient.testDetails || "Not specified" },
    { name: "6", value: istMissCallTime },
    { name: "7", value: istLastMessageAt },
    { name: "8", value: whatsappLink }  // ✅ WhatsApp direct link
  ];
  
  await sendWatiTemplateMessage(executiveNumber, FOLLOWUP_NO_REPLY_TEMPLATE, parameters);
  
  await followupCollection.insertOne({
    patientId: patient._id,
    patientPhone: patient.patientPhone,
    executiveNumber: executiveNumber,
    type: 'no_reply',
    sentAt: new Date(),
    status: 'sent',
    reminderCount: (patient.noReplyFollowupCount || 0) + 1
  });
  
  await patientsCollection.updateOne(
    { _id: patient._id },
    { 
      $inc: { noReplyFollowupCount: 1 },
      $set: { lastNoReplyFollowupAt: new Date() }
    }
  );
}

// 2. Waiting Follow-up (every hour)
async function sendWaitingFollowup(patient, waitingCount) {
  console.log(`⏳ Sending waiting followup for ${patient.patientName} (count: ${waitingCount})`);
  
  const executiveNumber = getExecutiveNumber(patient.branch);
  
  const istUpdatedAt = patient.updatedAtIST || getISTTime(new Date(patient.updatedAt));
  
  const parameters = [
    { name: "1", value: patient.patientName || "Patient" },
    { name: "2", value: patient.patientPhone },
    { name: "3", value: patient.branch || "Main Branch" },
    { name: "4", value: patient.testType || "Not specified" },
    { name: "5", value: patient.testDetails || "Not specified" },
    { name: "6", value: istUpdatedAt }
  ];
  
  await sendWatiTemplateMessage(executiveNumber, FOLLOWUP_WAITING_TEMPLATE, parameters);
  
  await followupCollection.insertOne({
    patientId: patient._id,
    patientPhone: patient.patientPhone,
    executiveNumber: executiveNumber,
    type: 'waiting',
    waitingCount: waitingCount,
    sentAt: new Date(),
    status: 'sent'
  });
  
  await patientsCollection.updateOne(
    { _id: patient._id },
    { 
      $inc: { waitingFollowupCount: 1 },
      $set: { lastWaitingFollowupAt: new Date() }
    }
  );
  
  if (waitingCount >= 4) {
    await escalateToManager(patient, waitingCount);
  }
}

// 3. Escalate to Manager
async function escalateToManager(patient, waitingCount) {
  console.log(`🚨 Escalating ${patient.patientName} to manager (waiting: ${waitingCount} times)`);
  
  const managerNumber = EXECUTIVES['Manager'] || process.env.MANAGER_NUMBER || '917698011233';
  const executiveNumber = getExecutiveNumber(patient.branch);
  const executiveName = Object.keys(EXECUTIVES).find(key => EXECUTIVES[key] === executiveNumber) || 'Unknown Executive';
  const hoursWaiting = Math.floor((Date.now() - new Date(patient.updatedAt)) / (1000 * 60 * 60));
  
  const parameters = [
    { name: "1", value: patient.patientName || "Patient" },
    { name: "2", value: patient.patientPhone },
    { name: "3", value: patient.branch || "Main Branch" },
    { name: "4", value: patient.testType || "Not specified" },
    { name: "5", value: patient.testDetails || "Not specified" },
    { name: "6", value: waitingCount.toString() },
    { name: "7", value: hoursWaiting.toString() },
    { name: "8", value: executiveName },
    { name: "9", value: executiveNumber }
  ];
  
  await sendWatiTemplateMessage(managerNumber, ESCALATION_MANAGER_TEMPLATE, parameters);
  
  await followupCollection.insertOne({
    patientId: patient._id,
    patientPhone: patient.patientPhone,
    executiveNumber: executiveNumber,
    managerNumber: managerNumber,
    type: 'escalation',
    waitingCount: waitingCount,
    hoursWaiting: hoursWaiting,
    sentAt: new Date(),
    status: 'escalated'
  });
  
  await patientsCollection.updateOne(
    { _id: patient._id },
    { 
      $set: { 
        escalatedAt: new Date(), 
        escalatedCount: waitingCount, 
        escalatedToManager: true 
      } 
    }
  );
}

// 4. Two Hour Report
async function sendTwoHourReport(patient) {
  console.log(`📊 Sending 2-hour report for ${patient.patientName}`);
  
  const managerNumber = EXECUTIVES['Manager'] || process.env.MANAGER_NUMBER || '917698011233';
  
  const parameters = [
    { name: "1", value: patient.patientName || "Patient" },
    { name: "2", value: patient.patientPhone },
    { name: "3", value: patient.branch || "Main Branch" },
    { name: "4", value: patient.testType || "Not specified" },
    { name: "5", value: patient.testDetails || "Not specified" }
  ];
  
  await sendWatiTemplateMessage(managerNumber, EXECUTIVE_REPORT_TEMPLATE, parameters);
  
  await patientsCollection.updateOne(
    { _id: patient._id },
    { $set: { lastReportSentAt: new Date() } }
  );
}

// 5. Send Status Reminder (30 min after executive reply)
async function sendStatusReminder(patient) {
  console.log(`⏰ Sending status reminder for ${patient.patientName}`);
  
  const executiveNumber = patient.executiveNumber || getExecutiveNumber(patient.branch);
  const istWaitingSince = patient.updatedAtIST || getISTTime(new Date(patient.updatedAt));
  
  const parameters = [
    { name: "1", value: patient.patientName || "Patient" },
    { name: "2", value: patient.patientPhone },
    { name: "3", value: patient.branch || "Main Branch" },
    { name: "4", value: patient.testType || "Not specified" },
    { name: "5", value: patient.testDetails || "Not specified" },
    { name: "6", value: istWaitingSince }
  ];
  
  await sendWatiTemplateMessage(executiveNumber, FOLLOWUP_WAITING_TEMPLATE, parameters);
  
  await followupCollection.insertOne({
    patientId: patient._id,
    patientPhone: patient.patientPhone,
    executiveNumber: executiveNumber,
    type: 'status_reminder',
    sentAt: new Date(),
    status: 'sent',
    reminderCount: (patient.statusReminderCount || 0) + 1
  });
  
  await patientsCollection.updateOne(
    { _id: patient._id },
    { 
      $inc: { statusReminderCount: 1 },
      $set: { lastStatusReminderAt: new Date() }
    }
  );
}

// ============================================
// ✅ CRON JOBS
// ============================================

// Every 20 minutes - No reply followup
cron.schedule('*/20 * * * *', async () => {
  console.log('🔄 Running no-reply followup check...');
  try {
    const patients = await patientsCollection.find({
      executiveActionTaken: false,
      status: { $in: ['pending', 'awaiting_branch', 'branch_selected', 'executive_notified'] },
      currentStage: { $nin: ['converted', 'not_converted'] },
      createdAt: { $lt: new Date(Date.now() - 20 * 60 * 1000) }
    }).toArray();
    
    for (const patient of patients) {
      const lastFollowup = await followupCollection.findOne({
        patientId: patient._id,
        type: 'no_reply',
        sentAt: { $gt: new Date(Date.now() - 20 * 60 * 1000) }
      });
      if (!lastFollowup) {
        await sendNoReplyFollowup(patient);
      }
    }
  } catch (error) {
    console.error('No-reply followup error:', error);
  }
});

// Every hour - Waiting followup
cron.schedule('0 * * * *', async () => {
  console.log('🔄 Running waiting followup check...');
  try {
    const patients = await patientsCollection.find({
      status: 'waiting',
      currentStage: 'waiting',
      waitingFollowupCount: { $lt: 4 }
    }).toArray();
    
    for (const patient of patients) {
      const waitingCount = (patient.waitingFollowupCount || 0) + 1;
      await sendWaitingFollowup(patient, waitingCount);
    }
  } catch (error) {
    console.error('Waiting followup error:', error);
  }
});

// Every minute - Check for status reminders (30 min after executive reply)
cron.schedule('* * * * *', async () => {
  console.log('⏰ Checking status reminders...');
  try {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    
    const patients = await patientsCollection.find({
      executiveReplied: true,
      statusReminderSent: { $ne: true },
      executiveRepliedAt: { $lte: thirtyMinutesAgo },
      currentStage: { $nin: ['converted', 'not_converted'] }
    }).toArray();
    
    for (const patient of patients) {
      // Check if already converted or not converted
      if (patient.status === 'converted' || patient.status === 'not_converted') {
        continue;
      }
      
      await sendStatusReminder(patient);
      
      await patientsCollection.updateOne(
        { _id: patient._id },
        { $set: { statusReminderSent: true } }
      );
    }
  } catch (error) {
    console.error('Status reminder error:', error);
  }
});

// Every 2 hours - Executive report
cron.schedule('0 */2 * * *', async () => {
  console.log('📊 Running 2-hour report check...');
  try {
    const patients = await patientsCollection.find({
      executiveActionTaken: false,
      currentStage: { $nin: ['converted', 'not_converted'] },
      $or: [
        { lastReportSentAt: { $lt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
        { lastReportSentAt: { $exists: false } }
      ]
    }).toArray();
    
    for (const patient of patients) {
      await sendTwoHourReport(patient);
    }
  } catch (error) {
    console.error('Report error:', error);
  }
});

// ============================================
// ✅ LEAD NOTIFICATION (WITH IST TIME)
// ============================================
async function sendLeadNotification(executiveNumber, patientName, patientPhone, branch, testDetails, testType, chatToken) {
  console.log(`📤 Sending lead notification to executive ${executiveNumber}`);
  
  const istTime = getISTDateTime();
  
  const welcomeText = `Hi ${patientName}, I am from UIC Support Team.

Your Details:
Name: ${patientName}
Test: ${testType} - ${testDetails}
Branch: ${branch}
Miss Call Time: ${istTime}

How can I help you?`;
  
  const whatsappLink = `https://wa.me/${patientPhone}?text=${encodeURIComponent(welcomeText)}`;
  
  const parameters = [
    { name: "1", value: patientName || "Miss Call Patient" },
    { name: "2", value: patientPhone },
    { name: "3", value: branch },
    { name: "4", value: testDetails || "Not specified" },
    { name: "5", value: testType || "Miss Call" },
    { name: "6", value: istTime },
    { name: "7", value: whatsappLink }
  ];
  
  return await sendWatiTemplateMessage(executiveNumber, LEAD_TEMPLATE_NAME, parameters);
}

// ============================================
// ✅ HELPER FUNCTION TO GET FILE URL
// ============================================
function getFileUrlFromMessage(msg) {
  return msg.mediaUrl || 
         msg.url || 
         msg.image?.url || 
         msg.media?.url ||
         msg.document?.url ||
         msg.file?.url ||
         msg.attachments?.[0]?.url ||
         null;
}

// ============================================
// ✅ OPENAI OCR FUNCTION
// ============================================
async function extractWithOpenAI(fileUrl) {
  console.log(`🔍 Performing OCR on: ${fileUrl.substring(0, 50)}...`);
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract patient name and medical tests from this prescription image/PDF. Return ONLY JSON with keys: patientName, tests. If name not found, use 'Unknown'. If tests not found, use 'Not specified'."
            },
            {
              type: "image_url",
              image_url: { url: fileUrl }
            }
          ]
        }
      ],
      max_tokens: 300
    });
    
    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        patientName: parsed.patientName || 'Unknown',
        tests: parsed.tests || 'Not specified'
      };
    }
  } catch (error) {
    console.error('❌ OCR failed:', error.message);
  }
  
  return { patientName: 'Unknown', tests: 'Not specified' };
}

// ============================================
// ✅ PROCESS FILE UPLOAD WITH OCR
// ============================================
async function processFileUpload(messageId, patientName, branch, fileUrl, patientPhone) {
  console.log(`\n📎 Processing file upload for ${patientPhone}`);
  
  try {
    const patient = await patientsCollection.findOne({
      patientPhone: patientPhone,
      status: { $in: ['awaiting_branch', 'pending', 'waiting', 'branch_selected', 'awaiting_name', 'awaiting_test_type', 'awaiting_test_details'] }
    }, { 
      sort: { createdAt: -1 },
      limit: 1 
    });
    
    if (!patient) {
      console.log(`❌ No active patient found for ${patientPhone}`);
      await markMessageProcessed(messageId);
      return false;
    }
    
    await updatePatientStage(patient._id, STAGES.OCR_PROCESSING);
    
    const finalBranch = patient.branch || branch;
    const executiveNumber = getExecutiveNumber(finalBranch);
    
    const extracted = await extractWithOpenAI(fileUrl);
    
    await updatePatientStage(patient._id, STAGES.OCR_COMPLETED);
    
    await patientsCollection.updateOne(
      { _id: patient._id },
      {
        $set: {
          patientName: extracted.patientName !== 'Unknown' ? extracted.patientName : (patient.patientName || patientName),
          testDetails: extracted.tests,
          fileUrl: fileUrl,
          updatedAt: new Date()
        }
      }
    );
    
    let sessionTokenForLink = patient.chatSessionToken;
    if (!sessionTokenForLink) {
      sessionTokenForLink = crypto.randomBytes(16).toString('hex');
      await patientsCollection.updateOne(
        { _id: patient._id },
        { $set: { chatSessionToken: sessionTokenForLink } }
      );
    }
    
    if (!patient.executiveActionTaken && !patient.notificationSent) {
      const finalPatientName = extracted.patientName !== 'Unknown' ? extracted.patientName : (patient.patientName || 'Miss Call Patient');
      const finalTestDetails = extracted.tests !== 'Not specified' ? extracted.tests : (patient.testDetails || 'Not specified');
      
      await sendNotificationAtomic(patient._id, () =>
        sendLeadNotification(
          executiveNumber,
          finalPatientName,
          patientPhone,
          finalBranch,
          finalTestDetails,
          'Upload',
          sessionTokenForLink
        )
      );
    }
    
    return true;
    
  } catch (error) {
    console.error(`❌ processFileUpload error:`, error);
    return false;
  } finally {
    await markMessageProcessed(messageId);
  }
}

// ============================================
// ✅ HYBRID CLASSIFICATION ENGINE
// ============================================
async function classifyMessage(messageText, patientContext = {}) {
  const upperMsg = messageText.toUpperCase();
  const wordCount = messageText.split(' ').length;
  
  const commands = ['UPLOAD PRESCRIPTION', 'MANUAL ENTRY', 'CHANGE BRANCH', 'CONNECT TO PATIENT', 'CONVERT DONE', 'WAITING', 'NOT CONVERT'];
  for (const cmd of commands) {
    if (upperMsg.includes(cmd)) {
      return { category: 'IGNORE', value: messageText, confidence: 1.0, reason: 'Command detected' };
    }
  }
  
  if (patientContext.currentStage === STAGES.AWAITING_NAME) {
    return { category: 'PATIENT_NAME', value: messageText, confidence: 0.95, reason: 'Stage: awaiting_name' };
  }
  if (patientContext.currentStage === STAGES.AWAITING_TEST_TYPE) {
    return { category: 'TEST_TYPE', value: messageText, confidence: 0.95, reason: 'Stage: awaiting_test_type' };
  }
  if (patientContext.currentStage === STAGES.AWAITING_TEST_DETAILS) {
    return { category: 'TEST_DETAILS', value: messageText, confidence: 0.95, reason: 'Stage: awaiting_test_details' };
  }
  
  const testKeywords = ['MRI', 'CT', 'USG', 'X-RAY', 'XRAY', 'ULTRASOUND', 'SONOGRAPHY'];
  const bodyParts = ['KNEE', 'SPINE', 'ABDOMEN', 'CHEST', 'BRAIN', 'HEAD', 'NECK', 'PELVIS', 'HIP', 'SHOULDER', 'WRIST', 'ANKLE'];
  
  let hasTestKeyword = false;
  let hasBodyPart = false;
  
  for (const kw of testKeywords) {
    if (upperMsg.includes(kw)) {
      hasTestKeyword = true;
      break;
    }
  }
  
  for (const bp of bodyParts) {
    if (upperMsg.includes(bp)) {
      hasBodyPart = true;
      break;
    }
  }
  
  const nameRegex = /^[A-Za-z\s]{2,30}$/;
  if (nameRegex.test(messageText) && !hasTestKeyword && wordCount <= 3) {
    return { category: 'PATIENT_NAME', value: messageText, confidence: 0.9, reason: 'Name pattern match' };
  }
  
  if (hasTestKeyword && hasBodyPart) {
    return { category: 'TEST_DETAILS', value: messageText, confidence: 0.98, reason: 'Test + body part' };
  }
  
  if (hasTestKeyword && wordCount > 1) {
    return { category: 'TEST_DETAILS', value: messageText, confidence: 0.85, reason: 'Test keyword with details' };
  }
  
  if (hasTestKeyword && wordCount === 1) {
    return { category: 'TEST_TYPE', value: messageText, confidence: 0.99, reason: 'Single word test type' };
  }
  
  if (!hasTestKeyword && wordCount > 2) {
    try {
      const prompt = `Classify this patient message: "${messageText}"
Categories: PATIENT_NAME, TEST_TYPE, TEST_DETAILS, IGNORE
Return JSON with category and confidence (0-1).`;
      
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You classify medical patient messages accurately." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 100
      });
      
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        if (result.confidence > 0.7) {
          return result;
        }
      }
    } catch (error) {
      console.error('❌ AI fallback error:', error.message);
    }
  }
  
  return { category: 'IGNORE', value: messageText, confidence: 0.5, reason: 'Default ignore' };
}

// ============================================
// ✅ TATA TELE WEBHOOK (WITH IST TIME)
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
    
    const istTime = getISTTime();
    
    await missCallsCollection.insertOne({
      phoneNumber: whatsappNumber,
      calledNumber: calledNumber,
      branch: branch.name,
      createdAt: new Date(),
      istTime: istTime
    });
    
    const chatId = `${whatsappNumber}_${branch.name}`;
    
    const existingPatient = await patientsCollection.findOne({ patientPhone: whatsappNumber });
    
    if (existingPatient) {
      await patientsCollection.updateOne(
        { _id: existingPatient._id },
        { 
          $set: { 
            missCallTime: new Date(),
            missCallTimeIST: istTime,
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
        missCallTimeIST: istTime,
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
// ✅ WATI WEBHOOK - COMPLETE
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('\n📨 WATI WEBHOOK RECEIVED');
    
    const msg = req.body;
    const msgId = msg.id || msg.messageId;
    if (!msgId) return res.sendStatus(200);
    
    if (await isMessageProcessed(msgId)) return res.sendStatus(200);
    
    const senderNumber = msg.whatsappNumber || msg.from || msg.waId;
    if (!senderNumber) {
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
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
    
    // FILE/IMAGE HANDLING
    if (msg.type === 'image' || msg.messageType === 'image' || msg.image || msg.document || msg.file || msg.media) {
      console.log(`📎 File/Image detected from ${senderNumber}`);
      
      const fileUrl = getFileUrlFromMessage(msg);
      
      if (fileUrl) {
        const patient = await patientsCollection.findOne({ patientPhone: senderNumber });
        if (patient) {
          const branch = patient.branch || 'Naroda';
          await processFileUpload(msgId, patient.patientName || 'Patient', branch, fileUrl, senderNumber);
        }
      }
      
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
    // ============================================
    // ✅ CHECK IF EXECUTIVE SENT MESSAGE TO PATIENT
    // ============================================
    const isExecutive = Object.values(EXECUTIVES).includes(senderNumber);
    
    if (isExecutive && messageText && !text.endsWith('_BRANCH') && !text.startsWith('CONVERT') && !text.startsWith('WAITING') && !text.startsWith('NOT')) {
      // Executive sent a message - find which patient they are assigned to
      const patient = await patientsCollection.findOne({ 
        executiveNumber: senderNumber,
        currentStage: { $nin: ['converted', 'not_converted'] }
      });
      
      if (patient) {
        console.log(`✅ Executive ${senderNumber} replied to patient ${patient.patientPhone}`);
        
        // Mark that executive has taken action - STOP REMINDERS
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $set: { 
              executiveActionTaken: true,
              executiveReplied: true,
              executiveRepliedAt: new Date(),
              noReplyFollowupCount: 0  // Reset counter
            }
          }
        );
        
        // Close all pending no-reply followups for this patient
        await followupCollection.updateMany(
          { patientId: patient._id, type: 'no_reply', status: 'sent' },
          { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'executive_reply' } }
        );
        
        // Store the message in chat history
        const session = await getOrCreateChatSession(patient);
        await chatMessagesCollection.insertOne({
          sessionToken: session.sessionToken,
          sender: 'executive',
          text: messageText,
          timestamp: new Date(),
          watiMessageId: msg.id
        });
        
        console.log(`⏰ Status reminder will be sent after 30 minutes`);
      }
    }
    
    // HANDLE PATIENT REPLIES
    const activeSession = await chatSessionsCollection.findOne({
      patientPhone: senderNumber,
      status: 'active'
    });
    
    if (activeSession && text && !text.endsWith('_BRANCH')) {
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
    
    // HYBRID CLASSIFICATION (for patients)
    if (!text.endsWith('_BRANCH') && !text.startsWith('CONNECT') && !text.startsWith('CONVERT') && !text.startsWith('WAITING') && !text.startsWith('NOT')) {
      
      let patient = await patientsCollection.findOne({ patientPhone: senderNumber });
      
      if (!patient) {
        const result = await patientsCollection.insertOne({
          patientPhone: senderNumber,
          patientName: 'Miss Call Patient',
          patientMessages: [],
          testType: null,
          testDetails: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          currentStage: STAGES.AWAITING_BRANCH
        });
        patient = { _id: result.insertedId };
      }
      
      await patientsCollection.updateOne(
        { _id: patient._id },
        {
          $push: { patientMessages: { text: messageText, type: messageType, timestamp: new Date() } },
          $set: { lastMessageAt: new Date() }
        }
      );
      
      const context = {
        currentStage: patient.currentStage,
        patientName: patient.patientName,
        testType: patient.testType,
        testDetails: patient.testDetails
      };
      
      const result = await classifyMessage(messageText, context);
      
      if (result.confidence >= 0.8) {
        if (result.category === 'PATIENT_NAME') {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { $set: { patientName: result.value, currentStage: STAGES.AWAITING_TEST_TYPE } }
          );
        }
        else if (result.category === 'TEST_TYPE') {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { $set: { testType: result.value, currentStage: STAGES.AWAITING_TEST_DETAILS } }
          );
        }
        else if (result.category === 'TEST_DETAILS') {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { $set: { testDetails: result.value, currentStage: STAGES.AWAITING_BRANCH } }
          );
        }
      }
    }
    
    // ============================================
    // ✅ HANDLE EXECUTIVE QUICK REPLIES (Convert Done, Waiting, Not Convert)
    // ============================================
    if (text === 'CONVERT DONE' || text === 'WAITING' || text === 'NOT CONVERT') {
      console.log(`🔘 Executive quick reply: ${text} from ${senderNumber}`);
      
      let patient = await patientsCollection.findOne({ 
        executiveNumber: senderNumber,
        status: { $in: ['pending', 'awaiting_branch', 'branch_selected', 'executive_notified', 'waiting'] }
      });
      
      if (!patient) {
        patient = await patientsCollection.findOne({ 
          executiveNumber: senderNumber,
          currentStage: { $nin: ['converted', 'not_converted'] }
        });
      }
      
      if (!patient) {
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "❌ No active patient found for you." }]
        );
        await markMessageProcessed(msgId);
        return res.sendStatus(200);
      }
      
      if (text === 'CONVERT DONE') {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $set: { 
              status: 'converted',
              currentStage: STAGES.CONVERTED,
              executiveActionTaken: true,
              convertedAt: new Date(),
              convertedAtIST: getISTTime(),
              noReplyFollowupCount: 0,
              waitingFollowupCount: 0,
              statusReminderSent: true
            }
          }
        );
        
        await followupCollection.updateMany(
          { patientId: patient._id, status: 'sent' },
          { $set: { status: 'resolved', resolvedAt: new Date() } }
        );
        
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "✅ Patient marked as converted. Thank you!" }]
        );
      }
      else if (text === 'WAITING') {
        const waitingCount = (patient.waitingFollowupCount || 0) + 1;
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $set: { 
              status: 'waiting',
              currentStage: STAGES.WAITING,
              waitingFollowupCount: waitingCount,
              updatedAt: new Date(),
              updatedAtIST: getISTTime()
            }
          }
        );
        
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "⏳ Patient marked as waiting. We'll follow up." }]
        );
      }
      else if (text === 'NOT CONVERT') {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $set: { 
              status: 'not_converted',
              currentStage: STAGES.NOT_CONVERTED,
              executiveActionTaken: true,
              notConvertedAt: new Date(),
              notConvertedAtIST: getISTTime(),
              statusReminderSent: true
            }
          }
        );
        
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "❌ Patient marked as not converted." }]
        );
      }
    }
    
    // ============================================
    // ✅ HANDLE CONNECT TO PATIENT
    // ============================================
    else if (text === 'CONNECT TO PATIENT') {
      console.log(`🔘 Executive connect request: ${text} from ${senderNumber}`);
      
      const patient = await patientsCollection.findOne({ 
        executiveNumber: senderNumber,
        status: { $in: ['pending', 'awaiting_branch', 'branch_selected', 'executive_notified'] }
      });
      
      if (!patient) {
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "❌ No patient assigned to you." }]
        );
        await markMessageProcessed(msgId);
        return res.sendStatus(200);
      }
      
      const session = await getOrCreateChatSession(patient);
      
      const welcomeMessage = `Hi, I am UIC Support Team\n\nYour name is: ${patient.patientName || 'Patient'}\nTest: ${patient.testType || 'Not specified'}\nBranch: ${patient.branch || 'Main Branch'}`;
      
      try {
        await sendWhatsAppMessageToPatient(senderNumber, patient.patientPhone, welcomeMessage);
        
        await chatMessagesCollection.insertOne({
          sessionToken: session.sessionToken,
          sender: 'executive',
          text: welcomeMessage,
          timestamp: new Date(),
          isWelcomeMessage: true
        });
        
      } catch (error) {
        console.error(`❌ Failed to send welcome message:`, error.message);
      }
      
      await sendLeadNotification(
        senderNumber,
        patient.patientName || 'Patient',
        patient.patientPhone,
        patient.branch || 'Branch',
        patient.testDetails || 'Not specified',
        patient.testType || 'Miss Call',
        session.sessionToken
      );
    }
    
    // ============================================
    // ✅ HANDLE MANAGER QUICK REPLIES
    // ============================================
    else if (text === 'SEND EXECUTIVE PT DETAILS' || text === 'SEND EXECUTIVE') {
      console.log(`🔘 Manager quick reply: ${text} from ${senderNumber}`);
      
      const patient = await patientsCollection.findOne({ 
        escalatedToManager: true,
        escalatedResolved: { $ne: true }
      });
      
      if (!patient) {
        await sendWatiTemplateMessage(
          senderNumber,
          'text_message',
          [{ name: "1", value: "❌ No escalated patient found." }]
        );
        await markMessageProcessed(msgId);
        return res.sendStatus(200);
      }
      
      const session = await getOrCreateChatSession(patient);
      const executiveNumber = patient.executiveNumber || getExecutiveNumber(patient.branch);
      const detailsLink = `${SELF_URL}/executive-chat/${session.sessionToken}`;
      
      await sendWatiTemplateMessage(
        executiveNumber,
        'text_message',
        [{ name: "1", value: `📋 Patient details: ${detailsLink}\n\nPatient: ${patient.patientName}\nPhone: ${patient.patientPhone}\nTest: ${patient.testType} - ${patient.testDetails}` }]
      );
      
      await sendWatiTemplateMessage(
        senderNumber,
        'text_message',
        [{ name: "1", value: `✅ Patient details sent to executive ${executiveNumber}` }]
      );
      
      await followupCollection.insertOne({
        patientId: patient._id,
        managerNumber: senderNumber,
        executiveNumber: executiveNumber,
        type: 'manager_action',
        action: 'send_details',
        sentAt: new Date()
      });
    }
    
    // ============================================
    // ✅ HANDLE _BRANCH MESSAGES
    // ============================================
    else if (text.endsWith('_BRANCH')) {
      const branchUpper = text.replace('_BRANCH', '');
      const branch = branchUpper.charAt(0).toUpperCase() + branchUpper.slice(1).toLowerCase();
      
      console.log(`🎯 BRANCH DETECTED: ${branch}`);
      
      const whatsappNumber = normalizeWhatsAppNumber(senderNumber);
      const executiveNumber = getExecutiveNumber(branchUpper);
      
      let patient = await patientsCollection.findOne({ patientPhone: whatsappNumber });
      
      if (!patient) {
        const result = await patientsCollection.insertOne({
          chatId: `${whatsappNumber}_${branch}`,
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
          currentStage: STAGES.AWAITING_NAME,
          stageHistory: [{ stage: STAGES.BRANCH_SELECTED, timestamp: new Date() }]
        });
        patient = { _id: result.insertedId };
      } else {
        await patientsCollection.updateOne(
          { _id: patient._id },
          {
            $set: {
              branch: branch,
              status: 'pending',
              executiveNumber: executiveNumber,
              currentStage: STAGES.AWAITING_NAME,
              updatedAt: new Date()
            }
          }
        );
      }
      
      let sessionTokenForLink = patient.chatSessionToken;
      if (!sessionTokenForLink) {
        sessionTokenForLink = crypto.randomBytes(16).toString('hex');
        await patientsCollection.updateOne(
          { _id: patient._id },
          { $set: { chatSessionToken: sessionTokenForLink } }
        );
      }
      
      const freshPatientData = await patientsCollection.findOne({ _id: patient._id });
      
      let patientNameToSend = freshPatientData.patientName || 'Miss Call Patient';
      let testTypeToSend = freshPatientData.testType || 'Miss Call';
      let testDetailsToSend = freshPatientData.testDetails || 'Not specified';
      
      if (!patient.executiveActionTaken) {
        await sendNotificationAtomic(patient._id, () =>
          sendLeadNotification(
            executiveNumber,
            patientNameToSend,
            whatsappNumber,
            branch,
            testDetailsToSend,
            testTypeToSend,
            sessionTokenForLink
          )
        );
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
    const patient = await patientsCollection.findOne({ chatSessionToken: token });
    if (patient && patient.chatSessionToken) {
      return res.redirect(`/executive-chat/${patient.chatSessionToken}`);
    }
    return res.send(`<h2>❌ Invalid Session</h2><p>Please click "Connect to Patient" again from WhatsApp.</p>`);
  }
  
  const messages = await chatMessagesCollection
    .find({ sessionToken: token })
    .sort({ timestamp: 1 })
    .toArray();
  
  const patient = await patientsCollection.findOne({ patientPhone: session.patientPhone });
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Executive Chat - ${session.patientName || 'Patient'}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f0f2f5; height: 100vh; }
        .chat-container { max-width: 800px; margin: 0 auto; height: 100vh; display: flex; flex-direction: column; background: white; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
        .chat-header { background: linear-gradient(135deg, #075e54, #128C7E); color: white; padding: 15px; display: flex; justify-content: space-between; align-items: center; }
        .patient-info { flex: 1; }
        .patient-name { font-weight: bold; font-size: 1.2em; }
        .patient-phone { font-size: 0.8em; opacity: 0.9; }
        .test-info { background: rgba(255,255,255,0.2); padding: 5px 12px; border-radius: 20px; font-size: 0.85em; }
        .messages-container { flex: 1; overflow-y: auto; padding: 20px; background: #e5ddd5; }
        .message { margin: 10px 0; display: flex; }
        .message.patient { justify-content: flex-start; }
        .message.executive { justify-content: flex-end; }
        .message-content { max-width: 70%; padding: 10px 15px; border-radius: 18px; position: relative; word-wrap: break-word; }
        .message.patient .message-content { background: white; border-bottom-left-radius: 4px; }
        .message.executive .message-content { background: #dcf8c6; border-bottom-right-radius: 4px; }
        .message-time { font-size: 0.7em; color: #999; margin-top: 5px; text-align: right; }
        .input-area { display: flex; padding: 15px; background: #f0f0f0; border-top: 1px solid #ddd; }
        #messageInput { flex: 1; padding: 12px 15px; border: 1px solid #ddd; border-radius: 25px; outline: none; font-size: 1em; }
        #sendBtn { width: 50px; height: 50px; border-radius: 50%; background: #075e54; color: white; border: none; margin-left: 10px; cursor: pointer; font-size: 1.2em; }
        #sendBtn:hover { background: #128C7E; }
        .quick-replies { display: flex; gap: 10px; padding: 10px 15px; background: white; border-top: 1px solid #eee; flex-wrap: wrap; }
        .quick-reply-btn { background: #f0f0f0; border: 1px solid #ddd; padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 0.9em; }
        .quick-reply-btn:hover { background: #075e54; color: white; }
      </style>
    </head>
    <body>
      <div class="chat-container">
        <div class="chat-header">
          <div class="patient-info">
            <div class="patient-name">${escapeHtml(session.patientName || 'Patient')}</div>
            <div class="patient-phone">${session.patientPhone}</div>
          </div>
          ${patient ? `<div class="test-info">📋 ${escapeHtml(patient.testType || 'Miss Call')}</div>` : ''}
        </div>
        
        <div class="messages-container" id="messages">
          ${messages.map(msg => `
            <div class="message ${msg.sender === 'executive' ? 'executive' : 'patient'}">
              <div class="message-content">
                ${escapeHtml(msg.text)}
                <div class="message-time">${getISTTime(new Date(msg.timestamp))}</div>
              </div>
            </div>
          `).join('')}
        </div>
        
        <div class="quick-replies">
          <button class="quick-reply-btn" onclick="sendQuickReply('Thank you')">🙏 Thank you</button>
          <button class="quick-reply-btn" onclick="sendQuickReply('Please wait')">⏳ Please wait</button>
          <button class="quick-reply-btn" onclick="sendQuickReply('I will check')">📞 I will check</button>
        </div>
        
        <div class="input-area">
          <input type="text" id="messageInput" placeholder="Type your message..." autocomplete="off">
          <button id="sendBtn" onclick="sendMessage()">➤</button>
        </div>
      </div>
      
      <script>
        const sessionToken = '${token}';
        let lastMessageCount = ${messages.length};
        
        setInterval(checkNewMessages, 2000);
        
        async function checkNewMessages() {
          const response = await fetch('/api/chat-messages/' + sessionToken + '?since=' + lastMessageCount);
          const data = await response.json();
          if (data.messages && data.messages.length > 0) {
            data.messages.forEach(msg => {
              const div = document.createElement('div');
              div.className = 'message ' + msg.sender;
              div.innerHTML = '<div class="message-content">' + escapeHtml(msg.text) + '<div class="message-time">' + new Date(msg.timestamp).toLocaleTimeString() + '</div></div>';
              document.getElementById('messages').appendChild(div);
            });
            lastMessageCount += data.messages.length;
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
          }
        }
        
        async function sendMessage() {
          const text = document.getElementById('messageInput').value.trim();
          if (!text) return;
          
          const response = await fetch('/api/send-to-patient', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionToken, text })
          });
          const result = await response.json();
          if (result.success) {
            const div = document.createElement('div');
            div.className = 'message executive';
            div.innerHTML = '<div class="message-content">' + escapeHtml(text) + '<div class="message-time">Just now</div></div>';
            document.getElementById('messages').appendChild(div);
            document.getElementById('messageInput').value = '';
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
          }
        }
        
        function sendQuickReply(reply) {
          document.getElementById('messageInput').value = reply;
          sendMessage();
        }
        
        function escapeHtml(text) {
          const div = document.createElement('div');
          div.textContent = text;
          return div.innerHTML;
        }
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
    
    const result = await sendWhatsAppMessageToPatient(session.executiveNumber, session.patientPhone, text);
    
    await chatMessagesCollection.insertOne({
      sessionToken,
      sender: 'executive',
      text: text,
      timestamp: new Date(),
      watiMessageId: result?.messageId
    });
    
    await chatSessionsCollection.updateOne(
      { sessionToken },
      { $set: { lastActivity: new Date() } }
    );
    
    res.json({ success: true, messageId: result?.messageId });
    
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
// ✅ CONNECT CHAT ENDPOINT
// ============================================
app.get('/connect-chat/:token', async (req, res) => {
  const { token } = req.params;
  res.redirect(`/executive-chat/${token}`);
});

// ============================================
// ✅ EXECUTIVE ACTION HANDLER
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
        updatedAt: new Date(),
        executiveActionTaken: true
      },
      $push: { stageHistory: { stage: stage, timestamp: new Date() } }
    }
  );
  
  res.send(`✅ Patient marked as ${status}`);
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
    
    const followupStats = {
      noReplySent: await followupCollection.countDocuments({ type: 'no_reply', sentAt: { $gte: today } }),
      waitingSent: await followupCollection.countDocuments({ type: 'waiting', sentAt: { $gte: today } }),
      escalations: await followupCollection.countDocuments({ type: 'escalation', sentAt: { $gte: today } }),
      statusReminders: await followupCollection.countDocuments({ type: 'status_reminder', sentAt: { $gte: today } }),
      totalFollowups: await followupCollection.countDocuments()
    };
    
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
      followupStats,
      uptime: process.uptime()
    });
  } catch (error) {
    console.error('API Stats Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
  res.json({
    success: true,
    uptime: process.uptime(),
    mongodb: 'connected',
    template: LEAD_TEMPLATE_NAME,
    timezone: 'Asia/Kolkata',
    istTime: getISTTime(),
    followupTemplates: {
      noReply: FOLLOWUP_NO_REPLY_TEMPLATE,
      waiting: FOLLOWUP_WAITING_TEMPLATE,
      escalation: ESCALATION_MANAGER_TEMPLATE,
      report: EXECUTIVE_REPORT_TEMPLATE
    }
  });
});

// ============================================
// ✅ HOME ROUTE
// ============================================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Tata-WATI Executive System',
    version: '11.0.0',
    timezone: 'Asia/Kolkata (IST)',
    istTime: getISTTime(),
    template: LEAD_TEMPLATE_NAME,
    features: [
      '✅ Permanent chat links (never expire)',
      '✅ WhatsApp direct link in reminders',
      '✅ Auto follow-up every 20 min for no reply',
      '✅ Executive reply stops reminders',
      '✅ Status reminder after 30 min',
      '✅ Auto follow-up every hour for waiting status',
      '✅ Escalation to manager after 4 waiting follow-ups',
      '✅ 2-hour report to manager',
      '✅ IST timezone for all messages'
    ],
    endpoints: {
      executive_chat: '/executive-chat/:token',
      connect_chat: '/connect-chat/:token',
      health: '/health',
      api_stats: '/api/stats',
      admin_dashboard: '/admin'
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
  req.chatMessagesCollection = chatMessagesCollection;
  req.followupCollection = followupCollection;
  req.STAGES = STAGES;
  req.PORT = PORT;
  next();
}, dashboardRouter);

// ============================================
// ✅ ESCAPE HTML HELPER
// ============================================
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
      console.log(`📍 Timezone: Asia/Kolkata (IST)`);
      console.log(`📍 Current IST Time: ${getISTTime()}`);
      console.log(`📍 Lead Template: ${LEAD_TEMPLATE_NAME}`);
      console.log(`📍 Follow-up Templates:`);
      console.log(`   - No Reply: ${FOLLOWUP_NO_REPLY_TEMPLATE} (every 20 min) - WhatsApp Direct Link`);
      console.log(`   - Waiting: ${FOLLOWUP_WAITING_TEMPLATE} (every hour)`);
      console.log(`   - Escalation: ${ESCALATION_MANAGER_TEMPLATE} (after 4 waiting)`);
      console.log(`   - Report: ${EXECUTIVE_REPORT_TEMPLATE} (every 2 hours)`);
      console.log(`📍 Status Reminder: 30 minutes after executive reply`);
      console.log(`📍 Chat Sessions: PERMANENT (never expire)`);
      console.log(`📍 Admin Dashboard: ${SELF_URL}/admin`);
      console.log('='.repeat(60) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
