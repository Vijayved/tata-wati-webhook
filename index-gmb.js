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
  // Night time: 8 PM (20) to 8 AM (8)
  return hours >= 20 || hours < 8;
}

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3001;
const WATI_TOKEN = process.env.WATI_TOKEN;
const WATI_BASE_URL = process.env.WATI_BASE_URL;
const MONGODB_URI = process.env.MONGODB_URI;

// Google Lead Template Names
const GOOGLE_LEAD_TEMPLATE = 'google_lead_notification_v1';
const GOOGLE_FOLLOWUP_NO_REPLY = 'google_followup_no_reply';
const GOOGLE_FOLLOWUP_WAITING = 'google_followup_waiting';
const GOOGLE_EXECUTIVE_REPORT = 'google_executive_report';
const GOOGLE_ESCALATION_MANAGER = 'google_escalation_manager';
const TEXT_MESSAGE_TEMPLATE = 'text_message';

// Keep-alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://tata-wati-webhook.onrender.com';

if (!WATI_TOKEN || !WATI_BASE_URL) {
  console.error('❌ Missing WATI configuration in .env');
  process.exit(1);
}

// ============================================
// ✅ 15 BRANCHES CONFIGURATION
// ============================================
const BRANCHES_CONFIG = {
  'naroda': {
    name: 'Naroda',
    watiNumber: '917969690935',
    executiveNumber: process.env.NARODA_EXECUTIVE || '919106959092',
    gmbLink: 'https://wa.me/917969690935?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Naroda%20branch'
  },
  'usmanpura': {
    name: 'Usmanpura',
    watiNumber: '917969690901',
    executiveNumber: process.env.USMANPURA_EXECUTIVE || '917490029085',
    gmbLink: 'https://wa.me/917969690901?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Usmanpura%20branch'
  },
  'vadaj': {
    name: 'Vadaj',
    watiNumber: '917969690903',
    executiveNumber: process.env.VADAJ_EXECUTIVE || '918488931212',
    gmbLink: 'https://wa.me/917969690903?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Vadaj%20branch'
  },
  'satellite': {
    name: 'Satellite',
    watiNumber: '917969690924',
    executiveNumber: process.env.SATELLITE_EXECUTIVE || '917490029085',
    gmbLink: 'https://wa.me/917969690924?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Satellite%20branch'
  },
  'maninagar': {
    name: 'Maninagar',
    watiNumber: '917969690936',
    executiveNumber: process.env.MANINAGAR_EXECUTIVE || '918488931212',
    gmbLink: 'https://wa.me/917969690936?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Maninagar%20branch'
  },
  'bapunagar': {
    name: 'Bapunagar',
    watiNumber: '917969690923',
    executiveNumber: process.env.BAPUNAGAR_EXECUTIVE || '919274682553',
    gmbLink: 'https://wa.me/917969690923?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Bapunagar%20branch'
  },
  'juhapura': {
    name: 'Juhapura',
    watiNumber: '917969690918',
    executiveNumber: process.env.JUHAPURA_EXECUTIVE || '919274682553',
    gmbLink: 'https://wa.me/917969690918?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Juhapura%20branch'
  },
  'gandhinagar': {
    name: 'Gandhinagar',
    watiNumber: '917969690941',
    executiveNumber: process.env.GANDHINAGAR_EXECUTIVE || '919558591212',
    gmbLink: 'https://wa.me/917969690941?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Gandhinagar%20branch'
  },
  'rajkot': {
    name: 'Rajkot',
    watiNumber: '917969690913',
    executiveNumber: process.env.RAJKOT_EXECUTIVE || '917880261858',
    gmbLink: 'https://wa.me/917969690913?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Rajkot%20branch'
  },
  'sabarmati': {
    name: 'Sabarmati',
    watiNumber: '917969690942',
    executiveNumber: process.env.SABARMATI_EXECUTIVE || '917880261858',
    gmbLink: 'https://wa.me/917969690942?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Sabarmati%20branch'
  },
  'ahmedabad': {
    name: 'Ahmedabad',
    watiNumber: '917969690900',
    executiveNumber: process.env.AHMEDABAD_EXECUTIVE || '919106959092',
    gmbLink: 'https://wa.me/917969690900?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Ahmedabad%20branch'
  },
  'surat': {
    name: 'Surat',
    watiNumber: '917969690911',
    executiveNumber: process.env.SURAT_EXECUTIVE || '919274682553',
    gmbLink: 'https://wa.me/917969690911?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Surat%20branch'
  },
  'vadodara': {
    name: 'Vadodara',
    watiNumber: '917969690912',
    executiveNumber: process.env.VADODARA_EXECUTIVE || '918488931212',
    gmbLink: 'https://wa.me/917969690912?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Vadodara%20branch'
  },
  'bhavnagar': {
    name: 'Bhavnagar',
    watiNumber: '917969690914',
    executiveNumber: process.env.BHAVNAGAR_EXECUTIVE || '917880261858',
    gmbLink: 'https://wa.me/917969690914?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Bhavnagar%20branch'
  },
  'jamnagar': {
    name: 'Jamnagar',
    watiNumber: '917969690915',
    executiveNumber: process.env.JAMNAGAR_EXECUTIVE || '917490029085',
    gmbLink: 'https://wa.me/917969690915?text=Hi%20I%20want%20to%20book%20an%20appointment%20at%20Jamnagar%20branch'
  }
};

