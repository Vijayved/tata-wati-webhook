// dashboard.js - Complete Admin Dashboard with Executive & Manager Tracking
const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const patientsCollection = req.patientsCollection;
    const processedCollection = req.processedCollection;
    const missCallsCollection = req.missCallsCollection;
    const chatSessionsCollection = req.chatSessionsCollection;
    const chatMessagesCollection = req.chatMessagesCollection;
    const followupCollection = req.followupCollection;
    const STAGES = req.STAGES;
    const PORT = req.PORT;
    
    if (!patientsCollection || !processedCollection) {
      throw new Error('Database collections not available');
    }
    
    // Executive numbers mapping
    const EXECUTIVES = {
      'Naroda': process.env.NARODA_EXECUTIVE || '919106959092',
      'Usmanpura': process.env.USMANPURA_EXECUTIVE || '917490029085',
      'Vadaj': process.env.VADAJ_EXECUTIVE || '918488931212',
      'Satellite': process.env.SATELLITE_EXECUTIVE || '917490029085',
      'Maninagar': process.env.MANINAGAR_EXECUTIVE || '918488931212',
      'Bapunagar': process.env.BAPUNAGAR_EXECUTIVE || '919274682553',
      'Juhapura': process.env.JUHAPURA_EXECUTIVE || '919274682553',
      'Gandhinagar': process.env.GANDHINAGAR_EXECUTIVE || '919558591212',
      'Rajkot': process.env.RAJKOT_EXECUTIVE || '917880261858',
      'Sabarmati': process.env.SABARMATI_EXECUTIVE || '917880261858',
      'Manager': process.env.MANAGER_NUMBER || '917698011233'
    };
    
    // Get all data with deduplication
    const allPatients = await patientsCollection.find({}).toArray();
    const allMissCalls = await missCallsCollection.find({}).toArray();
    const allFollowups = await followupCollection.find({}).toArray();
    const allSessions = await chatSessionsCollection.find({}).toArray();
    const allMessages = await chatMessagesCollection.find({}).toArray();
    
    // Deduplicate patients by phone number (keep latest)
    const uniquePatients = new Map();
    for (const patient of allPatients) {
      const existing = uniquePatients.get(patient.patientPhone);
      if (!existing || new Date(patient.createdAt) > new Date(existing.createdAt)) {
        uniquePatients.set(patient.patientPhone, patient);
      }
    }
    const patients = Array.from(uniquePatients.values());
    
    // ============================================
    // ✅ DATE RANGES
    // ============================================
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const last7Days = new Date(today);
    last7Days.setDate(last7Days.getDate() - 7);
    
    const last30Days = new Date(today);
    last30Days.setDate(last30Days.getDate() - 30);
    
    // ============================================
    // ✅ ACTIVE CONVERSATIONS (Executive connected with patient)
    // ============================================
    const activeConversations = allSessions.filter(s => s.status === 'active');
    const connectedPatients = patients.filter(p => {
      const hasActiveSession = allSessions.some(s => 
        s.patientPhone === p.patientPhone && s.status === 'active'
      );
      return hasActiveSession && p.currentStage === 'connected';
    });
    
    // ============================================
    // ✅ PATIENTS WITHOUT REPLY
    // ============================================
    const patientsWithoutReply = patients.filter(p => 
      p.executiveActionTaken === false && 
      p.currentStage !== STAGES?.CONVERTED &&
      p.currentStage !== STAGES?.NOT_CONVERTED
    );
    
    // ============================================
    // ✅ PATIENTS WITH SINGLE MISS CALL
    // ============================================
    const singleMissCallPatients = patients.filter(p => (p.missCallCount || 1) === 1);
    
    // ============================================
    // ✅ TEMPLATE SENT STATUS
    // ============================================
    const templateSentPatients = patients.filter(p => 
      p.currentStage === STAGES?.EXECUTIVE_NOTIFIED ||
      p.currentStage === STAGES?.CONNECTED
    );
    
    // ============================================
    // ✅ ESCALATED PATIENTS
    // ============================================
    const escalatedPatients = patients.filter(p => 
      p.escalatedToManager === true && 
      p.escalatedResolved !== true
    );
    
    // ============================================
    // ✅ HIGH MISS CALL PATIENTS (3+ calls)
    // ============================================
    const highMissCallPatients = patients.filter(p => (p.missCallCount || 1) >= 3);
    
    // ============================================
    // ✅ WAITING PATIENTS (More than 2 hours)
    // ============================================
    const waitingPatients = patients.filter(p => {
      if (p.currentStage !== 'waiting') return false;
      const waitingTime = Date.now() - new Date(p.updatedAt);
      return waitingTime > 2 * 60 * 60 * 1000;
    });
    
    // ============================================
    // ✅ FOLLOW-UP STATS (Deduplicated)
    // ============================================
    const uniqueFollowups = new Map();
    for (const f of allFollowups) {
      const key = `${f.patientId}_${f.type}_${new Date(f.sentAt).toISOString().slice(0, 16)}`;
      if (!uniqueFollowups.has(key)) {
        uniqueFollowups.set(key, f);
      }
    }
    const followups = Array.from(uniqueFollowups.values());
    
    const followupStats = {
      total: followups.length,
      noReply: followups.filter(f => f.type === 'no_reply').length,
      waiting: followups.filter(f => f.type === 'waiting').length,
      escalation: followups.filter(f => f.type === 'escalation').length,
      managerAction: followups.filter(f => f.type === 'manager_action').length,
      statusReminder: followups.filter(f => f.type === 'status_reminder').length,
      today: followups.filter(f => new Date(f.sentAt) >= today).length,
      last7Days: followups.filter(f => new Date(f.sentAt) >= last7Days).length,
      last30Days: followups.filter(f => new Date(f.sentAt) >= last30Days).length
    };
    
    // ============================================
    // ✅ BRANCH WISE MISS CALLS
    // ============================================
    const branchMissCalls = {};
    const branchMissCallsToday = {};
    const branchMissCallsLast7Days = {};
    const branchMissCallsLast30Days = {};
    
    for (const call of allMissCalls) {
      const branch = call.branch || 'Unknown';
      const callDate = new Date(call.createdAt);
      
      branchMissCalls[branch] = (branchMissCalls[branch] || 0) + 1;
      if (callDate >= today) branchMissCallsToday[branch] = (branchMissCallsToday[branch] || 0) + 1;
      if (callDate >= last7Days) branchMissCallsLast7Days[branch] = (branchMissCallsLast7Days[branch] || 0) + 1;
      if (callDate >= last30Days) branchMissCallsLast30Days[branch] = (branchMissCallsLast30Days[branch] || 0) + 1;
    }
    
    // ============================================
    // ✅ BRANCH WISE TEST DISTRIBUTION
    // ============================================
    const branchTests = {};
    for (const patient of patients) {
      const branch = patient.branch || 'Unknown';
      if (!branchTests[branch]) {
        branchTests[branch] = {
          MRI: 0, CT: 0, 'X-RAY': 0, USG: 0, OTHER: 0,
          total: 0, converted: 0, pending: 0, waiting: 0, notConverted: 0,
          patientsWithNoReply: 0, singleMissCall: 0, highMissCall: 0,
          escalated: 0, waitingLong: 0, connected: 0
        };
      }
      
      const testType = patient.testType || patient.testDetails || '';
      const upperTest = testType.toUpperCase();
      
      if (upperTest.includes('MRI')) branchTests[branch].MRI++;
      else if (upperTest.includes('CT')) branchTests[branch].CT++;
      else if (upperTest.includes('X-RAY') || upperTest.includes('XRAY')) branchTests[branch]['X-RAY']++;
      else if (upperTest.includes('USG') || upperTest.includes('ULTRASOUND')) branchTests[branch].USG++;
      else branchTests[branch].OTHER++;
      
      branchTests[branch].total++;
      
      if (patient.status === 'converted') branchTests[branch].converted++;
      else if (patient.status === 'pending') branchTests[branch].pending++;
      else if (patient.status === 'waiting') branchTests[branch].waiting++;
      else if (patient.status === 'not_converted') branchTests[branch].notConverted++;
      
      if (patient.currentStage === 'connected') branchTests[branch].connected++;
      if (patient.executiveActionTaken === false) branchTests[branch].patientsWithNoReply++;
      if ((patient.missCallCount || 1) === 1) branchTests[branch].singleMissCall++;
      if ((patient.missCallCount || 1) >= 3) branchTests[branch].highMissCall++;
      if (patient.escalatedToManager === true) branchTests[branch].escalated++;
      
      if (patient.currentStage === 'waiting') {
        const waitingTime = Date.now() - new Date(patient.updatedAt);
        if (waitingTime > 2 * 60 * 60 * 1000) branchTests[branch].waitingLong++;
      }
    }
    
    // ============================================
    // ✅ DAILY MISS CALLS
    // ============================================
    const dailyMissCalls = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      
      const count = allMissCalls.filter(call => {
        const callDate = new Date(call.createdAt);
        return callDate >= date && callDate < nextDate;
      }).length;
      
      dailyMissCalls.push({
        date: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        count: count
      });
    }
    
    // ============================================
    // ✅ BRANCH CONVERSION RATE
    // ============================================
    const branchConversion = {};
    for (const [branch, tests] of Object.entries(branchTests)) {
      branchConversion[branch] = {
        rate: tests.total > 0 ? ((tests.converted / tests.total) * 100).toFixed(1) : 0,
        converted: tests.converted,
        total: tests.total
      };
    }
    
    // ============================================
    // ✅ EXECUTIVE WISE DETAILED STATS
    // ============================================
    const executiveStats = {};
    const executivePatients = {};
    
    for (const [branch, execNumber] of Object.entries(EXECUTIVES)) {
      if (branch === 'Manager') continue;
      executiveStats[branch] = {
        execNumber: execNumber,
        total: 0,
        pending: 0,
        converted: 0,
        waiting: 0,
        notConverted: 0,
        awaitingBranch: 0,
        branchSelected: 0,
        awaitingName: 0,
        awaitingTestType: 0,
        awaitingTestDetails: 0,
        executiveNotified: 0,
        connected: 0,
        noReply: 0,
        singleMissCall: 0,
        highMissCall: 0,
        templateSent: 0,
        escalated: 0,
        waitingLong: 0,
        activeChat: 0
      };
      executivePatients[branch] = [];
    }
    
    for (const patient of patients) {
      const branch = patient.branch;
      if (branch && EXECUTIVES[branch] && branch !== 'Manager') {
        executiveStats[branch].total++;
        
        // Status wise
        if (patient.status === 'pending') executiveStats[branch].pending++;
        else if (patient.status === 'converted') executiveStats[branch].converted++;
        else if (patient.status === 'waiting') executiveStats[branch].waiting++;
        else if (patient.status === 'not_converted') executiveStats[branch].notConverted++;
        
        // Stage wise
        if (patient.currentStage === 'awaiting_branch') executiveStats[branch].awaitingBranch++;
        else if (patient.currentStage === 'branch_selected') executiveStats[branch].branchSelected++;
        else if (patient.currentStage === 'awaiting_name') executiveStats[branch].awaitingName++;
        else if (patient.currentStage === 'awaiting_test_type') executiveStats[branch].awaitingTestType++;
        else if (patient.currentStage === 'awaiting_test_details') executiveStats[branch].awaitingTestDetails++;
        else if (patient.currentStage === 'executive_notified') executiveStats[branch].executiveNotified++;
        else if (patient.currentStage === 'connected') executiveStats[branch].connected++;
        
        // Active chat check
        const hasActiveSession = allSessions.some(s => 
          s.patientPhone === patient.patientPhone && s.status === 'active'
        );
        if (hasActiveSession && patient.currentStage === 'connected') {
          executiveStats[branch].activeChat++;
        }
        
        // Special flags
        if (patient.executiveActionTaken === false) executiveStats[branch].noReply++;
        if ((patient.missCallCount || 1) === 1) executiveStats[branch].singleMissCall++;
        if ((patient.missCallCount || 1) >= 3) executiveStats[branch].highMissCall++;
        if (patient.currentStage === 'executive_notified' || patient.currentStage === 'connected') executiveStats[branch].templateSent++;
        if (patient.escalatedToManager === true) executiveStats[branch].escalated++;
        
        if (patient.currentStage === 'waiting') {
          const waitingTime = Date.now() - new Date(patient.updatedAt);
          if (waitingTime > 2 * 60 * 60 * 1000) executiveStats[branch].waitingLong++;
        }
        
        // Get last message time
        const lastMessages = allMessages.filter(m => 
          m.sessionToken === patient.chatSessionToken
        ).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const lastMessage = lastMessages[0];
        
        executivePatients[branch].push({
          patientName: patient.patientName || 'Unknown',
          patientPhone: patient.patientPhone,
          testType: patient.testType,
          testDetails: patient.testDetails,
          status: patient.status,
          currentStage: patient.currentStage,
          createdAt: patient.createdAt,
          missCallCount: patient.missCallCount || 1,
          executiveActionTaken: patient.executiveActionTaken,
          lastMessageAt: patient.lastMessageAt,
          updatedAt: patient.updatedAt,
          escalatedToManager: patient.escalatedToManager,
          waitingFollowupCount: patient.waitingFollowupCount || 0,
          noReplyFollowupCount: patient.noReplyFollowupCount || 0,
          hasActiveSession: allSessions.some(s => s.patientPhone === patient.patientPhone && s.status === 'active'),
          lastMessage: lastMessage
        });
      }
    }
    
    // ============================================
    // ✅ MANAGER VIEW
    // ============================================
    const managerView = {
      escalatedPatients: escalatedPatients.map(p => ({
        patientName: p.patientName || 'Unknown',
        patientPhone: p.patientPhone,
        branch: p.branch,
        testType: p.testType,
        testDetails: p.testDetails,
        waitingCount: p.waitingFollowupCount || 0,
        escalatedCount: p.escalatedCount || 0,
        escalatedAt: p.escalatedAt,
        executiveNumber: p.executiveNumber,
        executiveName: Object.keys(EXECUTIVES).find(key => EXECUTIVES[key] === p.executiveNumber) || 'Unknown',
        waitingTime: Math.floor((Date.now() - new Date(p.updatedAt)) / (1000 * 60 * 60))
      })),
      totalEscalated: escalatedPatients.length,
      resolvedToday: followups.filter(f => f.type === 'manager_action' && new Date(f.sentAt) >= today).length,
      pendingActions: followups.filter(f => f.type === 'escalation' && f.status === 'escalated').length
    };
    
    // ============================================
    // ✅ OVERALL STATS
    // ============================================
    const totalPatients = patients.length;
    const pendingCount = patients.filter(p => p.status === 'pending').length;
    const convertedCount = patients.filter(p => p.status === 'converted').length;
    const waitingCount = patients.filter(p => p.status === 'waiting').length;
    const notConvertedCount = patients.filter(p => p.status === 'not_converted').length;
    
    const stageStats = {};
    if (STAGES) {
      for (const stage of Object.values(STAGES)) {
        stageStats[stage] = patients.filter(p => p.currentStage === stage).length;
      }
    }
    
    const missCallTotal = allMissCalls.length;
    const missCallToday = allMissCalls.filter(c => new Date(c.createdAt) >= today).length;
    const missCallYesterday = allMissCalls.filter(c => {
      const date = new Date(c.createdAt);
      return date >= yesterday && date < today;
    }).length;
    const missCallLast7Days = allMissCalls.filter(c => new Date(c.createdAt) >= last7Days).length;
    
    // Test type overall stats
    const overallTests = { MRI: 0, CT: 0, 'X-RAY': 0, USG: 0, OTHER: 0 };
    for (const patient of patients) {
      const testType = patient.testType || patient.testDetails || '';
      const upperTest = testType.toUpperCase();
      if (upperTest.includes('MRI')) overallTests.MRI++;
      else if (upperTest.includes('CT')) overallTests.CT++;
      else if (upperTest.includes('X-RAY') || upperTest.includes('XRAY')) overallTests['X-RAY']++;
      else if (upperTest.includes('USG') || upperTest.includes('ULTRASOUND')) overallTests.USG++;
      else overallTests.OTHER++;
    }
    
    const recentPatients = patients.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
    const recentMissCalls = allMissCalls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
    const topMissCallPatients = patients.sort((a, b) => (b.missCallCount || 0) - (a.missCallCount || 0)).slice(0, 10);
    const recentFollowups = followups.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)).slice(0, 30);
    
    res.send(getDashboardHTML({
      totalPatients,
      pendingCount,
      convertedCount,
      waitingCount,
      notConvertedCount,
      stageStats,
      missCallTotal,
      missCallToday,
      missCallYesterday,
      missCallLast7Days,
      branchMissCalls,
      branchMissCallsToday,
      branchMissCallsLast7Days,
      branchMissCallsLast30Days,
      branchTests,
      branchConversion,
      dailyMissCalls,
      overallTests,
      recentPatients,
      recentMissCalls,
      topMissCallPatients,
      executiveStats,
      executivePatients,
      patientsWithoutReply,
      singleMissCallPatients,
      templateSentPatients,
      highMissCallPatients,
      waitingPatients,
      escalatedPatients,
      managerView,
      followupStats,
      recentFollowups,
      activeConversations,
      connectedPatients,
      EXECUTIVES
    }));
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send(`<h2>Error: ${error.message}</h2><pre>${error.stack}</pre>`);
  }
});

