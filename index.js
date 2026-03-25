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

function isNightTime() {
  const now = new Date();
  const hours = now.getHours();
  return hours >= 20 || hours < 8;
}

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 10000;
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

// GMB Template Names
const GOOGLE_LEAD_TEMPLATE = 'google_lead_notification_v5';
const GOOGLE_FOLLOWUP_NO_REPLY = 'google_followup_no_reply';
const GOOGLE_FOLLOWUP_WAITING = 'google_followup_waiting';
const GOOGLE_EXECUTIVE_REPORT = 'google_executive_report';
const GOOGLE_ESCALATION_MANAGER = 'google_escalation_manager';
const TEXT_MESSAGE_TEMPLATE = 'text_message';
const CUSTOMER_WELCOME_TEMPLATE = 'gmb_customer_welcome';

// Miss Call Follow-up Templates
const FOLLOWUP_NO_REPLY_TEMPLATE = 'followup_no_reply';
const FOLLOWUP_WAITING_TEMPLATE = 'following_waiting';
const ESCALATION_MANAGER_TEMPLATE = 'escalation_manager';
const EXECUTIVE_REPORT_TEMPLATE = 'executive_report';

// WATI Number
const WATI_NUMBER = '919725504245';

// ============================================
// ✅ EXECUTIVE NUMBERS - CORRECT MAPPING
// ============================================

// GMB Executive Numbers (4 executives)
const GMB_EXECUTIVES = {
  'Aditi': '8488931212',
  'Khyati': '7490029085',
  'Jay': '9274682553',
  'Mital': '9558591212',
  'Manager': '7698011233'
};

