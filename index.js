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

// Tata Tele se request aayegi yahan
app.post('/tata-misscall', async (req, res) => {
  console.log('📞 Miss Call Received:', req.body);
  
  // Extract caller and called number
  const callerNumber = req.body.caller_number || req.body.from || req.body.msisdn;
  const calledNumber = req.body.called_number || req.body.to || req.body.destination;
  
  if (!callerNumber) {
    return res.status(400).json({ error: 'Caller number not found' });
  }
  
  // Format number (add 91 if not present)
  let whatsappNumber = callerNumber.toString().replace(/\D/g, '');
  if (!whatsappNumber.startsWith('91')) {
    whatsappNumber = '91' + whatsappNumber;
  }
  
  // Detect branch
  const branch = BRANCHES[calledNumber] || 'Main Branch';
  
  try {
    // Send message via WATI
    const watiResponse = await sendWATIMessage(whatsappNumber, branch);
    
    console.log(`✅ Message sent to ${whatsappNumber} for branch ${branch}`);
    res.json({ 
      status: 'success', 
      message: `WhatsApp message sent to ${whatsappNumber}`,
      branch: branch 
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: 'Failed to send WhatsApp message', details: error.message });
  }
});

// WATI se message bhejne ka function
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
    }
  });
  
  return response.data;
}

// Health check route
app.get('/', (req, res) => {
  res.send('🚀 Tata-WATI Webhook Server is Running!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', time: new Date() });
});

// Server start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
