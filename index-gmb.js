require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const cron = require('node-cron');

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

function getISTDate(date = new Date()) {
  return date.toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
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
const PORT = process.env.PORT || 3001;
const WATI_TOKEN = process.env.WATI_TOKEN;
const WATI_BASE_URL = process.env.WATI_BASE_URL;
const MONGODB_URI = process.env.MONGODB_URI;

// WATI Number (Same for all branches)
const WATI_NUMBER = '919725504245';

// Executive Numbers
const EXECUTIVES = {
  'Aditi': '8488931212',
  'Khyati': '7490029085',
  'Jay': '9274682553',
  'Mital': '9558591212',
  'Manager': '7698011233'
};

// Google Lead Template Names
const GOOGLE_LEAD_TEMPLATE = 'google_lead_notification_v1';
const GOOGLE_FOLLOWUP_NO_REPLY = 'google_followup_no_reply';
const GOOGLE_FOLLOWUP_WAITING = 'google_followup_waiting';
const GOOGLE_EXECUTIVE_REPORT = 'google_executive_report';
const GOOGLE_ESCALATION_MANAGER = 'google_escalation_manager';
const TEXT_MESSAGE_TEMPLATE = 'text_message';
const CUSTOMER_WELCOME_TEMPLATE = 'gmb_customer_welcome';

// Keep-alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://tata-wati-webhook.onrender.com';

if (!WATI_TOKEN || !WATI_BASE_URL) {
  console.error('❌ Missing WATI configuration in .env');
  process.exit(1);
}

// ============================================
// ✅ 20 BRANCHES CONFIGURATION
// ============================================
const BRANCHES_CONFIG = {
  // Aditi's Branches (8488931212)
  'naroda': {
    name: 'Naroda', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Aditi,
    executiveName: 'Aditi', displayName: 'Usmanpura Imaging Centre, Naroda',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Naroda%20branch`
  },
  'ahmedabad': {
    name: 'Ahmedabad', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Aditi,
    executiveName: 'Aditi', displayName: 'Usmanpura Imaging Centre Ahmedabad',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Ahmedabad%20branch`
  },
  'gandhinagar': {
    name: 'Gandhinagar', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Aditi,
    executiveName: 'Aditi', displayName: 'Usmanpura Imaging Centre, Gandhinagar',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Gandhinagar%20branch`
  },
  'sabarmati': {
    name: 'Sabarmati', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Aditi,
    executiveName: 'Aditi', displayName: 'Usmanpura Imaging Centre, Sabarmati Branch',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Sabarmati%20branch`
  },
  'anand': {
    name: 'Anand', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Aditi,
    executiveName: 'Aditi', displayName: 'Usmanpura Imaging Centre Anand',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Anand%20branch`
  },
  
  // Khyati's Branches (7490029085)
  'usmanpura': {
    name: 'Usmanpura', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Khyati,
    executiveName: 'Khyati', displayName: 'Usmanpura Imaging Centre - Usmanpura Branch',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Usmanpura%20branch`
  },
  'satellite': {
    name: 'Satellite', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Khyati,
    executiveName: 'Khyati', displayName: 'Usmanpura Imaging Centre Satellite',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Satellite%20branch`
  },
  'nadiad': {
    name: 'Nadiad', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Khyati,
    executiveName: 'Khyati', displayName: 'Usmanpura Imaging Centre Nadiad',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Nadiad%20branch`
  },
  'jamnagar': {
    name: 'Jamnagar', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Khyati,
    executiveName: 'Khyati', displayName: 'Usmanpura Imaging Centre Jamnagar',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Jamnagar%20branch`
  },
  'bhavnagar': {
    name: 'Bhavnagar', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Khyati,
    executiveName: 'Khyati', displayName: 'Usmanpura Imaging Centre Bhavnagar',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Bhavnagar%20branch`
  },
  
  // Jay's Branches (9274682553)
  'bapunagar': {
    name: 'Bapunagar', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Jay,
    executiveName: 'Jay', displayName: 'Usmanpura Imaging Centre, Bapunagar',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Bapunagar%20branch`
  },
  'juhapura': {
    name: 'Juhapura', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Jay,
    executiveName: 'Jay', displayName: 'Usmanpura Imaging Centre JUHAPURA',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Juhapura%20branch`
  },
  'surat': {
    name: 'Surat', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Jay,
    executiveName: 'Jay', displayName: 'Usmanpura Imaging Centre Surat',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Surat%20branch`
  },
  'changodar': {
    name: 'Changodar', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Jay,
    executiveName: 'Jay', displayName: 'Usmanpura Imaging Centre Changodar',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Changodar%20branch`
  },
  'bareja': {
    name: 'Bareja', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Jay,
    executiveName: 'Jay', displayName: 'Usmanpura Imaging Centre Bareja',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Bareja%20branch`
  },
  
  // Mital's Branches (9558591212)
  'vadaj': {
    name: 'Vadaj', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Mital,
    executiveName: 'Mital', displayName: 'Usmanpura Imaging Centre, Vadaj',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Vadaj%20branch`
  },
  'maninagar': {
    name: 'Maninagar', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Mital,
    executiveName: 'Mital', displayName: 'Usmanpura Imaging Centre, Maninagar Branch',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Maninagar%20branch`
  },
  'rajkot': {
    name: 'Rajkot', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Mital,
    executiveName: 'Mital', displayName: 'Usmanpura Imaging Centre Mavdi, Rajkot',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Rajkot%20branch`
  },
  'vadodara': {
    name: 'Vadodara', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Mital,
    executiveName: 'Mital', displayName: 'Usmanpura Imaging Centre Vadodara',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Vadodara%20branch`
  },
  'morbi': {
    name: 'Morbi', watiNumber: WATI_NUMBER, executiveNumber: EXECUTIVES.Mital,
    executiveName: 'Mital', displayName: 'UIC Imaging and Diagnostics Centre Morbi',
    gmbLink: `https://wa.me/${WATI_NUMBER}?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Morbi%20branch`
  }
};

// ============================================
// ✅ DETECT BRANCH FROM MESSAGE
// ============================================
function detectBranchFromMessage(message) {
  const msgLower = (message || '').toLowerCase();
  
  const branchKeywords = {
    'naroda': 'Naroda', 'ahmedabad': 'Ahmedabad', 'gandhinagar': 'Gandhinagar',
    'sabarmati': 'Sabarmati', 'anand': 'Anand', 'usmanpura': 'Usmanpura',
    'satellite': 'Satellite', 'nadiad': 'Nadiad', 'jamnagar': 'Jamnagar',
    'bhavnagar': 'Bhavnagar', 'bapunagar': 'Bapunagar', 'juhapura': 'Juhapura',
    'surat': 'Surat', 'changodar': 'Changodar', 'bareja': 'Bareja',
    'vadaj': 'Vadaj', 'maninagar': 'Maninagar', 'rajkot': 'Rajkot',
    'vadodara': 'Vadodara', 'morbi': 'Morbi'
  };
  
  for (const [keyword, branch] of Object.entries(branchKeywords)) {
    if (msgLower.includes(keyword)) return branch;
  }
  
  return 'Naroda';
}

// ============================================
// ✅ DATABASE CONNECTION
// ============================================
let db;
let processedCollection;
let patientsCollection;
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
    chatSessionsCollection = db.collection('chat_sessions');
    chatMessagesCollection = db.collection('chat_messages');
    followupCollection = db.collection('followups');
    googleLeadsCollection = db.collection('google_leads');
    
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await patientsCollection.createIndex({ patientPhone: 1, source: 1 });
    await googleLeadsCollection.createIndex({ clickedAt: -1 });
    await googleLeadsCollection.createIndex({ branch: 1 });
    await followupCollection.createIndex({ patientId: 1, type: 1 });
    
    console.log('✅ Indexes created');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    throw error;
  }
}

