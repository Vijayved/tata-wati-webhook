require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

// ============================================
// ✅ FORCE PORT BINDING
// ============================================
const PORT = parseInt(process.env.PORT) || 3001;
process.env.PORT = PORT;

console.log(`🚀 Starting GMB System on PORT=${PORT}`);

// ============================================
// ✅ TIMEZONE SETUP - IST
// ============================================
process.env.TZ = 'Asia/Kolkata';

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

app.use('/gmb-webhook', simpleRateLimit);
app.use('/wati-webhook', simpleRateLimit);

// ============================================
// ✅ IST TIME HELPER
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

// ============================================
// CONFIGURATION
// ============================================
const WATI_TOKEN = process.env.WATI_TOKEN;
const WATI_BASE_URL = process.env.WATI_BASE_URL;
const MONGODB_URI = process.env.MONGODB_URI;
const WATI_NUMBER = process.env.WATI_NUMBER || '919725504245';

// Template Names
const GOOGLE_LEAD_TEMPLATE = 'google_lead_notification_v5';
const CUSTOMER_WELCOME_TEMPLATE = 'gmb_customer_welcome';

// Executive Numbers
const GMB_EXECUTIVES = {
  'Aditi': '8488931212',
  'Khyati': '7490029085',
  'Jay': '9274682553',
  'Mital': '9558591212',
  'Manager': '7698011233'
};

// Branch to Executive Mapping
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

function detectGMBBranch(message) {
  const msgLower = (message || '').toLowerCase();
  const branches = ['naroda', 'ahmedabad', 'gandhinagar', 'sabarmati', 'anand', 'usmanpura', 'satellite', 'nadiad', 'jamnagar', 'bhavnagar', 'bapunagar', 'juhapura', 'surat', 'changodar', 'bareja', 'vadaj', 'maninagar', 'rajkot', 'vadodara', 'morbi'];
  for (const branch of branches) {
    if (msgLower.includes(branch)) return branch.charAt(0).toUpperCase() + branch.slice(1);
  }
  return null;
}

function getGMBExecutiveByBranch(branchName) {
  if (!branchName || branchName === 'Unknown') {
    return { executiveNumber: GMB_EXECUTIVES.Manager, executiveName: 'Manager' };
  }
  const branch = GMB_BRANCHES[branchName?.toLowerCase()];
  return branch || { executiveNumber: GMB_EXECUTIVES.Aditi, executiveName: 'Aditi' };
}