// ============================================
// ✅ DATABASE CONNECTION
// ============================================
let db;
let processedCollection;
let patientsCollection;
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
    missCallsCollection = db.collection('miss_calls');
    chatSessionsCollection = db.collection('chat_sessions');
    chatMessagesCollection = db.collection('chat_messages');
    followupCollection = db.collection('followups');
    googleLeadsCollection = db.collection('google_leads');
    
    // Indexes
    await processedCollection.createIndex({ messageId: 1 }, { unique: true });
    await patientsCollection.createIndex({ patientPhone: 1, source: 1 });
    await patientsCollection.createIndex({ source: 1, status: 1 });
    await googleLeadsCollection.createIndex({ clickedAt: -1 });
    await googleLeadsCollection.createIndex({ branch: 1 });
    await googleLeadsCollection.createIndex({ phoneNumber: 1 });
    await followupCollection.createIndex({ patientId: 1, type: 1, source: 1 });
    
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
  return branch ? branch.executiveNumber : process.env.DEFAULT_EXECUTIVE || '917880261858';
}

function getWatiNumber(branchName) {
  const branch = BRANCHES_CONFIG[branchName.toLowerCase()];
  return branch ? branch.watiNumber : '917969690935';
}

// ============================================
// ✅ STAGE TRACKING CONSTANTS
// ============================================
const STAGES = {
  AWAITING_NAME: 'awaiting_name',
  AWAITING_TEST_TYPE: 'awaiting_test_type',
  AWAITING_TEST_DETAILS: 'awaiting_test_details',
  AWAITING_UPLOAD: 'awaiting_upload',
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
// ✅ SEND GOOGLE LEAD NOTIFICATION TO EXECUTIVE
// ============================================
async function sendGoogleLeadNotification(executiveNumber, patientName, patientPhone, branch, testDetails, testType, chatToken) {
  console.log(`📤 Sending GOOGLE LEAD notification to executive ${executiveNumber}`);
  
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
// ✅ GOOGLE LEAD - NO REPLY FOLLOW-UP (with Night Mode)
// ============================================
async function sendGoogleNoReplyFollowup(patient) {
  // Check if night time (8 PM to 8 AM) - skip sending
  if (isNightTime()) {
    console.log(`🌙 Night time (8PM-8AM) - Skipping Google no-reply followup for ${patient.patientName}`);
    return false;
  }
  
  console.log(`📢 Sending GOOGLE LEAD no-reply followup for ${patient.patientName}`);
  
  const executiveNumber = getExecutiveNumber(patient.branch);
  const chatLink = `${SELF_URL}/executive-chat/${patient.chatSessionToken || ''}`;
  
  const istTime = patient.createdAt ? getISTTime(new Date(patient.createdAt)) : "Not recorded";
  
  const parameters = [
    { name: "1", value: patient.patientName || "Google Lead" },
    { name: "2", value: patient.patientPhone },
    { name: "3", value: patient.branch || "Main Branch" },
    { name: "4", value: patient.testType || "Not specified" },
    { name: "5", value: patient.testDetails || "Not specified" },
    { name: "6", value: istTime },
    { name: "7", value: chatLink }
  ];
  
  await sendWatiTemplateMessage(executiveNumber, GOOGLE_FOLLOWUP_NO_REPLY, parameters);
  
  await followupCollection.insertOne({
    patientId: patient._id,
    patientPhone: patient.patientPhone,
    executiveNumber: executiveNumber,
    type: 'google_no_reply',
    sentAt: new Date(),
    status: 'sent',
    source: 'google'
  });
  
  await patientsCollection.updateOne(
    { _id: patient._id },
    { 
      $inc: { googleNoReplyFollowupCount: 1 },
      $set: { lastGoogleNoReplyFollowupAt: new Date() }
    }
  );
  
  return true;
}

// ============================================
// ✅ GOOGLE LEAD - WAITING FOLLOW-UP (with Night Mode)
// ============================================
async function sendGoogleWaitingFollowup(patient, waitingCount) {
  // Check if night time (8 PM to 8 AM) - skip sending
  if (isNightTime()) {
    console.log(`🌙 Night time (8PM-8AM) - Skipping Google waiting followup for ${patient.patientName}`);
    return false;
  }
  
  console.log(`⏳ Sending GOOGLE LEAD waiting followup for ${patient.patientName} (count: ${waitingCount})`);
  
  const executiveNumber = getExecutiveNumber(patient.branch);
  const istUpdatedAt = patient.updatedAt ? getISTTime(new Date(patient.updatedAt)) : "Not recorded";
  
  const parameters = [
    { name: "1", value: patient.patientName || "Google Lead" },
    { name: "2", value: patient.patientPhone },
    { name: "3", value: patient.branch || "Main Branch" },
    { name: "4", value: patient.testType || "Not specified" },
    { name: "5", value: patient.testDetails || "Not specified" },
    { name: "6", value: istUpdatedAt }
  ];
  
  await sendWatiTemplateMessage(executiveNumber, GOOGLE_FOLLOWUP_WAITING, parameters);
  
  await followupCollection.insertOne({
    patientId: patient._id,
    patientPhone: patient.patientPhone,
    executiveNumber: executiveNumber,
    type: 'google_waiting',
    waitingCount: waitingCount,
    sentAt: new Date(),
    status: 'sent',
    source: 'google'
  });
  
  await patientsCollection.updateOne(
    { _id: patient._id },
    { 
      $inc: { googleWaitingFollowupCount: 1 },
      $set: { lastGoogleWaitingFollowupAt: new Date() }
    }
  );
  
  if (waitingCount >= 4) {
    await escalateGoogleLeadToManager(patient, waitingCount);
  }
  
  return true;
}

// ============================================
// ✅ GOOGLE LEAD - ESCALATE TO MANAGER
// ============================================
async function escalateGoogleLeadToManager(patient, waitingCount) {
  console.log(`🚨 Escalating GOOGLE LEAD ${patient.patientName} to manager (waiting: ${waitingCount} times)`);
  
  const managerNumber = process.env.MANAGER_NUMBER || '917698011233';
  const executiveNumber = getExecutiveNumber(patient.branch);
  const executiveName = Object.keys(BRANCHES_CONFIG).find(key => BRANCHES_CONFIG[key].executiveNumber === executiveNumber) || 'Unknown Executive';
  const hoursWaiting = Math.floor((Date.now() - new Date(patient.updatedAt)) / (1000 * 60 * 60));
  
  const parameters = [
    { name: "1", value: patient.patientName || "Google Lead" },
    { name: "2", value: patient.patientPhone },
    { name: "3", value: patient.branch || "Main Branch" },
    { name: "4", value: patient.testType || "Not specified" },
    { name: "5", value: patient.testDetails || "Not specified" },
    { name: "6", value: waitingCount.toString() },
    { name: "7", value: hoursWaiting.toString() },
    { name: "8", value: executiveName },
    { name: "9", value: executiveNumber }
  ];
  
  await sendWatiTemplateMessage(managerNumber, GOOGLE_ESCALATION_MANAGER, parameters);
  
  await followupCollection.insertOne({
    patientId: patient._id,
    patientPhone: patient.patientPhone,
    executiveNumber: executiveNumber,
    managerNumber: managerNumber,
    type: 'google_escalation',
    waitingCount: waitingCount,
    hoursWaiting: hoursWaiting,
    sentAt: new Date(),
    status: 'escalated',
    source: 'google'
  });
  
  await patientsCollection.updateOne(
    { _id: patient._id },
    { 
      $set: { 
        googleEscalatedAt: new Date(), 
        googleEscalatedCount: waitingCount, 
        googleEscalatedToManager: true 
      } 
    }
  );
}

// ============================================
// ✅ SEND EXECUTIVE PERFORMANCE REPORT
// ============================================
async function sendGoogleExecutiveReport(executiveNumber) {
  console.log(`📊 Sending Google Lead Performance Report to executive ${executiveNumber}`);
  
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);
  
  const leads = await googleLeadsCollection.find({
    executiveNumber: executiveNumber,
    clickedAt: { $gte: weekAgo, $lte: today }
  }).toArray();
  
  const totalLeads = leads.length;
  const connected = leads.filter(l => l.status === 'executive_connected' || l.status === 'converted').length;
  const converted = leads.filter(l => l.status === 'converted').length;
  const conversionRate = totalLeads > 0 ? ((converted / totalLeads) * 100).toFixed(1) : 0;
  
  let totalResponseTime = 0;
  let responseCount = 0;
  for (const lead of leads) {
    if (lead.executiveConnectedAt) {
      const responseTime = (new Date(lead.executiveConnectedAt) - new Date(lead.clickedAt)) / (1000 * 60);
      totalResponseTime += responseTime;
      responseCount++;
    }
  }
  const avgResponseTime = responseCount > 0 ? Math.round(totalResponseTime / responseCount) : 0;
  
  const branchStats = {};
  for (const lead of leads) {
    const branch = lead.branch || 'Unknown';
    if (!branchStats[branch]) branchStats[branch] = { total: 0, converted: 0 };
    branchStats[branch].total++;
    if (lead.status === 'converted') branchStats[branch].converted++;
  }
  
  let branchBreakdown = '';
  for (const [branch, stats] of Object.entries(branchStats)) {
    const rate = stats.total > 0 ? ((stats.converted / stats.total) * 100).toFixed(1) : 0;
    branchBreakdown += `• ${branch}: ${stats.total} leads, ${rate}% converted\n`;
  }
  
  const parameters = [
    { name: "1", value: getISTDate(weekAgo) },
    { name: "2", value: getISTDate(today) },
    { name: "3", value: totalLeads.toString() },
    { name: "4", value: connected.toString() },
    { name: "5", value: converted.toString() },
    { name: "6", value: conversionRate.toString() },
    { name: "7", value: avgResponseTime.toString() },
    { name: "8", value: branchBreakdown || "No leads this week" }
  ];
  
  await sendWatiTemplateMessage(executiveNumber, GOOGLE_EXECUTIVE_REPORT, parameters);
  console.log(`✅ Google Executive Report sent to ${executiveNumber}`);
}

// ============================================
// ✅ GMB WEBHOOK - MAIN ENDPOINT
// ============================================
app.post('/gmb-webhook', async (req, res) => {
  try {
    console.log('\n📍 ========== GMB WEBHOOK RECEIVED ==========');
    
    const { from, waId, whatsappNumber, message, body, to } = req.body;
    
    const patientPhone = normalizeWhatsAppNumber(from || waId || whatsappNumber);
    
    if (!patientPhone) {
      console.log('❌ No phone number found');
      return res.status(400).json({ error: 'No phone number found' });
    }
    
    const receivingNumber = to || req.body.whatsappNumberTo || '';
    let branchName = 'Naroda';
    
    for (const [key, config] of Object.entries(BRANCHES_CONFIG)) {
      if (receivingNumber.includes(config.watiNumber) || config.watiNumber.includes(receivingNumber)) {
        branchName = config.name;
        break;
      }
    }
    
    const branchConfig = BRANCHES_CONFIG[branchName.toLowerCase()] || BRANCHES_CONFIG['naroda'];
    const executiveNumber = branchConfig.executiveNumber;
    
    console.log(`📍 Patient: ${patientPhone}, Branch: ${branchName}, Executive: ${executiveNumber}`);
    
    // Track Google Lead
    const leadRecord = {
      phoneNumber: patientPhone,
      branch: branchName,
      executiveNumber: executiveNumber,
      status: 'clicked',
      clickedAt: new Date(),
      clickedAtIST: getISTTime(),
      message: message || body || 'Initial click',
      source: 'google_my_business'
    };
    
    const leadResult = await googleLeadsCollection.insertOne(leadRecord);
    console.log(`✅ Google Lead tracked for ${branchName} branch`);
    
    // Create or update patient
    let patient = await patientsCollection.findOne({ patientPhone: patientPhone });
    
    if (!patient) {
      const result = await patientsCollection.insertOne({
        patientName: 'Google Lead',
        patientPhone: patientPhone,
        branch: branchName,
        testType: null,
        testDetails: null,
        patientMessages: [{ text: message || body, timestamp: new Date() }],
        sourceType: 'Google My Business',
        executiveNumber: executiveNumber,
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
            updatedAt: new Date(),
            source: 'gmb',
            gmbBranch: branchName
          },
          $push: { patientMessages: { text: message || body, timestamp: new Date() } }
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
    
    // Send welcome template to patient
    const welcomeTemplate = `Welcome to UIC Support - ${branchName} Branch!\n\nPlease share your name and test details:\n1. Your Name\n2. Test Type (MRI/CT/USG/X-RAY)\n3. Test Details\n\nOur executive will connect with you shortly.`;
    
    await sendWatiTemplateMessage(patientPhone, TEXT_MESSAGE_TEMPLATE, [
      { name: "1", value: welcomeTemplate }
    ]);
    console.log(`✅ Welcome message sent to patient`);
    
    res.json({ 
      success: true, 
      message: 'GMB lead processed successfully',
      branch: branchName,
      patientPhone: patientPhone,
      leadId: leadResult.insertedId
    });
    
  } catch (error) {
    console.error('❌ GMB webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ HANDLE GOOGLE LEAD EXECUTIVE BUTTONS
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
    
    // ============================================
    // ✅ HANDLE GOOGLE LEAD BUTTONS
    // ============================================
    
    // Check if sender is executive
    const isExecutive = Object.values(BRANCHES_CONFIG).some(b => b.executiveNumber === senderNumber);
    const isManager = senderNumber === (process.env.MANAGER_NUMBER || '917698011233');
    
    if (isExecutive && (text === 'CONVERT DONE' || text === 'WAITING' || text === 'NOT CONVERT')) {
      // Find Google lead for this executive
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
    
    // Handle READ DONE for executive report
    else if (isExecutive && text === 'READ DONE') {
      await sendWatiTemplateMessage(senderNumber, TEXT_MESSAGE_TEMPLATE, 
        [{ name: "1", value: "✅ Thanks! Keep up the great work with Google Leads! 🎉" }]);
    }
    
    // Handle manager buttons
    else if (isManager && (text === 'CONVERT DONE' || text === 'WAITING' || text === 'CALL EXECUTIVE' || text === 'VIEW DETAILS')) {
      let patient = await patientsCollection.findOne({ 
        googleEscalatedToManager: true,
        source: 'gmb'
      });
      
      if (patient) {
        if (text === 'CONVERT DONE') {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { 
              $set: { 
                status: 'converted',
                currentStage: STAGES.CONVERTED,
                googleEscalatedResolved: true,
                resolvedBy: 'manager'
              }
            }
          );
          await sendWatiTemplateMessage(senderNumber, TEXT_MESSAGE_TEMPLATE, 
            [{ name: "1", value: "✅ Google Lead converted by manager!" }]);
        }
        else if (text === 'WAITING') {
          await patientsCollection.updateOne(
            { _id: patient._id },
            { 
              $set: { 
                googleWaitingFollowupCount: 0,
                googleEscalatedResolved: false
              }
            }
          );
          await sendWatiTemplateMessage(senderNumber, TEXT_MESSAGE_TEMPLATE, 
            [{ name: "1", value: "⏳ Google Lead marked as waiting." }]);
        }
        else if (text === 'CALL EXECUTIVE') {
          const execNumber = patient.executiveNumber;
          await sendWatiTemplateMessage(senderNumber, TEXT_MESSAGE_TEMPLATE, 
            [{ name: "1", value: `📞 Call executive: ${execNumber}` }]);
          await sendWatiTemplateMessage(execNumber, TEXT_MESSAGE_TEMPLATE, 
            [{ name: "1", value: `🚨 Manager requested you to attend Google Lead: ${patient.patientName} (${patient.patientPhone})` }]);
        }
        else if (text === 'VIEW DETAILS') {
          const detailsLink = `${SELF_URL}/executive-chat/${patient.chatSessionToken}`;
          await sendWatiTemplateMessage(senderNumber, TEXT_MESSAGE_TEMPLATE, 
            [{ name: "1", value: `🔗 Google Lead details: ${detailsLink}` }]);
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
// ✅ CRON JOBS FOR GOOGLE LEADS (WITH NIGHT MODE CHECK)
// ============================================

// Every 20 minutes - Google Lead no reply followup (only in day time)
cron.schedule('*/20 * * * *', async () => {
  if (isNightTime()) {
    console.log('🌙 Night time (8PM-8AM) - Skipping Google no-reply followup cron job');
    return;
  }
  
  console.log('🔄 Running GOOGLE LEAD no-reply followup check...');
  try {
    const patients = await patientsCollection.find({
      source: 'gmb',
      executiveActionTaken: false,
      status: { $in: ['pending', 'awaiting_name', 'awaiting_test_type', 'awaiting_test_details'] },
      currentStage: { $nin: ['converted', 'not_converted'] },
      createdAt: { $lt: new Date(Date.now() - 20 * 60 * 1000) }
    }).toArray();
    
    for (const patient of patients) {
      const lastFollowup = await followupCollection.findOne({
        patientId: patient._id,
        type: 'google_no_reply',
        sentAt: { $gt: new Date(Date.now() - 20 * 60 * 1000) }
      });
      if (!lastFollowup) {
        await sendGoogleNoReplyFollowup(patient);
      }
    }
  } catch (error) {
    console.error('Google Lead no-reply followup error:', error);
  }
});

// Every hour - Google Lead waiting followup (only in day time)
cron.schedule('0 * * * *', async () => {
  if (isNightTime()) {
    console.log('🌙 Night time (8PM-8AM) - Skipping Google waiting followup cron job');
    return;
  }
  
  console.log('🔄 Running GOOGLE LEAD waiting followup check...');
  try {
    const patients = await patientsCollection.find({
      source: 'gmb',
      status: 'waiting',
      currentStage: 'waiting',
      googleWaitingFollowupCount: { $lt: 4 }
    }).toArray();
    
    for (const patient of patients) {
      const waitingCount = (patient.googleWaitingFollowupCount || 0) + 1;
      await sendGoogleWaitingFollowup(patient, waitingCount);
    }
  } catch (error) {
    console.error('Google Lead waiting followup error:', error);
  }
});

// Weekly Executive Report - Every Monday at 9:00 AM
cron.schedule('0 9 * * 1', async () => {
  console.log('📊 Running Google Executive Reports...');
  const executives = [...new Set(Object.values(BRANCHES_CONFIG).map(b => b.executiveNumber))];
  for (const execNumber of executives) {
    await sendGoogleExecutiveReport(execNumber);
  }
});

// ============================================
// ✅ GET BRANCH LINKS FOR GMB
// ============================================
app.get('/gmb-links', async (req, res) => {
  try {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>GMB Branch Links - UIC Support</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: white; text-align: center; margin-bottom: 10px; }
        .subtitle { color: white; text-align: center; margin-bottom: 30px; opacity: 0.9; }
        .links-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
        .link-card { background: white; border-radius: 16px; padding: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); transition: transform 0.2s; }
        .link-card:hover { transform: translateY(-5px); }
        .branch-name { font-size: 1.4em; font-weight: bold; color: #075e54; margin-bottom: 5px; }
        .wa-number { font-size: 0.8em; color: #666; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #eee; }
        .link { background: #f0f2f5; padding: 12px; border-radius: 10px; word-break: break-all; font-size: 0.7em; margin: 15px 0; font-family: monospace; }
        .copy-btn { background: #075e54; color: white; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; margin-right: 10px; }
        .copy-btn:hover { background: #128C7E; }
        .qr-code { margin-top: 15px; text-align: center; padding-top: 10px; border-top: 1px solid #eee; }
        .footer { text-align: center; color: white; margin-top: 40px; padding: 20px; background: rgba(0,0,0,0.2); border-radius: 12px; }
        .night-mode { background: #1f2937; color: #fbbf24; padding: 5px 10px; border-radius: 20px; font-size: 0.7em; display: inline-block; margin-bottom: 10px; }
      </style>
      <script>
        function copyLink(link, branch) {
          navigator.clipboard.writeText(link);
          alert('✅ Link for ' + branch + ' copied to clipboard!');
        }
      </script>
    </head>
    <body>
      <div class="container">
        <h1>🏥 Google My Business - WhatsApp Links</h1>
        <div class="subtitle">Copy these links and add to your Google My Business profile for each branch</div>
        <div class="subtitle"><span class="night-mode">🌙 Night Mode Active: 8 PM to 8 AM (No reminders)</span></div>
        
        <div class="links-grid">
          ${Object.entries(BRANCHES_CONFIG).map(([key, config]) => `
            <div class="link-card">
              <div class="branch-name">📍 ${config.name}</div>
              <div class="wa-number">📞 WhatsApp: ${config.watiNumber}</div>
              <div class="link">${config.gmbLink}</div>
              <button class="copy-btn" onclick="copyLink('${config.gmbLink}', '${config.name}')">📋 Copy Link</button>
              <div class="qr-code">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(config.gmbLink)}" alt="QR Code">
              </div>
            </div>
          `).join('')}
        </div>
        
        <div class="footer">
          <strong>📌 How It Works:</strong><br>
          Patient clicks link → WhatsApp opens → Welcome message → Executive gets notification<br>
          <strong>🌙 Night Mode:</strong> Reminders are OFF between 8 PM and 8 AM
        </div>
      </div>
    </body>
    </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send(`<h2>Error: ${error.message}</h2>`);
  }
});

// ============================================
// ✅ GOOGLE LEAD STATS API
// ============================================
app.get('/api/google-lead-stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const totalClicks = await googleLeadsCollection.countDocuments();
    const todayClicks = await googleLeadsCollection.countDocuments({ clickedAt: { $gte: today } });
    
    const branchStats = await googleLeadsCollection.aggregate([
      { $group: { _id: '$branch', count: { $sum: 1 } } }
    ]).toArray();
    
    const statusStats = await googleLeadsCollection.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray();
    
    res.json({ success: true, totalClicks, todayClicks, branchStats, statusStats });
  } catch (error) {
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
    system: 'GMB WhatsApp System',
    branches: Object.keys(BRANCHES_CONFIG).length,
    nightMode: isNightTime() ? 'Active (8PM-8AM)' : 'Inactive',
    time: getISTTime()
  });
});

// ============================================
// ✅ HOME ROUTE
// ============================================
app.get('/', (req, res) => {
  res.json({
    message: '🚀 GMB WhatsApp System - 15 Branches',
    version: '3.0.0',
    nightMode: '8 PM to 8 AM - No reminders',
    branches: Object.keys(BRANCHES_CONFIG).map(k => BRANCHES_CONFIG[k].name),
    endpoints: {
      gmb_webhook: '/gmb-webhook',
      gmb_links: '/gmb-links',
      google_lead_stats: '/api/google-lead-stats',
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
      console.log(`📍 Total Branches: ${Object.keys(BRANCHES_CONFIG).length}`);
      console.log(`📍 Night Mode: 8 PM to 8 AM (Reminders OFF)`);
      console.log(`📍 Current Time: ${getISTTime()}`);
      console.log(`📍 Night Mode Active: ${isNightTime() ? 'YES' : 'NO'}`);
      console.log(`📍 GMB Links Page: ${SELF_URL}:${PORT}/gmb-links`);
      console.log(`📍 GMB Webhook: ${SELF_URL}:${PORT}/gmb-webhook`);
      console.log('='.repeat(60) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
