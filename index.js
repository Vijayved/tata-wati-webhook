const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// WATI Configuration - Aapka sahi token
const WATI_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1bmlxdWVfbmFtZSI6Im1haWx0b2RyYW1pdEBnbWFpbC5jb20iLCJuYW1laWQiOiJtYWlsdG9kcmFtaXRAZ21haWwuY29tIiwiZW1haWwiOiJtYWlsdG9kcmFtaXRAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDMvMTMvMjAyNiAwOTo0NToyMSIsInRlbmFudF9pZCI6IjExMTAiLCJkYl9uYW1lIjoibXQtcHJvZC1UZW5hbnRzIiwiaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS93cy8yMDA4LzA2L2lkZW50aXR5L2NsYWltcy9yb2xlIjoiQURNSU5JU1RSQVRPUiIsImV4cCI6MjUzNDAyMzAwODAwLCJpc3MiOiJDbGFyZV9BSSIsImF1ZCI6IkNsYXJlX0FJIn0.BVwEFq7t4Z9QN3Y1CbXAdR6zgIHqPN83jFtmrNq_2lc';
const WATI_BASE_URL = 'https://live-mt-server.wati.io/1110';

// Branch Mapping - Aapke branch numbers
const BRANCHES = {
  '9898989898': 'Satellite',
  '9898989899': 'Naroda',
  '9898989897': 'Usmanpura',
  '9898989896': 'Vadaj'
};

// ============================================
// 📞 TATA TELE WEBHOOK - Miss Call Handler
// ============================================
app.post('/tata-misscall', async (req, res) => {
  console.log('📞 Miss Call Received:', JSON.stringify(req.body, null, 2));
  
  // Extract caller and called number (Tata Tele ke format ke according)
  const callerNumber = req.body.caller_number || req.body.from || req.body.msisdn || req.body.caller_id_number;
  const calledNumber = req.body.called_number || req.body.to || req.body.destination || req.body.call_to_number;
  
  console.log(`📞 Caller: ${callerNumber}, Called: ${calledNumber}`);
  
  if (!callerNumber) {
    console.log('❌ Caller number not found in request');
    return res.status(400).json({ error: 'Caller number not found' });
  }
  
  // Format number (add 91 if not present)
  let whatsappNumber = callerNumber.toString().replace(/\D/g, '');
  if (!whatsappNumber.startsWith('91')) {
    whatsappNumber = '91' + whatsappNumber;
  }
  
  // Detect branch
  const branch = BRANCHES[calledNumber] || 'Main Branch';
  console.log(`🏥 Branch detected: ${branch}`);
  
  try {
    // Send message via WATI
    console.log(`📤 Sending WhatsApp to ${whatsappNumber}...`);
    const watiResponse = await sendWATIMessage(whatsappNumber, branch);
    
    console.log(`✅ Message sent successfully to ${whatsappNumber}`);
    console.log('📨 WATI Response:', JSON.stringify(watiResponse, null, 2));
    
    res.json({ 
      status: 'success', 
      message: `WhatsApp message sent to ${whatsappNumber}`,
      branch: branch,
      wati_response: watiResponse
    });
  } catch (error) {
    console.error('❌ Error sending WhatsApp:', error.message);
    if (error.response) {
      console.error('❌ WATI API Error Details:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({ 
      error: 'Failed to send WhatsApp message', 
      details: error.message,
      wati_error: error.response?.data || 'No additional details'
    });
  }
});