// ============================================
// ✅ HELPER FUNCTIONS
// ============================================
function normalizeWhatsAppNumber(number) {
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

function getExecutiveNumber(branchName) {
  const branch = BRANCHES_CONFIG[branchName.toLowerCase()];
  return branch ? branch.executiveNumber : EXECUTIVES.Aditi;
}

function getExecutiveName(branchName) {
  const branch = BRANCHES_CONFIG[branchName.toLowerCase()];
  return branch ? branch.executiveName : 'Aditi';
}

// ============================================
// ✅ STAGE TRACKING CONSTANTS
// ============================================
const STAGES = {
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
// ✅ SEND GOOGLE LEAD NOTIFICATION TO EXECUTIVE
// ============================================
async function sendGoogleLeadNotification(executiveNumber, executiveName, patientName, patientPhone, branch, testDetails, testType, chatToken) {
  console.log(`📤 Sending GOOGLE LEAD notification to executive ${executiveName} (${executiveNumber})`);
  
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

// ============================================
// ✅ SEND CUSTOMER WELCOME TEMPLATE
// ============================================
async function sendCustomerWelcome(whatsappNumber, branchName) {
  console.log(`📤 Sending customer welcome template to ${whatsappNumber} for ${branchName}`);
  const branchDisplay = BRANCHES_CONFIG[branchName.toLowerCase()]?.displayName || branchName;
  return await sendWatiTemplateMessage(whatsappNumber, CUSTOMER_WELCOME_TEMPLATE, [{ name: "1", value: branchDisplay }]);
}

// ============================================
// ✅ GMB WEBHOOK - MAIN ENDPOINT
// ============================================
app.post('/gmb-webhook', async (req, res) => {
  try {
    console.log('\n📍 ========== GMB WEBHOOK RECEIVED ==========');
    console.log(`⏰ Time: ${getISTTime()}`);
    console.log('📝 Request body:', JSON.stringify(req.body, null, 2));
    
    const { from, waId, whatsappNumber, text, body } = req.body;
    const patientPhone = normalizeWhatsAppNumber(from || waId || whatsappNumber);
    
    if (!patientPhone) {
      console.log('❌ No phone number found');
      return res.status(400).json({ error: 'No phone number found' });
    }
    
    const incomingMessage = text || body || '';
    const branchName = detectBranchFromMessage(incomingMessage);
    const executiveNumber = getExecutiveNumber(branchName);
    const executiveName = getExecutiveName(branchName);
    
    console.log(`📍 Patient: ${patientPhone}`);
    console.log(`📍 Branch: ${branchName}`);
    console.log(`📍 Executive: ${executiveName} (${executiveNumber})`);
    console.log(`📝 Message: ${incomingMessage}`);
    
    // ✅ TRACK GOOGLE LEAD - COUNT CLICK
    const leadRecord = {
      phoneNumber: patientPhone,
      branch: branchName,
      executiveNumber: executiveNumber,
      executiveName: executiveName,
      status: 'clicked',
      clickedAt: new Date(),
      clickedAtIST: getISTTime(),
      message: incomingMessage.substring(0, 200),
      source: 'google_my_business'
    };
    
    const leadResult = await googleLeadsCollection.insertOne(leadRecord);
    console.log(`✅ Google Lead COUNTED for ${branchName} branch (ID: ${leadResult.insertedId})`);
    console.log(`📊 Total Google Leads so far: ${await googleLeadsCollection.countDocuments()}`);
    
    // Create or update patient
    let patient = await patientsCollection.findOne({ patientPhone: patientPhone });
    
    if (!patient) {
      const result = await patientsCollection.insertOne({
        patientName: 'Google Lead',
        patientPhone: patientPhone,
        branch: branchName,
        testType: null,
        testDetails: null,
        patientMessages: [{ text: incomingMessage, timestamp: new Date() }],
        sourceType: 'Google My Business',
        executiveNumber: executiveNumber,
        executiveName: executiveName,
        status: 'pending',
        currentStage: STAGES.AWAITING_NAME,
        createdAt: new Date(),
        updatedAt: new Date(),
        source: 'gmb',
        gmbBranch: branchName,
        googleLeadId: leadResult.insertedId
      });
      patient = { _id: result.insertedId };
      console.log(`✅ New patient created for Google lead`);
    } else {
      await patientsCollection.updateOne(
        { _id: patient._id },
        { 
          $set: { 
            branch: branchName,
            executiveNumber: executiveNumber,
            executiveName: executiveName,
            updatedAt: new Date(),
            source: 'gmb',
            gmbBranch: branchName
          },
          $push: { patientMessages: { text: incomingMessage, timestamp: new Date() } }
        }
      );
      console.log(`✅ Existing patient updated`);
    }
    
    // Create chat session token
    let sessionToken = patient.chatSessionToken;
    if (!sessionToken) {
      sessionToken = crypto.randomBytes(16).toString('hex');
      await patientsCollection.updateOne(
        { _id: patient._id },
        { $set: { chatSessionToken: sessionToken } }
      );
    }
    
    // Update lead with patient ID
    await googleLeadsCollection.updateOne(
      { _id: leadResult.insertedId },
      { $set: { patientId: patient._id, status: 'template_sent', templateSentAt: new Date() } }
    );
    
    // ✅ SEND CUSTOMER WELCOME TEMPLATE
    await sendCustomerWelcome(patientPhone, branchName);
    console.log(`✅ Customer welcome template sent to ${patientPhone}`);
    
    res.json({ 
      success: true, 
      message: 'GMB lead processed successfully',
      branch: branchName,
      executive: executiveName,
      patientPhone: patientPhone,
      leadId: leadResult.insertedId,
      leadCount: await googleLeadsCollection.countDocuments()
    });
    
  } catch (error) {
    console.error('❌ GMB webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ WATI WEBHOOK - FOR PATIENT REPLIES (BOT CLASSIFICATION)
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('\n📨 WATI WEBHOOK RECEIVED (GMB System)');
    
    const msg = req.body;
    const msgId = msg.id || msg.messageId;
    if (!msgId) return res.sendStatus(200);
    
    const existing = await processedCollection.findOne({ messageId: msgId });
    if (existing) return res.sendStatus(200);
    
    const senderNumber = msg.whatsappNumber || msg.from || msg.waId;
    if (!senderNumber) {
      await processedCollection.insertOne({ messageId: msgId, processedAt: new Date() });
      return res.sendStatus(200);
    }
    
    let messageText = '';
    if (msg.text) messageText = msg.text;
    else if (msg.body) messageText = msg.body;
    else if (msg.listReply) messageText = msg.listReply.title;
    else if (msg.buttonReply) messageText = msg.buttonReply.title;
    
    const text = (messageText || '').toUpperCase().trim();
    console.log(`📝 Processed message: "${text}" from ${senderNumber}`);
    
    // Check if sender is executive
    const isExecutive = Object.values(EXECUTIVES).includes(senderNumber);
    const isManager = senderNumber === EXECUTIVES.Manager;
    
    // ============================================
    // ✅ HANDLE EXECUTIVE BUTTONS
    // ============================================
    if (isExecutive && (text === 'CONVERT DONE' || text === 'WAITING' || text === 'NOT CONVERT')) {
      let patient = await patientsCollection.findOne({ 
        executiveNumber: senderNumber,
        source: 'gmb',
        status: { $in: ['pending', 'waiting', 'awaiting_name', 'awaiting_test_type', 'awaiting_test_details'] }
      });
      
      if (patient) {
        if (text === 'CONVERT DONE') {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { 
              $set: { 
                status: 'converted',
                currentStage: STAGES.CONVERTED,
                executiveActionTaken: true,
                convertedAt: new Date()
              }
            }
          );
          await googleLeadsCollection.updateOne(
            { phoneNumber: patient.patientPhone },
            { $set: { status: 'converted', convertedAt: new Date() } }
          );
          await sendWatiTemplateMessage(senderNumber, TEXT_MESSAGE_TEMPLATE, 
            [{ name: "1", value: "✅ Google Lead marked as converted!" }]);
        }
        else if (text === 'WAITING') {
          const waitingCount = (patient.googleWaitingFollowupCount || 0) + 1;
          await patientsCollection.updateOne(
            { _id: patient._id },
            { 
              $set: { 
                status: 'waiting',
                currentStage: STAGES.WAITING,
                googleWaitingFollowupCount: waitingCount,
                updatedAt: new Date()
              }
            }
          );
          await sendWatiTemplateMessage(senderNumber, TEXT_MESSAGE_TEMPLATE, 
            [{ name: "1", value: "⏳ Google Lead marked as waiting. Next reminder in 1 hour." }]);
        }
        else if (text === 'NOT CONVERT') {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { 
              $set: { 
                status: 'not_converted',
                currentStage: STAGES.NOT_CONVERTED,
                executiveActionTaken: true
              }
            }
          );
          await googleLeadsCollection.updateOne(
            { phoneNumber: patient.patientPhone },
            { $set: { status: 'not_converted', notConvertedAt: new Date() } }
          );
          await sendWatiTemplateMessage(senderNumber, TEXT_MESSAGE_TEMPLATE, 
            [{ name: "1", value: "❌ Google Lead marked as not converted." }]);
        }
      }
    }
    
    // Handle READ DONE
    else if (isExecutive && text === 'READ DONE') {
      await sendWatiTemplateMessage(senderNumber, TEXT_MESSAGE_TEMPLATE, 
        [{ name: "1", value: "✅ Thanks! Keep up the great work with Google Leads! 🎉" }]);
    }
    
    // ============================================
    // ✅ HANDLE PATIENT REPLIES (BOT CLASSIFICATION)
    // ============================================
    else if (!isExecutive && !isManager && messageText) {
      let patient = await patientsCollection.findOne({ patientPhone: senderNumber, source: 'gmb' });
      
      if (patient) {
        await patientsCollection.updateOne(
          { _id: patient._id },
          { 
            $push: { patientMessages: { text: messageText, timestamp: new Date() } },
            $set: { lastMessageAt: new Date(), updatedAt: new Date() }
          }
        );
        
        // Update Google Lead status
        const lead = await googleLeadsCollection.findOne({ phoneNumber: senderNumber });
        if (lead && lead.status === 'template_sent') {
          await googleLeadsCollection.updateOne(
            { _id: lead._id },
            { $set: { status: 'patient_replied', patientRepliedAt: new Date(), patientReply: messageText } }
          );
        }
        
        // Bot Classification
        if (patient.currentStage === STAGES.AWAITING_NAME) {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { $set: { patientName: messageText, currentStage: STAGES.AWAITING_TEST_TYPE } }
          );
          console.log(`✅ Name saved: ${messageText}`);
        }
        else if (patient.currentStage === STAGES.AWAITING_TEST_TYPE) {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { $set: { testType: messageText, currentStage: STAGES.AWAITING_TEST_DETAILS } }
          );
          console.log(`✅ Test type saved: ${messageText}`);
        }
        else if (patient.currentStage === STAGES.AWAITING_TEST_DETAILS) {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { $set: { testDetails: messageText, currentStage: STAGES.EXECUTIVE_NOTIFIED } }
          );
          console.log(`✅ Test details saved: ${messageText}`);
          
          // Send notification to executive
          const executiveNumber = getExecutiveNumber(patient.branch);
          const executiveName = getExecutiveName(patient.branch);
          const sessionToken = patient.chatSessionToken;
          
          await sendGoogleLeadNotification(
            executiveNumber,
            executiveName,
            patient.patientName || 'Google Lead',
            senderNumber,
            patient.branch || 'Main Branch',
            messageText,
            patient.testType || 'Not specified',
            sessionToken
          );
          
          console.log(`✅ Executive notification sent to ${executiveName}`);
        }
      }
    }
    
    await processedCollection.insertOne({ messageId: msgId, processedAt: new Date() });
    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.sendStatus(200);
  }
});

