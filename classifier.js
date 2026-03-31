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
    // Remove oldest entry
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

// ============================================
// ✅ SAFE JSON PARSER (Prevents crash)
// ============================================
function safeParseJSON(text) {
  try {
    // Remove markdown code blocks
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    
    // Try to extract JSON if there's extra text
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

// Test Keywords
const TEST_KEYWORDS = [
  'MRI', 'CT', 'X-RAY', 'XRAY', 'USG', 'ULTRASOUND', 
  'SONOGRAPHY', 'SCAN', 'BLOOD', 'URINE', 'X-RAY', 'PET', 'MAMMOGRAPHY'
];

// Body Parts
const BODY_PARTS = [
  'KNEE', 'SPINE', 'BRAIN', 'CHEST', 'ABDOMEN', 'HIP', 
  'SHOULDER', 'WRIST', 'ANKLE', 'PELVIS', 'NECK', 'HEAD',
  'LIVER', 'KIDNEY', 'HEART', 'LUNG', 'FOOT', 'HAND',
  'BACK', 'JOINT', 'MUSCLE', 'BONE'
];

// Greetings
const GREETINGS = [
  'HI', 'HELLO', 'HEY', 'HII', 'HIII', 'HIIII', 'GOOD MORNING', 
  'GOOD AFTERNOON', 'GOOD EVENING', 'NAMSTE', 'NAMASKAR', 'JAI SHREE KRISHNA',
  'VANAKKAM', 'SASRIYAKAL', 'NOMOSKAR'
];

// Hinglish Keywords (India-specific)
const HINGLISH_MEDICAL = [
  'KARAVU', 'KARAVANU', 'KARVU', 'KARNA', 'KARNA HAI',
  'KARANA', 'KARAVU CHE', 'KARVU CHE', 'KARNA HAI'
];

function fastClassify(message) {
  const upperMsg = message.toUpperCase().trim();
  const wordCount = message.split(' ').length;
  const cleanedMsg = message.replace(/[^a-zA-Z\s]/g, '').trim();
  
  // 1. Check for commands (ignore)
  const commands = ['UPLOAD PRESCRIPTION', 'MANUAL ENTRY', 'CHANGE BRANCH', 
                    'CONNECT TO PATIENT', 'CONVERT DONE', 'WAITING', 'NOT CONVERT',
                    'CONVERTED', 'ESCALATE'];
  for (const cmd of commands) {
    if (upperMsg.includes(cmd.toUpperCase())) {
      return { category: 'IGNORE', value: message, confidence: 1, method: 'rule' };
    }
  }
  
  // 2. Check for greetings (faster - direct match)
  const exactGreeting = GREETINGS.find(g => upperMsg === g || upperMsg.startsWith(g + ' ') || upperMsg.endsWith(' ' + g));
  if (exactGreeting) {
    return { category: 'GREETING', value: message, confidence: 0.99, method: 'rule' };
  }
  
  // 3. Check for test type + body part combination
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
  
  // 4. Hinglish check (India specific)
  let hasHinglishMedical = false;
  for (const word of HINGLISH_MEDICAL) {
    if (upperMsg.includes(word)) {
      hasHinglishMedical = true;
      break;
    }
  }
  
  // Test details (test + body part)
  if (hasTest && hasBody) {
    return { category: 'TEST_DETAILS', value: message, extractedTest: detectedTest, confidence: 0.99, method: 'rule' };
  }
  
  // Hinglish test details
  if (hasTest && hasHinglishMedical) {
    return { category: 'TEST_DETAILS', value: message, extractedTest: detectedTest, confidence: 0.95, method: 'rule_hinglish' };
  }
  
  // Test type only (single word)
  if (hasTest && wordCount === 1) {
    return { category: 'TEST_TYPE', value: detectedTest, confidence: 0.99, method: 'rule' };
  }
  
  // Test type with extra words
  if (hasTest && wordCount > 1 && !hasBody) {
    return { category: 'TEST_TYPE', value: detectedTest, confidence: 0.88, method: 'rule' };
  }
  
  // Test details (body part only)
  if (hasBody && !hasTest) {
    return { category: 'TEST_DETAILS', value: message, confidence: 0.85, method: 'rule' };
  }
  
  // 5. Check for name (Indian names pattern)
  const nameRegex = /^[A-Za-z\s]{2,30}$/;
  const isMedicalTerm = /scan|test|report|mri|ct|xray|ultrasound|usg|knee|brain|spine|chest|abdomen/i.test(message);
  
  if (nameRegex.test(cleanedMsg) && !isMedicalTerm && wordCount <= 3) {
    return { category: 'PATIENT_NAME', value: cleanedMsg, confidence: 0.92, method: 'rule' };
  }
  
  // Indian name pattern (First letter capital, followed by lowercase)
  const indianNameRegex = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)?$/;
  if (indianNameRegex.test(cleanedMsg) && wordCount <= 2 && !isMedicalTerm) {
    return { category: 'PATIENT_NAME', value: cleanedMsg, confidence: 0.88, method: 'rule' };
  }
  
  // 6. Check if it's a test details without test keyword (like "knee pain")
  if ((hasBody || wordCount >= 2) && !hasTest && !isMedicalTerm) {
    return { category: 'TEST_DETAILS', value: message, confidence: 0.75, method: 'rule' };
  }
  
  // 7. If nothing matches, return low confidence (needs AI)
  return { category: 'UNKNOWN', value: message, confidence: 0.35, method: 'needs_ai' };
}

// ============================================
// ✅ AI FALLBACK (With Timeout + Cache + Safe Parse)
// ============================================

async function aiClassify(message, context = {}) {
  const cacheKey = getCacheKey(message, context);
  
  // Check cache first
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`💾 Using cached AI result for: "${message.substring(0, 30)}..."`);
    return { ...cached, method: 'cache' };
  }
  
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const USE_DEEPSEEK = process.env.USE_DEEPSEEK === 'true';
    const AI_TIMEOUT = parseInt(process.env.AI_TIMEOUT) || 1500; // 1.5 seconds default
    
    if (!OPENAI_API_KEY) {
      console.log('⚠️ No AI API key, returning unknown');
      return { category: 'UNKNOWN', value: message, confidence: 0.5, method: 'fallback' };
    }
    
    const systemPrompt = `You are a medical WhatsApp assistant classifier.

Classify the user's message into ONE category:
- PATIENT_NAME: Human name (1-3 words, no medical terms)
- TEST_TYPE: Test keywords (MRI, CT, X-RAY, USG, ULTRASOUND, SCAN)
- TEST_DETAILS: Test + body part (MRI Knee, CT Brain) or body part alone
- GREETING: Hello, Hi, Hey, Good morning
- UNKNOWN: Anything else

Return ONLY JSON with no extra text:
{"category": "CATEGORY", "value": "cleaned value", "confidence": 0.0-1.0}`;

    const userPrompt = `Message: "${message}"\nContext: ${JSON.stringify(context)}`;

    let response;
    const startTime = Date.now();
    
    if (USE_DEEPSEEK) {
      // DeepSeek API
      response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: 'deepseek-chat',
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
    } else {
      // OpenAI GPT-4o-mini (cheaper + faster)
      response = await axios.post('https://api.openai.com/v1/chat/completions', {
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
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`🤖 AI response time: ${elapsed}ms`);
    
    const raw = response.data.choices[0].message.content;
    const aiResult = safeParseJSON(raw);
    
    if (!aiResult || !aiResult.category) {
      console.error('❌ Invalid AI response:', raw);
      return { category: 'UNKNOWN', value: message, confidence: 0.5, method: 'fallback' };
    }
    
    // Cache the result
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
// ✅ HYBRID CLASSIFIER (Main Function)
// ============================================

async function classifyMessage(message, patientContext = {}) {
  const startTime = Date.now();
  
  // Step 1: Fast rules-based classification
  const ruleResult = fastClassify(message);
  
  console.log(`⚡ Rules: ${ruleResult.category} (conf: ${ruleResult.confidence}, method: ${ruleResult.method})`);
  
  // Step 2: If confidence is high enough, return immediately
  if (ruleResult.confidence >= 0.8 && ruleResult.category !== 'UNKNOWN') {
    console.log(`✅ Using rules (${Date.now() - startTime}ms)`);
    return ruleResult;
  }
  
  // Step 3: If low confidence, fallback to AI (only ~15% cases)
  console.log(`🤖 AI fallback triggered...`);
  const aiResult = await aiClassify(message, patientContext);
  console.log(`✅ AI result (${Date.now() - startTime}ms): ${aiResult.category}`);
  
  return aiResult;
}

// ============================================
// ✅ STAGE-AWARE CLASSIFIER (With Context)
// ============================================

async function classifyWithStage(message, currentStage) {
  const upperMsg = message.toUpperCase().trim();
  const wordCount = message.split(' ').length;
  
  // If we know what stage we're in, prioritize that
  if (currentStage === 'awaiting_name') {
    // Expecting a name
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
    // Expecting test type
    for (const test of TEST_KEYWORDS) {
      if (upperMsg.includes(test)) {
        return { category: 'TEST_TYPE', value: test, confidence: 0.99, method: 'stage_rule' };
      }
    }
    // If message has body part, maybe patient misunderstood
    for (const body of BODY_PARTS) {
      if (upperMsg.includes(body)) {
        return { category: 'TEST_DETAILS', value: message, confidence: 0.85, method: 'stage_rule' };
      }
    }
  }
  
  if (currentStage === 'awaiting_test_details') {
    // Expecting test details (could be body part or more info)
    if (message.length > 2) {
      return { category: 'TEST_DETAILS', value: message, confidence: 0.92, method: 'stage_rule' };
    }
  }
  
  if (currentStage === 'executive_notified') {
    // Patient may be responding after notification
    if (message.length > 2) {
      return { category: 'MESSAGE', value: message, confidence: 0.85, method: 'stage_rule' };
    }
  }
  
  // Fallback to hybrid classifier
  return await classifyMessage(message, { currentStage });
}

// ============================================
// ✅ CLEAR CACHE FUNCTION (For admin panel)
// ============================================

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
// ✅ EXPORT MODULE
// ============================================

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
