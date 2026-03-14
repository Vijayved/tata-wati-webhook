const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const multer = require('multer');  // For file uploads
const FormData = require('form-data');

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// CONFIGURATION
// ============================================
const WATI_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1bmlxdWVfbmFtZSI6Im1haWx0b2RyYW1pdEBnbWFpbC5jb20iLCJuYW1laWQiOiJtYWlsdG9kcmFtaXRAZ21haWwuY29tIiwiZW1haWwiOiJtYWlsdG9kcmFtaXRAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDMvMTMvMjAyNiAwOTo0NToyMSIsInRlbmFudF9pZCI6IjExMTAiLCJkYl9uYW1lIjoibXQtcHJvZC1UZW5hbnRzIiwiaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS93cy8yMDA4LzA2L2lkZW50aXR5L2NsYWltcy9yb2xlIjoiQURNSU5JU1RSQVRPUiIsImV4cCI6MjUzNDAyMzAwODAwLCJpc3MiOiJDbGFyZV9BSSIsImF1ZCI6IkNsYXJlX0FJIn0.BVwEFq7t4Z9QN3Y1CbXAdR6zgIHqPN83jFtmrNq_2lc';
const WATI_BASE_URL = 'https://live-mt-server.wati.io/1110';

// Google Vision API (OPTIONAL - Comment out if not using)
// const vision = require('@google-cloud/vision');
// const visionClient = new vision.ImageAnnotatorClient({
//   keyFilename: './google-credentials.json'
// });

// Branch Mapping
const BRANCHES = {
  '9898989898': 'Satellite',
  '9898989899': 'Naroda',
  '9898989897': 'Usmanpura',
  '9898989896': 'Vadaj'
};

// ============================================
// FUNCTION 1: SEND WATI MESSAGE WITH BRANCH INFO
// ============================================
async function sendWATIMessage(whatsappNumber, branch) {
  const messageText = `Namaste! Aapne humein miss call kiya tha (${branch} branch). Main aapki kya help kar sakta hoon?

1️⃣ Book Test
2️⃣ Upload Prescription
3️⃣ Talk to Executive

Reply karein: 1, 2, ya 3`;

  try {
    console.log(`📤 Sending to WATI: ${whatsappNumber} for branch ${branch}`);
    
    const response = await axios({
      method: 'POST',
      url: `${WATI_BASE_URL}/api/v1/sendSessionMessage/${whatsappNumber}`,
      headers: {
        'Authorization': WATI_TOKEN,
        'Content-Type': 'application/json'
      },
      data: {
        messageText: messageText,
        messageType: 'TEXT',
        customParams: {  // ✅ Branch as custom parameter for WATI
          branch: branch,
          source: 'misscall'
        }
      },
      timeout: 10000
    });
    
    console.log('✅ WATI Response:', response.data);
    return response.data;
    
  } catch (error) {
    console.error('❌ WATI API Error:', error.message);
    throw error;
  }
}

// ============================================
// FUNCTION 2: OCR WITH GOOGLE VISION (OPTION B)
// ============================================
async function extractWithGoogleVision(imageUrl) {
  try {
    console.log('🔍 Running Google Vision OCR on:', imageUrl);
    
    // METHOD 1: If you have Google Vision setup
    // const [result] = await visionClient.textDetection(imageUrl);
    // const text = result.fullTextAnnotation.text;
    
    // METHOD 2: Using free OCR API (for testing)
    const formData = new FormData();
    formData.append('url', imageUrl);
    formData.append('apikey', 'K81411447188957');  // Free OCR.space API key
    formData.append('language', 'eng');
    
    const ocrResponse = await axios.post('https://api.ocr.space/parse/image', formData, {
      headers: formData.getHeaders()
    });
    
    if (ocrResponse.data.ParsedResults) {
      const text = ocrResponse.data.ParsedResults[0].ParsedText;
      return parsePrescriptionText(text);
    }
    
    return {
      patientName: 'Not found',
      doctorName: 'Not found',
      tests: 'Not found'
    };
    
  } catch (error) {
    console.error('❌ OCR Error:', error);
    return {
      patientName: 'OCR Failed',
      doctorName: 'OCR Failed',
      tests: 'OCR Failed',
      error: error.message
    };
  }
}

// ============================================
// FUNCTION 3: PARSE OCR TEXT
// ============================================
function parsePrescriptionText(text) {
  console.log('📝 OCR Text:', text);
  
  // Simple regex patterns (you can improve these)
  const patientMatch = text.match(/Patient(?:\s*Name)?[:\s]+([A-Za-z\s]+)/i) || 
                       text.match(/Name[:\s]+([A-Za-z\s]+)/i) ||
                       text.match(/([A-Z][a-z]+\s+[A-Z][a-z]+)/); // Simple name pattern
  
  const doctorMatch = text.match(/Dr\.?\s*([A-Za-z\s]+)/i) ||
                      text.match(/Doctor[:\s]+([A-Za-z\s]+)/i);
  
  // Common test names
  const testKeywords = ['blood', 'x-ray', 'xray', 'ultrasound', 'cbc', 'thyroid', 
                        'lipid', 'liver', 'kidney', 'urine', 'stool', 'ecg', 'mri', 'ct scan'];
  
  const foundTests = [];
  testKeywords.forEach(keyword => {
    if (text.toLowerCase().includes(keyword)) {
      foundTests.push(keyword.toUpperCase());
    }
  });
  
  return {
    patientName: patientMatch ? patientMatch[1].trim() : 'Not found',
    doctorName: doctorMatch ? doctorMatch[1].trim() : 'Not found',
    tests: foundTests.length ? foundTests.join(', ') : 'Not found',
    rawText: text.substring(0, 200) + '...' // Preview
  };
}