// ============================================
// ✅ GET BRANCH LINKS FOR GMB
// ============================================
app.get('/gmb-links', async (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>GMB Branch Links</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;padding:20px}.container{max-width:1200px;margin:0 auto}h1{color:white;text-align:center;margin-bottom:10px}.subtitle{color:white;text-align:center;margin-bottom:30px}.links-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}.link-card{background:white;border-radius:16px;padding:20px;box-shadow:0 10px 25px rgba(0,0,0,0.1)}.branch-name{font-size:1.4em;font-weight:bold;color:#075e54}.executive-info{background:#e8f5e9;padding:5px 10px;border-radius:8px;margin:10px 0;font-size:0.8em}.link{background:#f0f2f5;padding:12px;border-radius:10px;word-break:break-all;font-size:0.7em;margin:15px 0;font-family:monospace}.copy-btn{background:#075e54;color:white;border:none;padding:8px 20px;border-radius:8px;cursor:pointer}.footer{text-align:center;color:white;margin-top:40px;padding:20px}
    </style>
    <script>function copyLink(link,branch){navigator.clipboard.writeText(link);alert('✅ Link for '+branch+' copied!')}</script>
  </head>
  <body>
    <div class="container">
      <h1>🏥 Google My Business - WhatsApp Links</h1>
      <div class="subtitle">WATI Number: ${WATI_NUMBER}</div>
      <div class="links-grid">
        ${Object.entries(BRANCHES_CONFIG).map(([key,config]) => `
          <div class="link-card">
            <div class="branch-name">📍 ${config.name}</div>
            <div class="executive-info">👤 Executive: ${config.executiveName} (${config.executiveNumber})</div>
            <div class="link">${config.gmbLink}</div>
            <button class="copy-btn" onclick="copyLink('${config.gmbLink}','${config.name}')">📋 Copy Link</button>
          </div>
        `).join('')}
      </div>
      <div class="footer"><strong>📌 How It Works:</strong><br>Patient clicks link → WhatsApp opens → Welcome template → Lead COUNTED → Executive notified</div>
    </div>
  </body>
  </html>`;
  res.send(html);
});

// ============================================
// ✅ API ENDPOINTS
// ============================================
app.get('/api/google-lead-stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const totalClicks = await googleLeadsCollection.countDocuments();
    const todayClicks = await googleLeadsCollection.countDocuments({ clickedAt: { $gte: today } });
    const branchStats = await googleLeadsCollection.aggregate([{ $group: { _id: '$branch', count: { $sum: 1 } } }]).toArray();
    const executiveStats = await googleLeadsCollection.aggregate([{ $group: { _id: '$executiveName', count: { $sum: 1 } } }]).toArray();
    const statusStats = await googleLeadsCollection.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
    
    res.json({ success: true, totalClicks, todayClicks, branchStats, executiveStats, statusStats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/last-leads', async (req, res) => {
  try {
    const leads = await googleLeadsCollection.find().sort({ clickedAt: -1 }).limit(10).toArray();
    const total = await googleLeadsCollection.countDocuments();
    res.json({ total, last10Leads: leads });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ============================================
// ✅ TEST ENDPOINT
// ============================================
app.get('/test-webhook', async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>GMB Webhook Test</title><style>body{font-family:monospace;padding:20px;background:#0f172a;color:white}pre{background:#1e293b;padding:15px;border-radius:8px}button{background:#10b981;padding:10px 20px;border:none;border-radius:8px;cursor:pointer;margin:10px 0}input{padding:8px;margin:5px;border-radius:5px;width:250px}</style></head>
    <body>
      <h1>🔍 GMB Webhook Test Tool</h1>
      <div><p>Webhook URL: <code>${SELF_URL}:${PORT}/gmb-webhook</code></p></div>
      <div><h2>Manual Test</h2><input type="text" id="phone" placeholder="Phone Number" value="919825086011"><input type="text" id="branch" placeholder="Branch" value="Naroda"><button onclick="test()">📤 Send Test</button><pre id="result"></pre></div>
      <div><h2>Recent Leads</h2><button onclick="fetchLeads()">🔄 Refresh</button><pre id="leads">Loading...</pre></div>
      <script>
        async function test(){const phone=document.getElementById('phone').value,branch=document.getElementById('branch').value;const res=await fetch('/gmb-webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:phone,waId:phone,whatsappNumber:phone,text:'Hi I want to book an appointment at '+branch+' branch'})});const data=await res.json();document.getElementById('result').innerHTML=JSON.stringify(data,null,2);fetchLeads();}
        async function fetchLeads(){const res=await fetch('/api/last-leads');const data=await res.json();document.getElementById('leads').innerHTML=JSON.stringify(data,null,2);}
        fetchLeads();
      </script>
    </body>
    </html>
  `);
});