function getDashboardHTML(data) {
  const {
    totalPatients,
    pendingCount,
    convertedCount,
    waitingCount,
    notConvertedCount,
    stageStats,
    missCallTotal,
    missCallToday,
    missCallYesterday,
    missCallLast7Days,
    branchTests,
    branchConversion,
    dailyMissCalls,
    overallTests,
    recentPatients,
    recentMissCalls,
    topMissCallPatients,
    executiveStats,
    executivePatients,
    patientsWithoutReply,
    singleMissCallPatients,
    templateSentPatients,
    highMissCallPatients,
    waitingPatients,
    escalatedPatients,
    managerView,
    followupStats,
    recentFollowups,
    activeConversations,
    connectedPatients,
    EXECUTIVES
  } = data;
  
  const dailyMissCallLabels = dailyMissCalls.map(d => d.date);
  const dailyMissCallValues = dailyMissCalls.map(d => d.count);
  
  const branchNames = Object.keys(branchTests);
  const branchTotalData = branchNames.map(b => branchTests[b]?.total || 0);
  const branchConvertedData = branchNames.map(b => branchTests[b]?.converted || 0);
  const branchConnectedData = branchNames.map(b => branchTests[b]?.connected || 0);
  
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Executive Dashboard - Complete Analytics</title>
    <meta http-equiv="refresh" content="60">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
      .container { max-width: 1600px; margin: 0 auto; }
      h1 { color: white; margin-bottom: 20px; font-size: 2em; }
      h2 { color: white; margin: 25px 0 15px; font-size: 1.4em; border-left: 4px solid #ffd700; padding-left: 15px; }
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 20px; }
      .stat-card { background: white; border-radius: 12px; padding: 12px; box-shadow: 0 5px 15px rgba(0,0,0,0.2); text-align: center; }
      .stat-title { font-size: 0.7em; color: #666; text-transform: uppercase; }
      .stat-value { font-size: 1.5em; font-weight: bold; color: #333; margin-top: 5px; }
      .alert-card { background: linear-gradient(135deg, #f59e0b, #ef4444); }
      .alert-card .stat-title, .alert-card .stat-value { color: white; }
      .misscall-card { background: linear-gradient(135deg, #ff6b6b, #ff8e8e); }
      .misscall-card .stat-title, .misscall-card .stat-value { color: white; }
      .connected-card { background: linear-gradient(135deg, #10b981, #059669); }
      .connected-card .stat-title, .connected-card .stat-value { color: white; }
      .blink-red { animation: blink 1s infinite; background-color: #ff6b6b !important; color: white !important; padding: 2px 6px; border-radius: 8px; display: inline-block; }
      @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
      
      .executive-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .executive-card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      .executive-header { background: linear-gradient(135deg, #075e54, #128C7E); color: white; padding: 12px 15px; display: flex; justify-content: space-between; }
      .executive-name { font-weight: bold; }
      .executive-phone { font-size: 0.7em; opacity: 0.8; }
      .executive-stats { padding: 12px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; background: #f8f9fa; text-align: center; }
      .executive-stat-number { font-size: 1.1em; font-weight: bold; }
      .executive-stat-label { font-size: 0.6em; color: #666; }
      .stage-row { padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 6px; background: #fefce8; font-size: 0.7em; }
      .stage-badge { padding: 3px 8px; border-radius: 15px; font-size: 0.65em; }
      .alert-row-exec { padding: 8px 12px; display: flex; flex-wrap: wrap; justify-content: space-between; background: #fef2f2; font-size: 0.7em; }
      .executive-detail-btn { background: #128C7E; color: white; border: none; padding: 6px 12px; border-radius: 5px; cursor: pointer; margin: 10px 15px; width: calc(100% - 30px); }
      .patient-list { display: none; margin: 0 15px 15px; padding: 10px; background: #f8f9fa; border-radius: 8px; max-height: 250px; overflow-y: auto; font-size: 0.7em; }
      .patient-list.show { display: block; }
      .patient-item { padding: 6px; border-bottom: 1px solid #eee; }
      .connected-badge { background: #10b981; color: white; padding: 2px 6px; border-radius: 10px; font-size: 0.65em; display: inline-block; margin-left: 5px; }
      .no-reply { color: #ef4444; font-weight: bold; }
      .high-miss-call { border-left: 3px solid #ff6b6b; background: #fff5f5; padding-left: 8px; }
      
      .stage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; margin-bottom: 20px; }
      .stage-card { background: white; border-radius: 8px; padding: 8px; text-align: center; }
      .stage-name { font-size: 0.6em; color: #666; }
      .stage-value { font-size: 1.1em; font-weight: bold; }
      
      .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .chart-card { background: white; border-radius: 12px; padding: 15px; }
      .recent-section { background: white; border-radius: 12px; padding: 15px; margin-bottom: 20px; overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 0.7em; }
      th, td { padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0; }
      th { background: #f8f9fa; }
      .badge { padding: 2px 6px; border-radius: 10px; font-size: 0.65em; }
      .top-patients-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
      .top-patient-card { background: #f8f9fa; border-radius: 8px; padding: 8px; border-left: 3px solid #ff6b6b; }
      .refresh-btn { background: #667eea; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin-bottom: 15px; }
      .last-updated { color: white; margin-bottom: 15px; font-size: 0.8em; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  </head>
  <body>
    <div class="container">
      <h1>🏥 Executive Dashboard - Complete Analytics</h1>
      <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
      <div class="last-updated">Updated: ${new Date().toLocaleString()}</div>
      
      <!-- Alert Cards -->
      <div class="stats-grid">
        <div class="stat-card alert-card"><div class="stat-title">⚠️ No Reply</div><div class="stat-value">${patientsWithoutReply.length}</div></div>
        <div class="stat-card alert-card"><div class="stat-title">📞 Single Call</div><div class="stat-value">${singleMissCallPatients.length}</div></div>
        <div class="stat-card alert-card"><div class="stat-title">🔴 High Call (3+)</div><div class="stat-value">${highMissCallPatients.length}</div></div>
        <div class="stat-card alert-card"><div class="stat-title">⏳ Waiting >2hr</div><div class="stat-value">${waitingPatients.length}</div></div>
        <div class="stat-card alert-card"><div class="stat-title">🚨 Escalated</div><div class="stat-value">${escalatedPatients.length}</div></div>
        <div class="stat-card connected-card"><div class="stat-title">💬 Active Chats</div><div class="stat-value">${activeConversations.length}</div></div>
        <div class="stat-card connected-card"><div class="stat-title">✅ Connected</div><div class="stat-value">${connectedPatients.length}</div></div>
        <div class="stat-card"><div class="stat-title">📨 Template Sent</div><div class="stat-value">${templateSentPatients.length}</div></div>
      </div>
      
      <!-- Follow-up Stats -->
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-title">📢 Total Follow-ups</div><div class="stat-value">${followupStats.total}</div></div>
        <div class="stat-card"><div class="stat-title">⏰ No Reply</div><div class="stat-value">${followupStats.noReply}</div></div>
        <div class="stat-card"><div class="stat-title">⏳ Waiting</div><div class="stat-value">${followupStats.waiting}</div></div>
        <div class="stat-card"><div class="stat-title">🚨 Escalations</div><div class="stat-value">${followupStats.escalation}</div></div>
        <div class="stat-card"><div class="stat-title">⏰ Status Reminder</div><div class="stat-value">${followupStats.statusReminder || 0}</div></div>
        <div class="stat-card"><div class="stat-title">👨‍💼 Manager Actions</div><div class="stat-value">${followupStats.managerAction}</div></div>
        <div class="stat-card"><div class="stat-title">📅 Today</div><div class="stat-value">${followupStats.today}</div></div>
      </div>
      
      <!-- Overall Stats -->
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-title">Total Patients</div><div class="stat-value">${totalPatients}</div></div>
        <div class="stat-card"><div class="stat-title">Pending</div><div class="stat-value">${pendingCount}</div></div>
        <div class="stat-card"><div class="stat-title">Converted</div><div class="stat-value">${convertedCount}</div></div>
        <div class="stat-card"><div class="stat-title">Waiting</div><div class="stat-value">${waitingCount}</div></div>
        <div class="stat-card"><div class="stat-title">Not Converted</div><div class="stat-value">${notConvertedCount}</div></div>
        <div class="stat-card misscall-card"><div class="stat-title">Total Miss Calls</div><div class="stat-value">${missCallTotal}</div></div>
        <div class="stat-card"><div class="stat-title">Today</div><div class="stat-value">${missCallToday}</div></div>
        <div class="stat-card"><div class="stat-title">Yesterday</div><div class="stat-value">${missCallYesterday}</div></div>
        <div class="stat-card"><div class="stat-title">Last 7 Days</div><div class="stat-value">${missCallLast7Days}</div></div>
      </div>
      
      <!-- Test Distribution -->
      <h2>📊 Test Distribution</h2>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-title">MRI</div><div class="stat-value">${overallTests.MRI}</div></div>
        <div class="stat-card"><div class="stat-title">CT</div><div class="stat-value">${overallTests.CT}</div></div>
        <div class="stat-card"><div class="stat-title">X-RAY</div><div class="stat-value">${overallTests['X-RAY']}</div></div>
        <div class="stat-card"><div class="stat-title">USG</div><div class="stat-value">${overallTests.USG}</div></div>
        <div class="stat-card"><div class="stat-title">Others</div><div class="stat-value">${overallTests.OTHER}</div></div>
      </div>
      
      <!-- Manager View -->
      <h2>🚨 Manager View - Escalated Patients</h2>
      <div class="executive-grid">
        <div class="executive-card">
          <div class="executive-header"><strong>⚠️ Escalated Patients (${managerView.totalEscalated})</strong></div>
          <div style="max-height: 300px; overflow-y: auto; padding: 10px;">
            ${managerView.escalatedPatients.length > 0 ? managerView.escalatedPatients.map(p => `
              <div class="patient-item" style="border-bottom: 1px solid #eee; margin-bottom: 8px;">
                <strong>${p.patientName}</strong> (${p.patientPhone})<br>
                <small>Branch: ${p.branch} | Test: ${p.testType} - ${p.testDetails}</small><br>
                <small>Executive: ${p.executiveName} | Waiting: ${p.waitingTime} hours</small>
              </div>
            `).join('') : '<div style="padding: 20px; text-align: center;">✅ No escalated patients</div>'}
          </div>
        </div>
      </div>
      
      <!-- Executive Stats -->
      <h2>👥 Executive Performance</h2>
      <div class="executive-grid">
        ${Object.entries(executiveStats).map(([branch, stats]) => `
          <div class="executive-card">
            <div class="executive-header">
              <div><div class="executive-name">${branch}</div><div class="executive-phone">${stats.execNumber}</div></div>
              <div style="font-weight: bold;">${stats.total} patients</div>
            </div>
            <div class="executive-stats">
              <div><div class="executive-stat-number" style="color:#f59e0b;">${stats.pending}</div><div class="executive-stat-label">Pending</div></div>
              <div><div class="executive-stat-number" style="color:#10b981;">${stats.converted}</div><div class="executive-stat-label">Converted</div></div>
              <div><div class="executive-stat-number" style="color:#3b82f6;">${stats.waiting}</div><div class="executive-stat-label">Waiting</div></div>
              <div><div class="executive-stat-number" style="color:#ef4444;">${stats.notConverted}</div><div class="executive-stat-label">Not Conv</div></div>
              <div><div class="executive-stat-number" style="color:#10b981;">${stats.activeChat}</div><div class="executive-stat-label">Active Chats</div></div>
            </div>
            <div class="stage-row">
              <span class="stage-badge" style="background:#fef3c7;">📌 Await: ${stats.awaitingBranch}</span>
              <span class="stage-badge" style="background:#dbeafe;">✅ Selected: ${stats.branchSelected}</span>
              <span class="stage-badge" style="background:#fef3c7;">📝 Name: ${stats.awaitingName}</span>
              <span class="stage-badge" style="background:#fef3c7;">🔬 Test: ${stats.awaitingTestType + stats.awaitingTestDetails}</span>
              <span class="stage-badge" style="background:#ede9fe;">📢 Notified: ${stats.executiveNotified}</span>
              <span class="stage-badge" style="background:#c8e6e9;">💬 Connected: ${stats.connected}</span>
            </div>
            <div class="alert-row-exec">
              <span>⚠️ No Reply: <strong style="color:#ef4444;">${stats.noReply}</strong></span>
              <span>📞 Single: ${stats.singleMissCall}</span>
              <span>🔴 High: <span class="${stats.highMissCall > 0 ? 'blink-red' : ''}">${stats.highMissCall}</span></span>
              <span>🚨 Escalated: ${stats.escalated}</span>
              <span>💬 Active Chat: ${stats.activeChat}</span>
            </div>
            <button class="executive-detail-btn" onclick="togglePatientList('${branch}')">📋 View ${stats.total} Patients</button>
            <div id="patient-list-${branch}" class="patient-list">
              ${executivePatients[branch] && executivePatients[branch].length > 0 ? executivePatients[branch].slice(0, 30).map(p => `
                <div class="patient-item ${p.missCallCount >= 3 ? 'high-miss-call' : ''}">
                  <strong>${p.patientName}</strong> (${p.patientPhone})
                  ${p.hasActiveSession ? '<span class="connected-badge">💬 Active Chat</span>' : ''}
                  <br>
                  <small>Test: ${p.testDetails || p.testType || 'N/A'} | ${p.missCallCount} calls</small><br>
                  <small>Stage: ${p.currentStage || 'N/A'} | Status: ${p.status || 'N/A'}</small>
                  ${!p.executiveActionTaken ? '<span class="no-reply"> ⚠️ No reply</span>' : ''}
                  ${p.missCallCount >= 3 ? '<span class="blink-red"> 🔴 High Call</span>' : ''}
                </div>
              `).join('') : '<div>No patients</div>'}
            </div>
          </div>
        `).join('')}
      </div>
      
      <!-- Stage Tracking -->
      <h2>📈 Stage Tracking</h2>
      <div class="stage-grid">
        <div class="stage-card"><div class="stage-name">Awaiting Branch</div><div class="stage-value">${stageStats.awaiting_branch || 0}</div></div>
        <div class="stage-card"><div class="stage-name">Branch Selected</div><div class="stage-value">${stageStats.branch_selected || 0}</div></div>
        <div class="stage-card"><div class="stage-name">Awaiting Name</div><div class="stage-value">${stageStats.awaiting_name || 0}</div></div>
        <div class="stage-card"><div class="stage-name">Awaiting Test</div><div class="stage-value">${(stageStats.awaiting_test_type || 0) + (stageStats.awaiting_test_details || 0)}</div></div>
        <div class="stage-card"><div class="stage-name">Notified</div><div class="stage-value">${stageStats.executive_notified || 0}</div></div>
        <div class="stage-card"><div class="stage-name">Connected</div><div class="stage-value">${stageStats.connected || 0}</div></div>
        <div class="stage-card"><div class="stage-name">Converted</div><div class="stage-value">${stageStats.converted || 0}</div></div>
        <div class="stage-card"><div class="stage-name">Waiting</div><div class="stage-value">${stageStats.waiting || 0}</div></div>
        <div class="stage-card"><div class="stage-name">Escalated</div><div class="stage-value">${stageStats.escalated || 0}</div></div>
      </div>
      
      <!-- Charts -->
      <div class="charts-grid">
        <div class="chart-card"><canvas id="dailyChart"></canvas></div>
        <div class="chart-card"><canvas id="branchChart"></canvas></div>
      </div>
      
      <!-- Top Miss Call Patients -->
      <h2>📞 Top Miss Call Patients</h2>
      <div class="top-patients-grid">
        ${topMissCallPatients.map(p => `
          <div class="top-patient-card ${p.missCallCount >= 3 ? 'high-miss-call' : ''}">
            <strong>${p.patientName || 'Unknown'}</strong><br>
            <small>${p.patientPhone}</small><br>
            <span style="color:#ff6b6b;">${p.missCallCount || 1} calls</span><br>
            <small>${p.branch || 'N/A'} | ${p.status || 'pending'}</small>
          </div>
        `).join('')}
      </div>
      
      <!-- Recent Patients -->
      <h2>🕒 Recent Patients</h2>
      <div class="recent-section">
        <table><thead><tr><th>Patient</th><th>Phone</th><th>Branch</th><th>Test</th><th>Stage</th><th>Status</th><th>Calls</th><th>Active Chat</th><th>Time</th> </tr</thead>
        <tbody>${recentPatients.slice(0, 30).map(p => ` <tr class="${p.missCallCount >= 3 ? 'high-miss-call' : ''}">
          <td>${p.patientName || 'N/A'}${p.escalatedToManager ? ' 🚨' : ''}</td>
          <td>${p.patientPhone || 'N/A'}</td>
          <td>${p.branch || 'N/A'}</td>
          <td>${p.testDetails || p.testType || 'N/A'}</td>
          <td>${(p.currentStage || 'pending').replace(/_/g, ' ')}</td>
          <td>${p.status || 'pending'}</td>
          <td>${p.missCallCount || 1}</td>
          <td>${p.currentStage === 'connected' ? '✅ Yes' : '❌ No'}</td>
          <td>${new Date(p.createdAt).toLocaleString()}</td>
        </tr>`).join('')}</tbody>
        </table>
      </div>
      
      <!-- Recent Follow-ups -->
      <h2>📢 Recent Follow-ups</h2>
      <div class="recent-section">
        <table><thead><tr><th>Type</th><th>Patient Phone</th><th>Executive</th><th>Count</th><th>Time</th></tr></thead>
        <tbody>${recentFollowups.slice(0, 30).map(f => `<tr>
          <td><span class="badge">${f.type}</span></td>
          <td>${f.patientPhone || 'N/A'}</td>
          <td>${f.executiveNumber || 'N/A'}</td>
          <td>${f.waitingCount || f.noReplyFollowupCount || '-'}</td>
          <td>${new Date(f.sentAt).toLocaleString()}</td>
        </tr>`).join('')}</tbody>
        </table>
      </div>
      
      <!-- Recent Miss Calls -->
      <h2>📞 Recent Miss Calls</h2>
      <div class="recent-section">
        <table><thead><tr><th>Phone</th><th>Branch</th><th>Time</th></tr></thead>
        <tbody>${recentMissCalls.slice(0, 30).map(m => `<tr>
          <td>${m.phoneNumber || 'N/A'}</td>
          <td>${m.branch || 'N/A'}</td>
          <td>${new Date(m.createdAt).toLocaleString()}</td>
        </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
    
    <script>
      function togglePatientList(branch) {
        const el = document.getElementById('patient-list-' + branch);
        if (el) el.classList.toggle('show');
      }
      new Chart(document.getElementById('dailyChart'), {
        type: 'line',
        data: { labels: ${JSON.stringify(dailyMissCallLabels)}, datasets: [{ label: 'Miss Calls', data: ${JSON.stringify(dailyMissCallValues)}, borderColor: '#f97316', fill: true }] }
      });
      new Chart(document.getElementById('branchChart'), {
        type: 'bar',
        data: { labels: ${JSON.stringify(branchNames)}, datasets: [{ label: 'Total', data: ${JSON.stringify(branchTotalData)}, backgroundColor: '#075e54' }, { label: 'Converted', data: ${JSON.stringify(branchConvertedData)}, backgroundColor: '#10b981' }, { label: 'Connected', data: ${JSON.stringify(branchConnectedData)}, backgroundColor: '#3b82f6' }] }
      });
      setTimeout(() => location.reload(), 60000);
    </script>
  </body>
  </html>
  `;
}

module.exports = router;