// ============================================
// 📱 WATI SE MESSAGE BHEJNE KA FUNCTION - SAHI V1 ENDPOINT
// ============================================
async function sendWATIMessage(whatsappNumber, branch) {
  const messageText = `Namaste! 🙏

Aapne humein miss call kiya tha (${branch} branch). Main aapki kya help kar sakta hoon?

1️⃣ *Book Test* - Test book karne ke liye
2️⃣ *Upload Prescription* - Prescription upload karne ke liye
3️⃣ *Talk to Executive* - Hamare executive se baat karne ke liye

Reply karein:
1 - Book Test ke liye
2 - Prescription Upload ke liye
3 - Executive se baat ke liye`;

  try {
    console.log(`📤 Sending to WATI (v1): ${whatsappNumber}`);
    
    // ✅ FIXED: /api/v1/sendSessionMessage/ (pehle v2 tha)
    const response = await axios({
      method: 'POST',
      url: `${WATI_BASE_URL}/api/v1/sendSessionMessage/${whatsappNumber}`,
      headers: {
        'Authorization': WATI_TOKEN,
        'Content-Type': 'application/json'
      },
      data: {
        messageText: messageText,
        messageType: 'text'
      },
      timeout: 10000 // 10 seconds timeout
    });
    
    console.log('✅ WATI Response:', response.data);
    return response.data;
    
  } catch (error) {
    console.error('❌ WATI API Error:', error.message);
    if (error.response) {
      console.error('❌ Error Details:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

// ============================================
// 🧪 TEST ROUTE - Direct WATI test
// ============================================
app.get('/test-wati', async (req, res) => {
  // URL mein ?number=919106959092 daal kar test karo
  const testNumber = req.query.number || '919106959092';
  const testBranch = req.query.branch || 'Test Branch';
  
  console.log(`🧪 TEST ROUTE: Testing WATI with number: ${testNumber}`);
  
  try {
    const result = await sendWATIMessage(testNumber, testBranch);
    
    // Send nice HTML response
    res.send(`
      <html>
        <head><title>WATI Test Result</title></head>
        <body style="font-family: Arial; padding: 20px;">
          <h2 style="color: green;">✅ Success!</h2>
          <p>Message sent to: <strong>${testNumber}</strong></p>
          <p>Branch: <strong>${testBranch}</strong></p>
          <p>Check your WhatsApp for the test message!</p>
          <pre style="background: #f4f4f4; padding: 10px; border-radius: 5px;">${JSON.stringify(result, null, 2)}</pre>
          <p><a href="/">← Back to Home</a></p>
        </body>
      </html>
    `);
  } catch (error) {
    res.send(`
      <html>
        <head><title>WATI Test Result</title></head>
        <body style="font-family: Arial; padding: 20px;">
          <h2 style="color: red;">❌ Failed!</h2>
          <p>Error: <strong>${error.message}</strong></p>
          <p style="background: #ffeeee; padding: 10px; border-radius: 5px;">
            ${error.response ? JSON.stringify(error.response.data) : 'No additional details'}
          </p>
          <p><a href="/">← Back to Home</a></p>
        </body>
      </html>
    `);
  }
});

// ============================================
// 🧪 DEBUG ROUTE - WATI connection test
// ============================================
app.get('/debug-wati', async (req, res) => {
  const results = {
    token_valid: !!WATI_TOKEN,
    token_preview: WATI_TOKEN.substring(0, 20) + '...',
    base_url: WATI_BASE_URL,
    tests: {}
  };
  
  // Test 1: Get contacts (simple GET request to check token)
  try {
    const contactsRes = await axios({
      method: 'GET',
      url: `${WATI_BASE_URL}/api/v1/getContacts?pageSize=1`,
      headers: { 'Authorization': WATI_TOKEN },
      timeout: 5000
    });
    results.tests.getContacts = { 
      success: true, 
      status: contactsRes.status,
      message: 'Token is valid!'
    };
  } catch (e) {
    results.tests.getContacts = { 
      success: false, 
      error: e.message, 
      status: e.response?.status,
      data: e.response?.data
    };
  }
  
  res.json(results);
});

// ============================================
// 🏠 HOME PAGE - All endpoints list
// ============================================
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Tata-WATI Webhook</title>
        <style>
          body { font-family: Arial; padding: 30px; background: #f5f5f5; }
          .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #333; }
          .endpoint { background: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #007bff; border-radius: 4px; }
          .method { font-weight: bold; color: #007bff; }
          .url { font-family: monospace; background: #eee; padding: 3px 6px; border-radius: 3px; }
          .test-btn { background: #28a745; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚀 Tata-WATI Webhook Server</h1>
          <p>Your server is running successfully!</p>
          
          <h2>📌 Available Endpoints:</h2>
          
          <div class="endpoint">
            <div><span class="method">POST</span> <span class="url">/tata-misscall</span></div>
            <small>Tata Tele webhook endpoint - Miss call yahan aayegi</small>
          </div>
          
          <div class="endpoint">
            <div><span class="method">GET</span> <span class="url">/test-wati?number=919106959092</span></div>
            <small>Direct WATI test - Apna number daal kar try karo</small><br>
            <a href="/test-wati?number=919106959092" class="test-btn">🔍 Test with your number</a>
          </div>
          
          <div class="endpoint">
            <div><span class="method">GET</span> <span class="url">/debug-wati</span></div>
            <small>Check WATI connection and token validity</small><br>
            <a href="/debug-wati" class="test-btn">🔧 Run Debug</a>
          </div>
          
          <div class="endpoint">
            <div><span class="method">GET</span> <span class="url">/health</span></div>
            <small>Health check endpoint</small>
          </div>
          
          <hr>
          <p style="color: #666;">Server time: ${new Date().toLocaleString()}</p>
        </div>
      </body>
    </html>
  `);
});

// ============================================
// 🏥 HEALTH CHECK ROUTE
// ============================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    time: new Date(),
    server: 'running',
    wati_configured: !!WATI_TOKEN
  });
});

// ============================================
// 404 HANDLER - For undefined routes
// ============================================
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found', 
    available_endpoints: [
      'GET /',
      'GET /health',
      'GET /test-wati?number=91XXXXXXXXXX',
      'GET /debug-wati',
      'POST /tata-misscall'
    ]
  });
});

// ============================================
// 🚀 SERVER START
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Home: http://localhost:${PORT}`);
  console.log(`📍 Test WATI: http://localhost:${PORT}/test-wati?number=919106959092`);
  console.log(`📍 Debug: http://localhost:${PORT}/debug-wati`);
  console.log('='.repeat(50));
});