// ============================================
// ENDPOINT 1: TATA TELE WEBHOOK
// ============================================
app.post('/tata-misscall', async (req, res) => {
  console.log('📞 Miss Call Received:', JSON.stringify(req.body, null, 2));
  
  const callerNumber = req.body.caller_number || req.body.from || req.body.msisdn || req.body.caller_id_number;
  const calledNumber = req.body.called_number || req.body.to || req.body.destination || req.body.call_to_number;
  
  if (!callerNumber) {
    return res.status(400).json({ error: 'Caller number not found' });
  }
  
  let whatsappNumber = callerNumber.toString().replace(/\D/g, '');
  if (!whatsappNumber.startsWith('91')) {
    whatsappNumber = '91' + whatsappNumber;
  }
  
  const branch = BRANCHES[calledNumber] || 'Main Branch';
  console.log(`🏥 Branch: ${branch}, WhatsApp: ${whatsappNumber}`);
  
  try {
    await sendWATIMessage(whatsappNumber, branch);
    res.json({ status: 'success', branch: branch });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT 2: OCR PROCESSING (Called by WATI)
// ============================================
app.post('/ocr-prescription', async (req, res) => {
  console.log('📸 OCR Request Received');
  
  const { imageUrl, whatsappNumber, branch, watiChatId } = req.body;
  
  if (!imageUrl) {
    return res.status(400).json({ error: 'Image URL required' });
  }
  
  try {
    // Step 1: Run OCR
    const extractedData = await extractWithGoogleVision(imageUrl);
    
    // Step 2: Send to Executive via WATI
    const executiveMessage = `📸 *New Prescription Uploaded*
━━━━━━━━━━━━━━━━━━
🏥 *Branch:* ${branch || 'Not specified'}
👤 *Patient:* ${extractedData.patientName}
👨‍⚕️ *Doctor:* ${extractedData.doctorName}
🔬 *Tests:* ${extractedData.tests}
━━━━━━━━━━━━━━━━━━
💬 *Raw OCR Preview:*
${extractedData.rawText}

🔗 Image: ${imageUrl}`;

    // Send to WATI (to executive's chat)
    await axios({
      method: 'POST',
      url: `${WATI_BASE_URL}/api/v1/sendSessionMessage/919825086011`, // Executive number
      headers: { 'Authorization': WATI_TOKEN },
      data: {
        messageText: executiveMessage,
        messageType: 'TEXT'
      }
    });
    
    // Also send to original patient chat (confirmation)
    await axios({
      method: 'POST',
      url: `${WATI_BASE_URL}/api/v1/sendSessionMessage/${whatsappNumber}`,
      headers: { 'Authorization': WATI_TOKEN },
      data: {
        messageText: `✅ Aapki prescription receive ho gayi. Hamari team check karke aapse contact karegi.`,
        messageType: 'TEXT'
      }
    });
    
    res.json({ 
      success: true, 
      extracted: extractedData,
      notified: true
    });
    
  } catch (error) {
    console.error('❌ OCR Endpoint Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT 3: WATI Webhook (For receiving messages)
// ============================================
app.post('/wati-webhook', async (req, res) => {
  console.log('📨 WATI Webhook:', JSON.stringify(req.body, null, 2));
  
  // WATI se message aaya - can be used for logging or custom logic
  const { text, from, customParams } = req.body;
  
  // Log for debugging
  console.log(`Message from ${from}: ${text}`);
  console.log('Custom Params:', customParams);
  
  res.json({ received: true });
});

// ============================================
// TEST ENDPOINTS
// ============================================
app.get('/test-ocr', async (req, res) => {
  const testImage = req.query.image || 'https://i.imgur.com/sample-prescription.jpg';
  const result = await extractWithGoogleVision(testImage);
  res.json(result);
});

app.get('/test-wati', async (req, res) => {
  const testNumber = req.query.number || '919106959092';
  const branch = req.query.branch || 'Satellite';
  try {
    await sendWATIMessage(testNumber, branch);
    res.send(`✅ Test message sent to ${testNumber} for branch ${branch}`);
  } catch (error) {
    res.send(`❌ Error: ${error.message}`);
  }
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Tata-WATI Webhook Server</h1>
    <p>Available endpoints:</p>
    <ul>
      <li><b>POST /tata-misscall</b> - Tata Tele webhook</li>
      <li><b>POST /ocr-prescription</b> - OCR endpoint for WATI</li>
      <li><b>POST /wati-webhook</b> - WATI webhook</li>
      <li><b>GET /test-ocr?image=URL</b> - Test OCR</li>
      <li><b>GET /test-wati?number=91XXXX&branch=Satellite</b> - Test WATI</li>
    </ul>
  `);
});

// ============================================
// SERVER START
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Tata Tele Webhook: POST /tata-misscall`);
  console.log(`📍 OCR Endpoint: POST /ocr-prescription`);
  console.log(`📍 WATI Webhook: POST /wati-webhook`);
  console.log('='.repeat(60));
});