function normalizeWhatsAppNumber(number) {
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

// ============================================
// ✅ DATABASE CONNECTION
// ============================================
let db;
let patientsCollection;
let googleLeadsCollection;
let processedCollection;

async function connectDB() {
  console.log('🔄 Connecting to MongoDB...');
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('executive_system');
  patientsCollection = db.collection('patients');
  googleLeadsCollection = db.collection('google_leads');
  processedCollection = db.collection('processed_messages');
  
  await googleLeadsCollection.createIndex({ phoneNumber: 1 }, { unique: true });
  await googleLeadsCollection.createIndex({ clickedAt: -1 });
  await patientsCollection.createIndex({ patientPhone: 1, source: 1 }, { unique: true });
  await processedCollection.createIndex({ messageId: 1 }, { unique: true });
  
  console.log('✅ GMB Database connected');
}

async function isMessageProcessed(messageId) {
  return !!(await processedCollection.findOne({ messageId }));
}

async function markMessageProcessed(messageId) {
  await processedCollection.updateOne(
    { messageId },
    { $set: { messageId, processedAt: new Date() } },
    { upsert: true }
  );
}

// ============================================
// ✅ WATI TEMPLATE SENDER
// ============================================
async function sendWatiTemplateMessage(whatsappNumber, templateName, parameters) {
  console.log(`📤 Sending ${templateName} to ${whatsappNumber}`);
  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
  const payload = { template_name: templateName, broadcast_name: `msg_${Date.now()}`, parameters };
  const response = await axios.post(url, payload, {
    headers: { Authorization: `${WATI_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  console.log(`✅ Template sent`);
  return response.data;
}

async function sendCustomerWelcome(whatsappNumber, branchName) {
  return await sendWatiTemplateMessage(whatsappNumber, CUSTOMER_WELCOME_TEMPLATE, [{ name: "1", value: branchName }]);
}

async function sendGMBLeadNotification(executiveNumber, executiveName, patientName, patientPhone, branch, testDetails, testType, chatToken) {
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
    { name: "1", value: patientName },
    { name: "2", value: patientPhone },
    { name: "3", value: branch },
    { name: "4", value: testType },
    { name: "5", value: testDetails },
    { name: "6", value: istTime },
    { name: "7", value: whatsappLink }
  ];
  return await sendWatiTemplateMessage(executiveNumber, GOOGLE_LEAD_TEMPLATE, parameters);
}

// ============================================
// ✅ BOT CLASSIFICATION (GMB)
// ============================================
async function classifyGMBMessage(messageText, patientContext = {}) {
  const upperMsg = messageText.toUpperCase();
  const wordCount = messageText.split(' ').length;
  const cleanedMsg = messageText.replace(/[^a-zA-Z\s]/g, '').trim();
  
  const commands = ['UPLOAD PRESCRIPTION', 'MANUAL ENTRY', 'CHANGE BRANCH', 'CONNECT TO PATIENT', 'CONVERT DONE', 'WAITING', 'NOT CONVERT'];
  for (const cmd of commands) {
    if (upperMsg.includes(cmd)) return { category: 'IGNORE', confidence: 1 };
  }
  
  if (patientContext.currentStage === 'awaiting_name') {
    return { category: 'PATIENT_NAME', value: cleanedMsg, confidence: 0.95 };
  }
  if (patientContext.currentStage === 'awaiting_test_type') {
    return { category: 'TEST_TYPE', value: messageText, confidence: 0.95 };
  }
  if (patientContext.currentStage === 'awaiting_test_details') {
    return { category: 'TEST_DETAILS', value: messageText, confidence: 0.95 };
  }
  
  const testKeywords = ['MRI', 'CT', 'USG', 'X-RAY', 'XRAY', 'ULTRASOUND'];
  let hasTestKeyword = false;
  for (const kw of testKeywords) if (upperMsg.includes(kw)) { hasTestKeyword = true; break; }
  
  const nameRegex = /^[A-Za-z\s]{2,30}$/;
  if (nameRegex.test(cleanedMsg) && !hasTestKeyword && wordCount <= 3) {
    return { category: 'PATIENT_NAME', value: cleanedMsg, confidence: 0.9 };
  }
  if (hasTestKeyword && wordCount === 1) {
    return { category: 'TEST_TYPE', value: messageText, confidence: 0.99 };
  }
  if (hasTestKeyword && wordCount > 1) {
    return { category: 'TEST_DETAILS', value: messageText, confidence: 0.85 };
  }
  
  return { category: 'IGNORE', confidence: 0.5 };
}

// ============================================
// ✅ GMB WEBHOOK
// ============================================
app.post('/gmb-webhook', async (req, res) => {
  try {
    console.log('\n📍 GMB WEBHOOK RECEIVED');
    
    const { from, waId, whatsappNumber, text, body } = req.body;
    const patientPhone = normalizeWhatsAppNumber(from || waId || whatsappNumber);
    if (!patientPhone) return res.status(400).json({ error: 'No phone number' });
    
    const message = text || body || '';
    const branchName = detectGMBBranch(message) || 'Unknown';
    const branchInfo = getGMBExecutiveByBranch(branchName);
    
    console.log(`📍 Patient: ${patientPhone}, Branch: ${branchName}, Executive: ${branchInfo.executiveName}`);
    
    // Track lead
    await googleLeadsCollection.updateOne(
      { phoneNumber: patientPhone },
      {
        $set: {
          branch: branchName,
          executiveNumber: branchInfo.executiveNumber,
          executiveName: branchInfo.executiveName,
          status: 'clicked',
          updatedAt: new Date(),
          message: message.substring(0, 200)
        },
        $setOnInsert: {
          clickedAt: new Date(),
          clickedAtIST: getISTTime(),
          source: 'google_my_business'
        }
      },
      { upsert: true }
    );
    
    // Create patient
    await patientsCollection.updateOne(
      { patientPhone, source: 'gmb' },
      {
        $setOnInsert: {
          patientName: 'Google Lead',
          patientPhone,
          branch: branchName,
          testType: null,
          testDetails: null,
          source: 'gmb',
          currentStage: 'awaiting_name',
          welcomeSent: false,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
    
    // Send welcome template
    await sendCustomerWelcome(patientPhone, branchName);
    console.log(`✅ Welcome template sent to ${patientPhone}`);
    
    res.json({ success: true, branch: branchName, executive: branchInfo.executiveName });
  } catch (error) {
    console.error('❌ GMB webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ✅ WATI WEBHOOK (GMB Patient Replies)
// ============================================
app.post('/wati-webhook', async (req, res) => {
  try {
    console.log('\n📨 WATI WEBHOOK (GMB)');
    
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
    
    console.log(`📝 Message: "${messageText}" from ${senderNumber}`);
    
    // Find GMB patient
    let patient = await patientsCollection.findOne({ 
      patientPhone: senderNumber,
      source: 'gmb'
    });
    
    if (!patient) {
      await markMessageProcessed(msgId);
      return res.sendStatus(200);
    }
    
    // Store message
    await patientsCollection.updateOne(
      { _id: patient._id },
      { 
        $push: { patientMessages: { $each: [{ text: messageText, timestamp: new Date() }], $slice: -20 } },
        $set: { lastMessageAt: new Date() }
      }
    );
    
    // Update Google lead status
    await googleLeadsCollection.updateOne(
      { phoneNumber: senderNumber },
      { $set: { status: 'patient_replied', patientRepliedAt: new Date(), patientReply: messageText } }
    );
    
    // Classify
    const context = { currentStage: patient.currentStage };
    const result = await classifyGMBMessage(messageText, context);
    
    if (result.confidence >= 0.8) {
      const update = {};
      if (result.category === 'PATIENT_NAME') {
        update.patientName = result.value;
        update.currentStage = 'awaiting_test_type';
      } else if (result.category === 'TEST_TYPE') {
        update.testType = result.value;
        update.currentStage = 'awaiting_test_details';
      } else if (result.category === 'TEST_DETAILS') {
        update.testDetails = result.value;
        update.currentStage = 'executive_notified';
      }
      
      if (Object.keys(update).length > 0) {
        await patientsCollection.updateOne({ _id: patient._id }, { $set: update });
        patient = await patientsCollection.findOne({ _id: patient._id });
      }
      
      if (result.category === 'TEST_DETAILS') {
        const branchInfo = getGMBExecutiveByBranch(patient.branch);
        const sessionToken = crypto.randomBytes(16).toString('hex');
        
        await sendGMBLeadNotification(
          branchInfo.executiveNumber,
          branchInfo.executiveName,
          patient.patientName,
          senderNumber,
          patient.branch,
          patient.testDetails,
          patient.testType,
          sessionToken
        );
        console.log(`✅ Executive notification sent to ${branchInfo.executiveName}`);
      }
    }
    
    await markMessageProcessed(msgId);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ GMB webhook error:', error);
    res.sendStatus(200);
  }
});

// ============================================
// ✅ GMB LINKS PAGE
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

app.get('/api/google-lead-stats', async (req, res) => {
  const totalClicks = await googleLeadsCollection.countDocuments();
  const branchStats = await googleLeadsCollection.aggregate([{ $group: { _id: '$branch', count: { $sum: 1 } } }]).toArray();
  res.json({ success: true, totalClicks, branchStats });
});

app.get('/health', (req, res) => res.json({ success: true, system: 'GMB System' }));
app.get('/', (req, res) => res.json({ message: 'GMB System', version: '2.0' }));

// ============================================
// ✅ START SERVER
// ============================================
async function startServer() {
  await connectDB();
  app.listen(PORT, '0.0.0.0', () => console.log(`✅ GMB System running on port ${PORT}`));
}
startServer();
