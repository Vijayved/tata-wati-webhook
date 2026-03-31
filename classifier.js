// classifier.js - Enterprise Grade Hybrid Classification System
const axios = require('axios');

// ============================================
// ✅ CACHE FOR AI RESULTS (Prevents duplicate API calls)
// ============================================
const aiCache = new Map();
const CACHE_MAX_SIZE = 500;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(message, context) {
  return `${message.toLowerCase().trim()}_${JSON.stringify(context)}`;
}

function setCache(key, value) {
  if (aiCache.size >= CACHE_MAX_SIZE) {
    const firstKey = aiCache.keys().next().value;
    aiCache.delete(firstKey);
  }
  aiCache.set(key, {
    data: value,
    timestamp: Date.now()
  });
}

function getCache(key) {
  const cached = aiCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }
  if (cached) {
    aiCache.delete(key);
  }
  return null;
}

function clearAICache() {
  const size = aiCache.size;
  aiCache.clear();
  console.log(`🗑️ AI cache cleared (${size} entries)`);
  return { cleared: size };
}

function getCacheStats() {
  return {
    size: aiCache.size,
    maxSize: CACHE_MAX_SIZE,
    ttlHours: CACHE_TTL / (1000 * 60 * 60)
  };
}

// ============================================
// ✅ SAFE JSON PARSER
// ============================================
function safeParseJSON(text) {
  try {
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('❌ JSON parse failed:', text.substring(0, 100));
    return null;
  }
}

// ============================================
// ✅ FAST RULES-BASED CLASSIFIER
// ============================================

const TEST_KEYWORDS = [
  'MRI', 'CT', 'X-RAY', 'XRAY', 'USG', 'ULTRASOUND', 
  'SONOGRAPHY', 'SCAN', 'BLOOD', 'URINE', 'X-RAY', 'PET', 'MAMMOGRAPHY'
];

const BODY_PARTS = [
  'KNEE', 'SPINE', 'BRAIN', 'CHEST', 'ABDOMEN', 'HIP', 
  'SHOULDER', 'WRIST', 'ANKLE', 'PELVIS', 'NECK', 'HEAD',
  'LIVER', 'KIDNEY', 'HEART', 'LUNG', 'FOOT', 'HAND',
  'BACK', 'JOINT', 'MUSCLE', 'BONE'
];

const GREETINGS = [
  'HI', 'HELLO', 'HEY', 'HII', 'HIII', 'HIIII', 'GOOD MORNING', 
  'GOOD AFTERNOON', 'GOOD EVENING', 'NAMSTE', 'NAMASKAR', 'JAI SHREE KRISHNA',
  'VANAKKAM', 'SASRIYAKAL', 'NOMOSKAR'
];

const HINGLISH_MEDICAL = [
  'KARAVU', 'KARAVANU', 'KARVU', 'KARNA', 'KARNA HAI',
  'KARANA', 'KARAVU CHE', 'KARVU CHE', 'KARNA HAI'
];