// Miss Call Executive Numbers (Original Tata Tele numbers)
const MISS_CALL_EXECUTIVES = {
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

// ============================================
// ✅ GMB BRANCH TO EXECUTIVE MAPPING
// ============================================
const GMB_BRANCHES = {
  'naroda': { name: 'Naroda', executiveNumber: GMB_EXECUTIVES.Aditi, executiveName: 'Aditi' },
  'ahmedabad': { name: 'Ahmedabad', executiveNumber: GMB_EXECUTIVES.Aditi, executiveName: 'Aditi' },
  'gandhinagar': { name: 'Gandhinagar', executiveNumber: GMB_EXECUTIVES.Aditi, executiveName: 'Aditi' },
  'sabarmati': { name: 'Sabarmati', executiveNumber: GMB_EXECUTIVES.Aditi, executiveName: 'Aditi' },
  'anand': { name: 'Anand', executiveNumber: GMB_EXECUTIVES.Aditi, executiveName: 'Aditi' },
  'usmanpura': { name: 'Usmanpura', executiveNumber: GMB_EXECUTIVES.Khyati, executiveName: 'Khyati' },
  'satellite': { name: 'Satellite', executiveNumber: GMB_EXECUTIVES.Khyati, executiveName: 'Khyati' },
  'nadiad': { name: 'Nadiad', executiveNumber: GMB_EXECUTIVES.Khyati, executiveName: 'Khyati' },
  'jamnagar': { name: 'Jamnagar', executiveNumber: GMB_EXECUTIVES.Khyati, executiveName: 'Khyati' },
  'bhavnagar': { name: 'Bhavnagar', executiveNumber: GMB_EXECUTIVES.Khyati, executiveName: 'Khyati' },
  'bapunagar': { name: 'Bapunagar', executiveNumber: GMB_EXECUTIVES.Jay, executiveName: 'Jay' },
  'juhapura': { name: 'Juhapura', executiveNumber: GMB_EXECUTIVES.Jay, executiveName: 'Jay' },
  'surat': { name: 'Surat', executiveNumber: GMB_EXECUTIVES.Jay, executiveName: 'Jay' },
  'changodar': { name: 'Changodar', executiveNumber: GMB_EXECUTIVES.Jay, executiveName: 'Jay' },
  'bareja': { name: 'Bareja', executiveNumber: GMB_EXECUTIVES.Jay, executiveName: 'Jay' },
  'vadaj': { name: 'Vadaj', executiveNumber: GMB_EXECUTIVES.Mital, executiveName: 'Mital' },
  'maninagar': { name: 'Maninagar', executiveNumber: GMB_EXECUTIVES.Mital, executiveName: 'Mital' },
  'rajkot': { name: 'Rajkot', executiveNumber: GMB_EXECUTIVES.Mital, executiveName: 'Mital' },
  'vadodara': { name: 'Vadodara', executiveNumber: GMB_EXECUTIVES.Mital, executiveName: 'Mital' },
  'morbi': { name: 'Morbi', executiveNumber: GMB_EXECUTIVES.Mital, executiveName: 'Mital' }
};

// ============================================
// ✅ MISS CALL BRANCH CONFIGURATION
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

const MISS_CALL_BRANCHES = {
  [normalizeIndianNumber(process.env.NARODA_NUMBER || '07969690935')]: { name: 'Naroda', executive: MISS_CALL_EXECUTIVES['Naroda Team'] },
  [normalizeIndianNumber('917969690922')]: { name: 'Naroda', executive: MISS_CALL_EXECUTIVES['Naroda Team'] },
  [normalizeIndianNumber(process.env.USMANPURA_NUMBER || '9898989897')]: { name: 'Usmanpura', executive: MISS_CALL_EXECUTIVES['Usmanpura Team'] },
  [normalizeIndianNumber('917969690952')]: { name: 'Usmanpura', executive: MISS_CALL_EXECUTIVES['Usmanpura Team'] },
  [normalizeIndianNumber(process.env.VADAJ_NUMBER || '9898989896')]: { name: 'Vadaj', executive: MISS_CALL_EXECUTIVES['Vadaj Team'] },
  [normalizeIndianNumber('917969690917')]: { name: 'Vadaj', executive: MISS_CALL_EXECUTIVES['Vadaj Team'] },
  [normalizeIndianNumber(process.env.SATELLITE_NUMBER || '9898989898')]: { name: 'Satellite', executive: MISS_CALL_EXECUTIVES['Satellite Team'] },
  [normalizeIndianNumber('917969690902')]: { name: 'Satellite', executive: MISS_CALL_EXECUTIVES['Satellite Team'] },
  [normalizeIndianNumber(process.env.MANINAGAR_NUMBER || '9898989895')]: { name: 'Maninagar', executive: MISS_CALL_EXECUTIVES['Maninagar Team'] },
  [normalizeIndianNumber('917969690904')]: { name: 'Maninagar', executive: MISS_CALL_EXECUTIVES['Maninagar Team'] },
  [normalizeIndianNumber(process.env.BAPUNAGAR_NUMBER || '9898989894')]: { name: 'Bapunagar', executive: MISS_CALL_EXECUTIVES['Bapunagar Team'] },
  [normalizeIndianNumber('917969690906')]: { name: 'Bapunagar', executive: MISS_CALL_EXECUTIVES['Bapunagar Team'] },
  [normalizeIndianNumber(process.env.JUHAPURA_NUMBER || '9898989893')]: { name: 'Juhapura', executive: MISS_CALL_EXECUTIVES['Juhapura Team'] },
  [normalizeIndianNumber('917969690909')]: { name: 'Juhapura', executive: MISS_CALL_EXECUTIVES['Juhapura Team'] },
  [normalizeIndianNumber(process.env.GANDHINAGAR_NUMBER || '9898989892')]: { name: 'Gandhinagar', executive: MISS_CALL_EXECUTIVES['Gandhinagar Team'] },
  [normalizeIndianNumber('917969690910')]: { name: 'Gandhinagar', executive: MISS_CALL_EXECUTIVES['Gandhinagar Team'] },
  [normalizeIndianNumber('917969690913')]: { name: 'Rajkot', executive: MISS_CALL_EXECUTIVES['Rajkot Team'] },
  [normalizeIndianNumber('917969690919')]: { name: 'Rajkot', executive: MISS_CALL_EXECUTIVES['Rajkot Team'] },
  [normalizeIndianNumber('917969690942')]: { name: 'Sabarmati', executive: MISS_CALL_EXECUTIVES['Sabarmati Team'] },
  [normalizeIndianNumber('917969690905')]: { name: 'Sabarmati', executive: MISS_CALL_EXECUTIVES['Sabarmati Team'] }
};

function getMissCallBranchByCalledNumber(calledNumber) {
  const normalized = normalizeIndianNumber(calledNumber);
  return MISS_CALL_BRANCHES[normalized] || { name: 'Main Branch', executive: process.env.DEFAULT_EXECUTIVE || '917880261858' };
}

function getMissCallExecutiveNumber(branchName) {
  if (!branchName || branchName === 'Main Branch') {
    return process.env.DEFAULT_EXECUTIVE || '917880261858';
  }
  const formattedBranch = branchName.charAt(0).toUpperCase() + branchName.slice(1).toLowerCase();
  const teamName = `${formattedBranch} Team`;
  return MISS_CALL_EXECUTIVES[teamName] || process.env.DEFAULT_EXECUTIVE || '917880261858';
}

// ============================================
// ✅ GMB BRANCH DETECTION (STRONG)
// ============================================
function detectGMBBranch(message) {
  const msgLower = (message || '').toLowerCase();
  const branches = ['naroda', 'ahmedabad', 'gandhinagar', 'sabarmati', 'anand', 'usmanpura', 'satellite', 'nadiad', 'jamnagar', 'bhavnagar', 'bapunagar', 'juhapura', 'surat', 'changodar', 'bareja', 'vadaj', 'maninagar', 'rajkot', 'vadodara', 'morbi'];
  
  for (const branch of branches) {
    if (msgLower.includes(branch)) {
      return branch.charAt(0).toUpperCase() + branch.slice(1);
    }
  }
  return null;
}

function isLikelyGMBMessage(message) {
  const msgLower = (message || '').toLowerCase();
  return detectGMBBranch(message) !== null ||
         msgLower.includes('appointment') ||
         msgLower.includes('book') ||
         msgLower.includes('want to book') ||
         msgLower.includes('booking');
}

function getGMBExecutiveByBranch(branchName) {
  const branch = GMB_BRANCHES[branchName?.toLowerCase()];
  if (branch) {
    return { executiveNumber: branch.executiveNumber, executiveName: branch.executiveName };
  }
  return { executiveNumber: GMB_EXECUTIVES.Aditi, executiveName: 'Aditi' };
}

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
let googleLeadsCollection;

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
    googleLeadsCollection = db.collection('google_leads');
    
    // Indexes
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await patientsCollection.createIndex({ chatId: 1 }, { unique: true, sparse: true });
    await patientsCollection.createIndex({ patientPhone: 1, source: 1 });
    await patientsCollection.createIndex({ patientPhone: 1, status: 1 });
    await patientsCollection.createIndex({ patientPhone: 1, createdAt: -1 });
    await patientsCollection.createIndex({ missCallCount: -1 });
    await patientsCollection.createIndex({ executiveActionTaken: 1 });
    await patientsCollection.createIndex({ currentStage: 1 });
    await chatSessionsCollection.createIndex({ sessionToken: 1 }, { unique: true });
    await chatSessionsCollection.createIndex({ patientPhone: 1, status: 1 });
    await chatMessagesCollection.createIndex({ sessionToken: 1, timestamp: 1 });
    await followupCollection.createIndex({ patientId: 1, type: 1, createdAt: -1 });
    await googleLeadsCollection.createIndex({ clickedAt: -1 });
    await googleLeadsCollection.createIndex({ branch: 1 });
    await googleLeadsCollection.createIndex({ phoneNumber: 1 });
    
    console.log('✅ Indexes created');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    throw error;
  }
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
// ✅ SESSION FUNCTIONS
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
    const executiveNumber = patient.source === 'gmb' 
      ? getGMBExecutiveByBranch(patient.branch).executiveNumber 
      : getMissCallExecutiveNumber(patient.branch);
    const sessionToken = await createChatSession(executiveNumber, patient.patientPhone, patient.patientName);
    await patientsCollection.updateOne({ _id: patient._id }, { $set: { chatSessionToken: sessionToken } });
    session = await chatSessionsCollection.findOne({ sessionToken });
  }
  return session;
}