// ============================================
// ✅ HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
  res.json({
    success: true,
    uptime: process.uptime(),
    mongodb: 'connected',
    system: 'GMB WhatsApp System',
    watiNumber: WATI_NUMBER,
    branches: Object.keys(BRANCHES_CONFIG).length,
    time: getISTTime()
  });
});

// ============================================
// ✅ HOME ROUTE
// ============================================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 GMB WhatsApp System',
    version: '6.0.0',
    watiNumber: WATI_NUMBER,
    endpoints: {
      gmb_webhook: '/gmb-webhook',
      gmb_links: '/gmb-links',
      google_lead_stats: '/api/google-lead-stats',
      test_webhook: '/test-webhook',
      health: '/health'
    }
  });
});

// ============================================
// ✅ START SERVER
// ============================================
async function startServer() {
  try {
    console.log('🔄 Starting GMB Server...');
    await connectDB();
    
    const HOST = '0.0.0.0';
    app.listen(PORT, HOST, () => {
      console.log('\n' + '='.repeat(60));
      console.log(`✅ GMB SYSTEM RUNNING ON PORT ${PORT}`);
      console.log(`📍 WATI Number: ${WATI_NUMBER}`);
      console.log(`📍 Branches: ${Object.keys(BRANCHES_CONFIG).length}`);
      console.log(`📍 Executives:`);
      Object.entries(EXECUTIVES).forEach(([name, number]) => {
        console.log(`   - ${name}: ${number}`);
      });
      console.log(`📍 GMB Webhook: ${SELF_URL}:${PORT}/gmb-webhook`);
      console.log(`📍 Test Page: ${SELF_URL}:${PORT}/test-webhook`);
      console.log('='.repeat(60) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