function fastClassify(message) {
  const upperMsg = message.toUpperCase().trim();
  const wordCount = message.split(' ').length;
  const cleanedMsg = message.replace(/[^a-zA-Z\s]/g, '').trim();
  
  const commands = ['UPLOAD PRESCRIPTION', 'MANUAL ENTRY', 'CHANGE BRANCH', 
                    'CONNECT TO PATIENT', 'CONVERT DONE', 'WAITING', 'NOT CONVERT',
                    'CONVERTED', 'ESCALATE'];
  for (const cmd of commands) {
    if (upperMsg.includes(cmd.toUpperCase())) {
      return { category: 'IGNORE', value: message, confidence: 1, method: 'rule' };
    }
  }
  
  const exactGreeting = GREETINGS.find(g => upperMsg === g || upperMsg.startsWith(g + ' ') || upperMsg.endsWith(' ' + g));
  if (exactGreeting) {
    return { category: 'GREETING', value: message, confidence: 0.99, method: 'rule' };
  }
  
  let hasTest = false;
  let hasBody = false;
  let detectedTest = null;
  
  for (const test of TEST_KEYWORDS) {
    if (upperMsg.includes(test)) {
      hasTest = true;
      detectedTest = test;
      break;
    }
  }
  
  for (const body of BODY_PARTS) {
    if (upperMsg.includes(body)) {
      hasBody = true;
      break;
    }
  }
  
  let hasHinglishMedical = false;
  for (const word of HINGLISH_MEDICAL) {
    if (upperMsg.includes(word)) {
      hasHinglishMedical = true;
      break;
    }
  }
  
  if (hasTest && hasBody) {
    return { category: 'TEST_DETAILS', value: message, extractedTest: detectedTest, confidence: 0.99, method: 'rule' };
  }
  
  if (hasTest && hasHinglishMedical) {
    return { category: 'TEST_DETAILS', value: message, extractedTest: detectedTest, confidence: 0.95, method: 'rule_hinglish' };
  }
  
  if (hasTest && wordCount === 1) {
    return { category: 'TEST_TYPE', value: detectedTest, confidence: 0.99, method: 'rule' };
  }
  
  if (hasTest && wordCount > 1 && !hasBody) {
    return { category: 'TEST_TYPE', value: detectedTest, confidence: 0.88, method: 'rule' };
  }
  
  if (hasBody && !hasTest) {
    return { category: 'TEST_DETAILS', value: message, confidence: 0.85, method: 'rule' };
  }
  
  const nameRegex = /^[A-Za-z\s]{2,30}$/;
  const isMedicalTerm = /scan|test|report|mri|ct|xray|ultrasound|usg|knee|brain|spine|chest|abdomen/i.test(message);
  
  if (nameRegex.test(cleanedMsg) && !isMedicalTerm && wordCount <= 3) {
    return { category: 'PATIENT_NAME', value: cleanedMsg, confidence: 0.92, method: 'rule' };
  }
  
  const indianNameRegex = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)?$/;
  if (indianNameRegex.test(cleanedMsg) && wordCount <= 2 && !isMedicalTerm) {
    return { category: 'PATIENT_NAME', value: cleanedMsg, confidence: 0.88, method: 'rule' };
  }
  
  if ((hasBody || wordCount >= 2) && !hasTest && !isMedicalTerm) {
    return { category: 'TEST_DETAILS', value: message, confidence: 0.75, method: 'rule' };
  }
  
  return { category: 'UNKNOWN', value: message, confidence: 0.35, method: 'needs_ai' };
}

// ============================================
// ✅ AI FALLBACK
// ============================================

async function aiClassify(message, context = {}) {
  const cacheKey = getCacheKey(message, context);
  
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`💾 Using cached AI result for: "${message.substring(0, 30)}..."`);
    return { ...cached, method: 'cache' };
  }
  
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const AI_TIMEOUT = parseInt(process.env.AI_TIMEOUT) || 1500;
    
    if (!OPENAI_API_KEY) {
      console.log('⚠️ No AI API key, returning unknown');
      return { category: 'UNKNOWN', value: message, confidence: 0.5, method: 'fallback' };
    }
    
    const systemPrompt = `You are a medical WhatsApp assistant classifier.

Classify the user's message into ONE category:
- PATIENT_NAME: Human name (1-3 words, no medical terms)
- TEST_TYPE: Test keywords (MRI, CT, X-RAY, USG, ULTRASOUND, SCAN)
- TEST_DETAILS: Test + body part (MRI Knee, CT Brain) or body part alone
- ADDRESS: Location, address, area name (house number, street, city)
- GREETING: Hello, Hi, Hey, Good morning
- UNKNOWN: Anything else

Return ONLY JSON with no extra text:
{"category": "CATEGORY", "value": "cleaned value", "confidence": 0.0-1.0}`;

    const userPrompt = `Message: "${message}"\nContext: ${JSON.stringify(context)}`;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 80
    }, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: AI_TIMEOUT
    });
    
    const raw = response.data.choices[0].message.content;
    const aiResult = safeParseJSON(raw);
    
    if (!aiResult || !aiResult.category) {
      console.error('❌ Invalid AI response:', raw);
      return { category: 'UNKNOWN', value: message, confidence: 0.5, method: 'fallback' };
    }
    
    setCache(cacheKey, aiResult);
    return { ...aiResult, method: 'ai' };
    
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.log('⏱️ AI timeout, using fallback');
      return { category: 'UNKNOWN', value: message, confidence: 0.4, method: 'timeout_fallback' };
    }
    console.error('AI classification error:', error.message);
    return { category: 'UNKNOWN', value: message, confidence: 0.5, method: 'fallback' };
  }
}