// ============================================
// ✅ WATI TEMPLATE SENDER
// ============================================
async function sendWatiTemplateMessage(whatsappNumber, templateName, parameters) {
  console.log(`📤 Sending template ${templateName} to ${whatsappNumber}`);
  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
  const payload = { template_name: templateName, broadcast_name: `msg_${Date.now()}`, parameters: parameters || [] };
  try {
    const response = await axios.post(url, payload, {
      headers: { Authorization: `${WATI_TOKEN}`, 'Content-Type': 'application/json' },
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
// ✅ SEND SESSION MESSAGE
// ============================================
async function sendWhatsAppMessageToPatient(executiveNumber, patientPhone, message) {
  console.log(`📤 Sending message from executive to patient ${patientPhone}`);
  const url = `${WATI_BASE_URL}/api/v1/sendSessionMessage/${patientPhone}`;
  const payload = { messageText: message };
  try {
    const response = await axios.post(url, payload, {
      headers: { 'Authorization': WATI_TOKEN, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    console.log(`✅ Message sent successfully`);
    return response.data;
  } catch (error) {
    console.error(`❌ Failed to send message:`, error.message);
    throw error;
  }
}

// ============================================
// ✅ GMB FUNCTIONS
// ============================================
async function sendGMBLeadNotification(executiveNumber, executiveName, patientName, patientPhone, branch, testDetails, testType, chatToken) {
  console.log(`📤 Sending GMB LEAD notification to executive ${executiveName} (${executiveNumber})`);
  const istTime = getISTTime();
  const welcomeText = `Hi ${patientName}, I am from UIC Support Team (Google Lead).

Your Details:
Name: ${patientName}
Test: ${testType} - ${testDetails}
Branch: ${branch}
Time: ${istTime}
Source: Google My Business

How can I help you?`;
  const whatsappLink = `https://wa.me/${patientPhone}?text=${encodeURIComponent(welcomeText)}`;
  const parameters = [
    { name: "1", value: patientName || "Google Lead" },
    { name: "2", value: patientPhone },
    { name: "3", value: branch },
    { name: "4", value: testType || "Not specified" },
    { name: "5", value: testDetails || "Not specified" },
    { name: "6", value: istTime },
    { name: "7", value: whatsappLink }
  ];
  return await sendWatiTemplateMessage(executiveNumber, GOOGLE_LEAD_TEMPLATE, parameters);
}

async function sendCustomerWelcome(whatsappNumber, branchName) {
  console.log(`📤 Sending customer welcome template to ${whatsappNumber} for ${branchName}`);
  return await sendWatiTemplateMessage(whatsappNumber, CUSTOMER_WELCOME_TEMPLATE, [{ name: "1", value: branchName }]);
}

// ============================================
// ✅ MISS CALL FUNCTIONS
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
// ✅ BOT CLASSIFICATION (IMPROVED)
// ============================================
async function classifyMessage(messageText, patientContext = {}) {
  const upperMsg = messageText.toUpperCase();
  const wordCount = messageText.split(' ').length;
  const lowerMsg = messageText.toLowerCase();
  
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
  
  let hasTestKeyword = false, hasBodyPart = false;
  for (const kw of testKeywords) if (upperMsg.includes(kw)) { hasTestKeyword = true; break; }
  for (const bp of bodyParts) if (upperMsg.includes(bp)) { hasBodyPart = true; break; }
  
  // Improved name detection - avoid medical terms
  const nameRegex = /^[A-Za-z\s]{2,30}$/;
  const isMedicalTerm = lowerMsg.includes('scan') || lowerMsg.includes('test') || lowerMsg.includes('report');
  
  if (nameRegex.test(messageText) && !hasTestKeyword && wordCount <= 3 && !isMedicalTerm) {
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
  
  return { category: 'IGNORE', value: messageText, confidence: 0.5, reason: 'Default ignore' };
}

// ============================================
// ✅ TATA TELE WEBHOOK (Miss Call Only)
// ============================================
app.post('/tata-misscall-whatsapp', async (req, res) => {
  try {
    console.log('\n📞 TATA TELE WEBHOOK RECEIVED');
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.TATA_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    
    const callerNumberRaw = getCallerNumberFromPayload(req.body);
    if (!callerNumberRaw) return res.status(400).json({ error: 'Caller number not found' });
    
    const whatsappNumber = normalizeWhatsAppNumber(callerNumberRaw);
    const calledNumber = req.body.call_to_number || '';
    const branch = getMissCallBranchByCalledNumber(calledNumber);
    
    console.log(`📱 Caller: ${whatsappNumber}, Branch: ${branch.name}`);
    
    await missCallsCollection.insertOne({
      phoneNumber: whatsappNumber,
      calledNumber: calledNumber,
      branch: branch.name,
      createdAt: new Date(),
      istTime: getISTTime()
    });
    
    const existingPatient = await patientsCollection.findOne({ 
      patientPhone: whatsappNumber,
      source: 'misscall'
    });
    
    if (existingPatient) {
      await patientsCollection.updateOne(
        { _id: existingPatient._id },
        { 
          $set: { missCallTime: new Date(), missCallTimeIST: getISTTime(), updatedAt: new Date(), branch: branch.name, status: 'awaiting_branch', currentStage: STAGES.AWAITING_BRANCH },
          $inc: { missCallCount: 1 }
        }
      );
    } else {
      await patientsCollection.insertOne({
        chatId: `${whatsappNumber}_${branch.name}`,
        patientName: 'Miss Call Patient',
        patientPhone: whatsappNumber,
        branch: branch.name,
        testType: null,
        testDetails: null,
        patientMessages: [],
        sourceType: 'Miss Call',
        executiveNumber: branch.executive,
        status: 'awaiting_branch',
        missCallCount: 1,
        missCallTime: new Date(),
        missCallTimeIST: getISTTime(),
        createdAt: new Date(),
        updatedAt: new Date(),
        currentStage: STAGES.AWAITING_BRANCH,
        stageHistory: [{ stage: STAGES.AWAITING_BRANCH, timestamp: new Date() }],
        source: 'misscall'
      });
    }
    
    try {
      await sendWatiTemplateMessage(whatsappNumber, TEMPLATE_NAME, [{ name: '1', value: branch.name }]);
      console.log(`✅ Welcome template sent`);
    } catch (e) { console.error('❌ Template error:', e.message); }
    
    res.json({ success: true, whatsappNumber, branch: branch.name });
  } catch (error) {
    console.error('❌ Tata Tele error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ UNIFIED WATI WEBHOOK - Smart Source Detection (FIXED)
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
    if (msg.text) messageText = msg.text;
    else if (msg.body) messageText = msg.body;
    else if (msg.listReply) messageText = msg.listReply.title;
    else if (msg.buttonReply) messageText = msg.buttonReply.title;
    
    const text = (messageText || '').toUpperCase().trim();
    console.log(`📝 Message: "${text}" from ${senderNumber}`);
    
    // ============================================
    // ✅ STEP 1: SMART SOURCE DETECTION
    // ============================================
    const detectedBranch = detectGMBBranch(messageText);
    const isGMBInitial = isLikelyGMBMessage(messageText);
    
    // Check if patient already exists with source
    let existingGMBPatient = await patientsCollection.findOne({ 
      patientPhone: senderNumber, 
      source: 'gmb' 
    });
    let existingMissCallPatient = await patientsCollection.findOne({ 
      patientPhone: senderNumber, 
      source: 'misscall' 
    });
    
    // GMB Initial Message Flow
    if ((isGMBInitial && !existingMissCallPatient) || (existingGMBPatient && !existingMissCallPatient)) {
      console.log(`🌟 GMB FLOW DETECTED - Branch: ${detectedBranch || 'Unknown'}`);
      const branchName = detectedBranch || 'Naroda';
      const branchInfo = getGMBExecutiveByBranch(branchName);
      
      // Track lead in google_leads collection
      await googleLeadsCollection.insertOne({
        phoneNumber: senderNumber,
        branch: branchName,
        executiveNumber: branchInfo.executiveNumber,
        executiveName: branchInfo.executiveName,
        status: 'clicked',
        clickedAt: new Date(),
        clickedAtIST: getISTTime(),
        message: messageText.substring(0, 200),
        source: 'google_my_business'
      });
      
      // Create or update patient with source='gmb'
      let patient = existingGMBPatient;
      if (!patient) {
        const result = await patientsCollection.insertOne({
          patientName: 'Google Lead',
          patientPhone: senderNumber,
          branch: branchName,
          testType: null,
          testDetails: null,
          patientMessages: [{ text: messageText, timestamp: new Date() }],
          sourceType: 'Google My Business',
          executiveNumber: branchInfo.executiveNumber,
          executiveName: branchInfo.executiveName,
          status: 'pending',
          currentStage: STAGES.AWAITING_NAME,
          createdAt: new Date(),
          updatedAt: new Date(),
          source: 'gmb',
          gmbBranch: branchName
        });
        patient = { _id: result.insertedId };
        console.log(`✅ New GMB patient created for ${branchName}`);
      } else {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $set: { branch: branchName, executiveNumber: branchInfo.executiveNumber, executiveName: branchInfo.executiveName, updatedAt: new Date() },
            $push: { patientMessages: { text: messageText, timestamp: new Date() } }
          }
        );
        // Re-fetch updated patient
        patient = await patientsCollection.findOne({ _id: patient._id });
      }
      
      // Send welcome template
      await sendCustomerWelcome(senderNumber, branchName);
      console.log(`✅ Welcome template sent to ${senderNumber} for ${branchName}`);
      
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
    // ============================================
    // ✅ STEP 2: GET PATIENT WITH CORRECT SOURCE
    // ============================================
    let patient = await patientsCollection.findOne({ 
      patientPhone: senderNumber,
      $or: [
        { source: 'misscall' },
        { source: { $exists: false } }
      ]
    });
    
    // If still no patient, check if this is a reply to GMB
    if (!patient) {
      patient = await patientsCollection.findOne({ patientPhone: senderNumber, source: 'gmb' });
      if (patient) {
        // This is a GMB reply - handle accordingly
        console.log(`💬 GMB REPLY from ${senderNumber}`);
        
        // Update patient messages
        await patientsCollection.updateOne(
          { _id: patient._id },
          { $push: { patientMessages: { text: messageText, timestamp: new Date() } }, $set: { lastMessageAt: new Date() } }
        );
        
        // Update Google Lead status
        await googleLeadsCollection.updateOne(
          { phoneNumber: senderNumber },
          { $set: { status: 'patient_replied', patientRepliedAt: new Date(), patientReply: messageText } },
          { upsert: true }
        );
        
        // Process classification for GMB
        const context = { currentStage: patient.currentStage };
        const result = await classifyMessage(messageText, context);
        
        if (result.confidence >= 0.8) {
          if (result.category === 'PATIENT_NAME') {
            await patientsCollection.updateOne(
              { _id: patient._id },
              { $set: { patientName: result.value, currentStage: STAGES.AWAITING_TEST_TYPE } }
            );
            patient = await patientsCollection.findOne({ _id: patient._id });
            console.log(`✅ GMB Name saved: ${result.value}`);
          }
          else if (result.category === 'TEST_TYPE') {
            await patientsCollection.updateOne(
              { _id: patient._id },
              { $set: { testType: result.value, currentStage: STAGES.AWAITING_TEST_DETAILS } }
            );
            patient = await patientsCollection.findOne({ _id: patient._id });
            console.log(`✅ GMB Test type saved: ${result.value}`);
          }
          else if (result.category === 'TEST_DETAILS') {
            await patientsCollection.updateOne(
              { _id: patient._id },
              { $set: { testDetails: result.value, currentStage: STAGES.EXECUTIVE_NOTIFIED } }
            );
            patient = await patientsCollection.findOne({ _id: patient._id });
            console.log(`✅ GMB Test details saved: ${result.value}`);
            
            // Get or create session
            const session = await getOrCreateChatSession(patient);
            const branchInfo = getGMBExecutiveByBranch(patient.branch);
            
            try {
              await sendGMBLeadNotification(
                branchInfo.executiveNumber,
                branchInfo.executiveName,
                patient.patientName || 'Google Lead',
                senderNumber,
                patient.branch || 'Main Branch',
                result.value,
                patient.testType || 'Not specified',
                session.sessionToken
              );
              console.log(`✅ GMB Executive notification sent to ${branchInfo.executiveName}`);
            } catch (notifError) {
              console.error('❌ GMB Notification failed:', notifError.message);
            }
          }
        }
        
        await markMessageProcessed(msgId);
        return res.sendStatus(200);
      }
      
      // No patient found - create as misscall
      if (!patient) {
        const result = await patientsCollection.insertOne({
          patientPhone: senderNumber,
          patientName: 'Miss Call Patient',
          patientMessages: [{ text: messageText, timestamp: new Date() }],
          testType: null,
          testDetails: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          currentStage: STAGES.AWAITING_BRANCH,
          source: 'misscall'
        });
        patient = { _id: result.insertedId };
        console.log(`✅ New misscall patient created for ${senderNumber}`);
      }
    }
    
    // ============================================
    // ✅ STEP 3: UPDATE PATIENT MESSAGES
    // ============================================
    await patientsCollection.updateOne(
      { _id: patient._id },
      { $push: { patientMessages: { text: messageText, timestamp: new Date() } }, $set: { lastMessageAt: new Date() } }
    );
    
    // Re-fetch updated patient
    patient = await patientsCollection.findOne({ _id: patient._id });
    
    // ============================================
    // ✅ STEP 4: CLASSIFICATION & EXECUTIVE NOTIFICATION
    // ============================================
    const context = { currentStage: patient.currentStage };
    const result = await classifyMessage(messageText, context);
    
    if (result.confidence >= 0.8) {
      if (result.category === 'PATIENT_NAME') {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { $set: { patientName: result.value, currentStage: STAGES.AWAITING_TEST_TYPE } }
        );
        patient = await patientsCollection.findOne({ _id: patient._id });
        console.log(`✅ Name saved: ${result.value}`);
      }
      else if (result.category === 'TEST_TYPE') {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { $set: { testType: result.value, currentStage: STAGES.AWAITING_TEST_DETAILS } }
        );
        patient = await patientsCollection.findOne({ _id: patient._id });
        console.log(`✅ Test type saved: ${result.value}`);
      }
      else if (result.category === 'TEST_DETAILS') {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { $set: { testDetails: result.value, currentStage: STAGES.EXECUTIVE_NOTIFIED } }
        );
        patient = await patientsCollection.findOne({ _id: patient._id });
        console.log(`✅ Test details saved: ${result.value}`);
        
        // Get or create session
        const session = await getOrCreateChatSession(patient);
        
        // Send notification based on source
        if (patient.source === 'gmb') {
          const branchInfo = getGMBExecutiveByBranch(patient.branch);
          try {
            await sendGMBLeadNotification(
              branchInfo.executiveNumber,
              branchInfo.executiveName,
              patient.patientName || 'Google Lead',
              senderNumber,
              patient.branch || 'Main Branch',
              result.value,
              patient.testType || 'Not specified',
              session.sessionToken
            );
            console.log(`✅ GMB Executive notification sent to ${branchInfo.executiveName}`);
          } catch (notifError) {
            console.error('❌ GMB Notification failed:', notifError.message);
          }
        } else {
          const executiveNumber = getMissCallExecutiveNumber(patient.branch);
          try {
            await sendLeadNotification(
              executiveNumber,
              patient.patientName || 'Patient',
              senderNumber,
              patient.branch || 'Main Branch',
              result.value,
              patient.testType || 'Not specified',
              session.sessionToken
            );
            console.log(`✅ Miss Call Executive notification sent to ${executiveNumber}`);
          } catch (notifError) {
            console.error('❌ Miss Call Notification failed:', notifError.message);
          }
        }
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
// ✅ GMB WEBHOOK - Alternative endpoint
// ============================================
app.post('/gmb-webhook', async (req, res) => {
  try {
    console.log('\n📍 GMB WEBHOOK RECEIVED');
    const { from, waId, whatsappNumber, text, body } = req.body;
    const patientPhone = normalizeWhatsAppNumber(from || waId || whatsappNumber);
    if (!patientPhone) return res.status(400).json({ error: 'No phone number' });
    
    const message = text || body || '';
    const branchName = detectGMBBranch(message) || 'Naroda';
    const branchInfo = getGMBExecutiveByBranch(branchName);
    
    console.log(`📍 Patient: ${patientPhone}, Branch: ${branchName}, Executive: ${branchInfo.executiveName}`);
    
    await googleLeadsCollection.insertOne({
      phoneNumber: patientPhone, branch: branchName, executiveNumber: branchInfo.executiveNumber,
      executiveName: branchInfo.executiveName, status: 'clicked', clickedAt: new Date(),
      clickedAtIST: getISTTime(), message: message.substring(0, 200), source: 'google_my_business'
    });
    
    let patient = await patientsCollection.findOne({ patientPhone, source: 'gmb' });
    if (!patient) {
      await patientsCollection.insertOne({
        patientName: 'Google Lead', patientPhone, branch: branchName,
        testType: null, testDetails: null, patientMessages: [{ text: message, timestamp: new Date() }],
        sourceType: 'Google My Business', executiveNumber: branchInfo.executiveNumber,
        executiveName: branchInfo.executiveName, status: 'pending', currentStage: STAGES.AWAITING_NAME,
        createdAt: new Date(), updatedAt: new Date(), source: 'gmb', gmbBranch: branchName
      });
    }
    
    await sendCustomerWelcome(patientPhone, branchName);
    res.json({ success: true, branch: branchName, executive: branchInfo.executiveName });
  } catch (error) {
    console.error('❌ GMB webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ GET BRANCH LINKS FOR GMB
// ============================================
app.get('/gmb-links', async (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head><title>GMB Branch Links</title><meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;padding:20px}.container{max-width:1200px;margin:0 auto}h1{color:white;text-align:center;margin-bottom:10px}.subtitle{color:white;text-align:center;margin-bottom:30px}.links-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}.link-card{background:white;border-radius:16px;padding:20px;box-shadow:0 10px 25px rgba(0,0,0,0.1)}.branch-name{font-size:1.4em;font-weight:bold;color:#075e54}.executive-info{background:#e8f5e9;padding:5px 10px;border-radius:8px;margin:10px 0;font-size:0.8em}.link{background:#f0f2f5;padding:12px;border-radius:10px;word-break:break-all;font-size:0.7em;margin:15px 0;font-family:monospace}.copy-btn{background:#075e54;color:white;border:none;padding:8px 20px;border-radius:8px;cursor:pointer}.footer{text-align:center;color:white;margin-top:40px;padding:20px}
  </style>
  <script>function copyLink(link,branch){navigator.clipboard.writeText(link);alert('✅ Link for '+branch+' copied!')}</script>
  </head>
  <body>
    <div class="container"><h1>🏥 Google My Business - WhatsApp Links</h1><div class="subtitle">WATI Number: ${WATI_NUMBER}</div>
    <div class="links-grid">
      ${Object.entries(GMB_BRANCHES).map(([key, config]) => {
        const link = `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20${config.name}%20branch`;
        return `<div class="link-card"><div class="branch-name">📍 ${config.name}</div>
        <div class="executive-info">👤 Executive: ${config.executiveName} (${config.executiveNumber})</div>
        <div class="link">${link}</div>
        <button class="copy-btn" onclick="copyLink('${link}','${config.name}')">📋 Copy Link</button></div>`;
      }).join('')}
    </div>
    <div class="footer"><strong>📌 How It Works:</strong><br>Patient clicks link → WhatsApp opens → Welcome template → Lead COUNTED → Executive notified</div></div>
  </body>
  </html>`;
  res.send(html);
});

// ============================================
// ✅ HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
  res.json({
    success: true,
    uptime: process.uptime(),
    mongodb: 'connected',
    system: 'Unified Miss Call + GMB System',
    time: getISTTime()
  });
});

// ============================================
// ✅ HOME ROUTE
// ============================================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Unified UIC Support System (Miss Call + GMB)',
    version: '14.0.0',
    endpoints: {
      tata_misscall: '/tata-misscall-whatsapp',
      wati_webhook: '/wati-webhook',
      gmb_webhook: '/gmb-webhook',
      gmb_links: '/gmb-links',
      health: '/health',
      admin_dashboard: '/admin'
    }
  });
});

// ============================================
// ✅ DASHBOARD ROUTE
// ============================================
const dashboardRouter = require('./dashboard');
app.use('/admin', (req, res, next) => {
  if (!patientsCollection || !processedCollection) return res.status(503).send('Dashboard unavailable');
  req.patientsCollection = patientsCollection;
  req.processedCollection = processedCollection;
  req.missCallsCollection = missCallsCollection;
  req.chatSessionsCollection = chatSessionsCollection;
  req.chatMessagesCollection = chatMessagesCollection;
  req.followupCollection = followupCollection;
  req.googleLeadsCollection = googleLeadsCollection;
  req.STAGES = STAGES;
  req.PORT = PORT;
  next();
}, dashboardRouter);

// ============================================
// ✅ ESCAPE HTML HELPER
// ============================================
function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================
// ✅ START SERVER
// ============================================
async function startServer() {
  try {
    console.log('🔄 Starting Unified Server...');
    await connectDB();
    
    const HOST = '0.0.0.0';
    app.listen(PORT, HOST, () => {
      console.log('\n' + '='.repeat(60));
      console.log(`✅ UNIFIED SERVER RUNNING ON PORT ${PORT}`);
      console.log(`📍 WATI Webhook: ${SELF_URL}/wati-webhook`);
      console.log(`📍 GMB Webhook: ${SELF_URL}/gmb-webhook`);
      console.log(`📍 Miss Call Webhook: ${SELF_URL}/tata-misscall-whatsapp`);
      console.log(`📍 GMB Links: ${SELF_URL}/gmb-links`);
      console.log(`📍 Admin Dashboard: ${SELF_URL}/admin`);
      console.log('='.repeat(60) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
