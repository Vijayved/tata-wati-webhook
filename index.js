const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// WATI Configuration - YEH APNI VALUES DALO
const WATI_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1bmlxdWVfbmFtZSI6Im1haWx0b2RyYW1pdEBnbWFpbC5jb20iLCJuYW1laWQiOiJtYWlsdG9kcmFtaXRAZ21haWwuY29tIiwiZW1haWwiOiJtYWlsdG9kcmFtaXRAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDMvMTMvMjAyNiAwOTo0NToyMSIsInRlbmFudF9pZCI6IjExMTAiLCJkYl9uYW1lIjoibXQtcHJvZC1UZW5hbnRzIiwiaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS93cy8yMDA4LzA2L2lkZW50aXR5L2NsYWltcy9yb2xlIjoiQURNSU5JU1RSQVRPUiIsImV4cCI6MjUzNDAyMzAwODAwLCJpc3MiOiJDbGFyZV9BSSIsImF1ZCI6IkNsYXJlX0FJIn0.BVwEFq7t4Z9QN3Y1CbXAdR6zgIHqPN83jFtmrNq_2lc';
const WATI_BASE_URL = 'https://live-mt-server.wati.io/1110';

// Branch Mapping - APNE BRANCH NUMBERS YAHAN DALO
const BRANCHES = {
  '9898989898': 'Satellite',
  '9898989899': 'Naroda',
  '9898989897': 'Usmanpura',
  '9898989896': 'Vadaj'
};

// 📞 TATA TELE WEBOOK - Miss Call handler
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

// 📱 WATI se message bhejne ka function
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
    console.log(`📤 Sending to WATI: ${whatsappNumber}`);
    
    const response = await axios({
      method: 'POST',
      url: `${WATI_BASE_URL}/api/v2/sendSessionMessage/${whatsappNumber}`,
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
    
    return response.data;
    
  } catch (error) {
    console.error('❌ WATI API Error:', error.message);
    throw error;
  }
}

// 🧪 TEST ROUTE - Direct WATI test karne ke liye (bina miss call ke)
app.get('/test-wati', async (req, res) => {
  // Apna WhatsApp number yahan dalo ya URL mein ?number=91XXXXXXXXXX dekar test karo
  const testNumber = req.query.number || '919876543210'; // ISKO APNE NUMBER SE BADLO
  const testBranch = req.query.branch || 'Test Branch';
  
  console.log(`🧪 TEST ROUTE: Testing WATI with number: ${testNumber}`);
  
  try {
    const result = await sendWATIMessage(testNumber, testBranch);
    
    res.json({ 
      success: true, 
      message: `✅ Test message sent to ${testNumber}`,
      response: result 
    });
  } catch (error) {
    console.error('❌ Test route error:', error.message);
    res.json({ 
      success: false, 
      error: error.message,
      details: error.response?.data || 'No additional details'
    });
  }
});

// 🧪 TEST ROUTE 2 - Tata Tele webhook simulate karne ke liye
app.get('/simulate-misscall', (req, res) => {
  const testCaller = req.query.caller || '9876543210';
  const testCalled = req.query.called || '9898989898';
  
  // Create a fake Tata Tele request
  const fakeReq = {
    body: {
      caller_id_number: testCaller,
      call_to_number: testCalled,
      start_stamp: new Date().toISOString(),
      call_id: 'TEST_' + Date.now()
    }
  };
  
  const fakeRes = {
    json: (data) => {
      res.json({ simulated: true, result: data });
    },
    status: (code) => {
      console.log(`Status code would be: ${code}`);
      return fakeRes;
    }
  };
  
  // Call the miss call handler
  app.handle(fakeReq, fakeRes, () => {});
  
  res.json({ message: 'Simulation triggered, check logs' });
});

// 🏠 Health check routes
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Tata-WATI Webhook Server is Running!</h1>
    <p>Available endpoints:</p>
    <ul>
      <li><b>POST /tata-misscall</b> - Tata Tele webhook endpoint</li>
      <li><b>GET /test-wati?number=91XXXXXXXXXX</b> - Test WATI directly</li>
      <li><b>GET /simulate-misscall?caller=9876543210&called=9898989898</b> - Simulate miss call</li>
      <li><b>GET /health</b> - Health check</li>
    </ul>
  `);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    time: new Date(),
    server: 'running',
    wati_configured: !!WATI_TOKEN
  });
});

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', available_endpoints: ['/', '/health', '/test-wati', '/simulate-misscall', 'POST /tata-misscall'] });
});

// Server start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Test WATI: http://localhost:${PORT}/test-wati?number=91XXXXXXXXXX`);
  console.log(`📍 Simulate Miss Call: http://localhost:${PORT}/simulate-misscall?caller=9876543210&called=9898989898`);
});
