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
  
  // Extract caller and called number
  const callerNumber = req.body.caller_number || req.body.from || req.body.msisdn || req.body.caller_id_number;
  const calledNumber = req.body.called_number || req.body.to || req.body.destination || req.body.call_to_number;
  
  console.log(`📞 Caller: ${callerNumber}, Called: ${calledNumber}`);
  
  if (!callerNumber) {
    console.log('❌ Caller number not found');
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
    res.json({ 
      status: 'success', 
      message: `WhatsApp message sent to ${whatsappNumber}`,
      branch: branch
    });
  } catch (error) {
    console.error('❌ Error sending WhatsApp:', error.message);
    res.status(500).json({ 
      error: 'Failed to send WhatsApp message', 
      details: error.message
    });
  }
});

// ============================================
// 📱 WATI SE MESSAGE BHEJNE KA FUNCTION - FIXED VERSION
// ============================================
async function sendWATIMessage(whatsappNumber, branch) {
  // Simple English message (pehle test ke liye)
  const messageText = `Namaste! Aapne humein miss call kiya tha (${branch} branch). Main aapki kya help kar sakta hoon?

1. Book Test
2. Upload Prescription
3. Talk to Executive

Reply with 1, 2, or 3`;

  try {
    console.log(`📤 Sending to WATI: ${whatsappNumber}`);
    console.log(`📝 Message: ${messageText}`);
    
    // WATI API call - exact format as per docs
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
      timeout: 10000
    });
    
    console.log('✅ WATI Response:', response.data);
    return response.data;
    
  } catch (error) {
    console.error('❌ WATI API Error:', error.message);
    if (error.response) {
      console.error('❌ Full Error:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

// ============================================
// 🧪 TEST ROUTE - Direct WATI test
// ============================================
app.get('/test-wati', async (req, res) => {
  const testNumber = req.query.number || '919106959092';
  const testBranch = req.query.branch || 'Test Branch';
  
  console.log(`🧪 TEST ROUTE: Testing WATI with number: ${testNumber}`);
  
  try {
    const result = await sendWATIMessage(testNumber, testBranch);
    
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
// 🧪 DEBUG ROUTE - Check WATI connection
// ============================================
app.get('/debug-wati', async (req, res) => {
  const results = {
    token_valid: !!WATI_TOKEN,
    token_preview: WATI_TOKEN.substring(0, 30) + '...',
    base_url: WATI_BASE_URL,
    tests: {}
  };
  
  // Test 1: Get contacts
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
      status: e.response?.status
    };
  }
  
  res.json(results);
});

// ============================================
// 🏠 HOME PAGE
// ============================================
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Tata-WATI Webhook</title>
        <style>
          body { font-family: Arial; padding: 30px; background: #f5f5f5; }
          .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
          h1 { color: #333; }
          .endpoint { background: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #007bff; }
          .method { font-weight: bold; color: #007bff; }
          .url { font-family: monospace; background: #eee; padding: 3px 6px; border-radius: 3px; }
          .test-btn { background: #28a745; color: white; padding: 8px 15px; border-radius: 4px; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚀 Tata-WATI Webhook Server</h1>
          <p>Server is running successfully!</p>
          
          <h2>Available Endpoints:</h2>
          
          <div class="endpoint">
            <div><span class="method">POST</span> <span class="url">/tata-misscall</span></div>
            <small>Tata Tele webhook endpoint</small>
          </div>
          
          <div class="endpoint">
            <div><span class="method">GET</span> <span class="url">/test-wati?number=919106959092</span></div>
            <small>Test WATI directly</small><br>
            <a href="/test-wati?number=919106959092" class="test-btn">🔍 Test Now</a>
          </div>
          
          <div class="endpoint">
            <div><span class="method">GET</span> <span class="url">/debug-wati</span></div>
            <small>Check WATI connection</small><br>
            <a href="/debug-wati" class="test-btn">🔧 Debug</a>
          </div>
        </div>
      </body>
    </html>
  `);
});

// ============================================
// 404 HANDLER
// ============================================
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found', 
    available_endpoints: ['/', '/health', '/test-wati', '/debug-wati', 'POST /tata-misscall']
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
  console.log(`📍 Test: /test-wati?number=919106959092`);
  console.log(`📍 Debug: /debug-wati`);
  console.log('='.repeat(50));
});