// ============================================
// ✅ HYBRID CLASSIFIER
// ============================================

async function classifyMessage(message, patientContext = {}) {
  const startTime = Date.now();
  
  const ruleResult = fastClassify(message);
  console.log(`⚡ Rules: ${ruleResult.category} (conf: ${ruleResult.confidence}, method: ${ruleResult.method})`);
  
  if (ruleResult.confidence >= 0.8 && ruleResult.category !== 'UNKNOWN') {
    console.log(`✅ Using rules (${Date.now() - startTime}ms)`);
    return ruleResult;
  }
  
  console.log(`🤖 AI fallback triggered...`);
  const aiResult = await aiClassify(message, patientContext);
  console.log(`✅ AI result (${Date.now() - startTime}ms): ${aiResult.category}`);
  
  return aiResult;
}

// ============================================
// ✅ STAGE-AWARE CLASSIFIER
// ============================================

async function classifyWithStage(message, currentStage) {
  const upperMsg = message.toUpperCase().trim();
  const wordCount = message.split(' ').length;
  
  if (currentStage === 'awaiting_name') {
    const cleanedMsg = message.replace(/[^a-zA-Z\s]/g, '').trim();
    const nameRegex = /^[A-Za-z\s]{2,30}$/;
    const indianNameRegex = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)?$/;
    
    if (nameRegex.test(cleanedMsg) && wordCount <= 3) {
      return { category: 'PATIENT_NAME', value: cleanedMsg, confidence: 0.96, method: 'stage_rule' };
    }
    if (indianNameRegex.test(cleanedMsg) && wordCount <= 2) {
      return { category: 'PATIENT_NAME', value: cleanedMsg, confidence: 0.94, method: 'stage_rule' };
    }
  }
  
  if (currentStage === 'awaiting_test_type') {
    for (const test of TEST_KEYWORDS) {
      if (upperMsg.includes(test)) {
        return { category: 'TEST_TYPE', value: test, confidence: 0.99, method: 'stage_rule' };
      }
    }
    for (const body of BODY_PARTS) {
      if (upperMsg.includes(body)) {
        return { category: 'TEST_DETAILS', value: message, confidence: 0.85, method: 'stage_rule' };
      }
    }
  }
  
  if (currentStage === 'awaiting_test_details') {
    if (message.length > 2) {
      return { category: 'TEST_DETAILS', value: message, confidence: 0.92, method: 'stage_rule' };
    }
  }
  
  if (currentStage === 'awaiting_address') {
    if (message.length > 5) {
      return { category: 'ADDRESS', value: message, confidence: 0.95, method: 'stage_rule' };
    }
  }
  
  if (currentStage === 'executive_notified') {
    if (message.length > 2) {
      return { category: 'MESSAGE', value: message, confidence: 0.85, method: 'stage_rule' };
    }
  }
  
  return await classifyMessage(message, { currentStage });
}

module.exports = {
  fastClassify,
  aiClassify,
  classifyMessage,
  classifyWithStage,
  clearAICache,
  getCacheStats,
  TEST_KEYWORDS,
  BODY_PARTS,
  GREETINGS
};
