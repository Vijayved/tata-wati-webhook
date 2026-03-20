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
    
    // Get all data
    const allPatients = await patientsCollection.find({}).toArray();
    const allMissCalls = await missCallsCollection.find({}).toArray();
    const allFollowups = await followupCollection.find({}).toArray();
    const allSessions = await chatSessionsCollection.find({}).toArray();
    const allMessages = await chatMessagesCollection.find({}).toArray();
    
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
    // ✅ PATIENTS WITHOUT REPLY (No executive action)
    // ============================================
    const patientsWithoutReply = allPatients.filter(p => 
      p.executiveActionTaken === false && 
      p.currentStage !== STAGES?.CONVERTED &&
      p.currentStage !== STAGES?.NOT_CONVERTED
    );
    
    // ============================================
    // ✅ PATIENTS WITH SINGLE MISS CALL
    // ============================================
    const singleMissCallPatients = allPatients.filter(p => (p.missCallCount || 1) === 1);
    
    // ============================================
    // ✅ TEMPLATE SENT STATUS
    // ============================================
    const templateSentPatients = allPatients.filter(p => 
      p.currentStage === STAGES?.EXECUTIVE_NOTIFIED ||
      p.currentStage === STAGES?.CONNECTED
    );
    
    // ============================================
    // ✅ ESCALATED PATIENTS (Waiting for manager action)
    // ============================================
    const escalatedPatients = allPatients.filter(p => 
      p.escalatedToManager === true && 
      p.escalatedResolved !== true
    );
    
    // ============================================
    // ✅ HIGH MISS CALL PATIENTS (3+ calls)
    // ============================================
    const highMissCallPatients = allPatients.filter(p => (p.missCallCount || 1) >= 3);
    
    // ============================================
    // ✅ WAITING PATIENTS (More than 2 hours)
    // ============================================
    const waitingPatients = allPatients.filter(p => {
      if (p.currentStage !== 'waiting') return false;
      const waitingTime = Date.now() - new Date(p.updatedAt);
      return waitingTime > 2 * 60 * 60 * 1000; // 2 hours
    });
    
    // ============================================
    // ✅ FOLLOW-UP STATS
    // ============================================
    const followupStats = {
      total: allFollowups.length,
      noReply: allFollowups.filter(f => f.type === 'no_reply').length,
      waiting: allFollowups.filter(f => f.type === 'waiting').length,
      escalation: allFollowups.filter(f => f.type === 'escalation').length,
      managerAction: allFollowups.filter(f => f.type === 'manager_action').length,
      today: allFollowups.filter(f => new Date(f.sentAt) >= today).length,
      last7Days: allFollowups.filter(f => new Date(f.sentAt) >= last7Days).length,
      last30Days: allFollowups.filter(f => new Date(f.sentAt) >= last30Days).length
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
    // ✅ BRANCH WISE TEST DISTRIBUTION & ALERTS
    // ============================================
    const branchTests = {};
    for (const patient of allPatients) {
      const branch = patient.branch || 'Unknown';
      if (!branchTests[branch]) {
        branchTests[branch] = {
          MRI: 0, CT: 0, 'X-RAY': 0, USG: 0, OTHER: 0,
          total: 0, converted: 0, pending: 0, waiting: 0, notConverted: 0,
          patientsWithNoReply: 0, singleMissCall: 0, highMissCall: 0,
          escalated: 0, waitingLong: 0
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
      
      if (patient.executiveActionTaken === false) branchTests[branch].patientsWithNoReply++;
      if ((patient.missCallCount || 1) === 1) branchTests[branch].singleMissCall++;
      if ((patient.missCallCount || 1) >= 3) branchTests[branch].highMissCall++;
      if (patient.escalatedToManager === true) branchTests[branch].escalated++;
      
      // Check waiting > 2 hours
      if (patient.currentStage === 'waiting') {
        const waitingTime = Date.now() - new Date(patient.updatedAt);
        if (waitingTime > 2 * 60 * 60 * 1000) branchTests[branch].waitingLong++;
      }
    }
    
    // ============================================
    // ✅ DAILY MISS CALLS (Last 7 Days)
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
        waitingLong: 0
      };
      executivePatients[branch] = [];
    }
    
    for (const patient of allPatients) {
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
        
        // Special flags
        if (patient.executiveActionTaken === false) executiveStats[branch].noReply++;
        if ((patient.missCallCount || 1) === 1) executiveStats[branch].singleMissCall++;
        if ((patient.missCallCount || 1) >= 3) executiveStats[branch].highMissCall++;
        if (patient.currentStage === 'executive_notified' || patient.currentStage === 'connected') executiveStats[branch].templateSent++;
        if (patient.escalatedToManager === true) executiveStats[branch].escalated++;
        
        // Check waiting > 2 hours
        if (patient.currentStage === 'waiting') {
          const waitingTime = Date.now() - new Date(patient.updatedAt);
          if (waitingTime > 2 * 60 * 60 * 1000) executiveStats[branch].waitingLong++;
        }
        
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
          noReplyFollowupCount: patient.noReplyFollowupCount || 0
        });
      }
    }
    
    // ============================================
    // ✅ MANAGER VIEW - Escalated Patients
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
      resolvedToday: allFollowups.filter(f => f.type === 'manager_action' && new Date(f.sentAt) >= today).length,
      pendingActions: allFollowups.filter(f => f.type === 'escalation' && f.status === 'escalated').length
    };
    
    // ============================================
    // ✅ OVERALL STATS
    // ============================================
    const totalPatients = allPatients.length;
    const pendingCount = await patientsCollection.countDocuments({ status: 'pending' });
    const convertedCount = await patientsCollection.countDocuments({ status: 'converted' });
    const waitingCount = await patientsCollection.countDocuments({ status: 'waiting' });
    const notConvertedCount = await patientsCollection.countDocuments({ status: 'not_converted' });
    
    const stageStats = {};
    if (STAGES) {
      for (const stage of Object.values(STAGES)) {
        stageStats[stage] = await patientsCollection.countDocuments({ currentStage: stage }) || 0;
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
    for (const patient of allPatients) {
      const testType = patient.testType || patient.testDetails || '';
      const upperTest = testType.toUpperCase();
      if (upperTest.includes('MRI')) overallTests.MRI++;
      else if (upperTest.includes('CT')) overallTests.CT++;
      else if (upperTest.includes('X-RAY') || upperTest.includes('XRAY')) overallTests['X-RAY']++;
      else if (upperTest.includes('USG') || upperTest.includes('ULTRASOUND')) overallTests.USG++;
      else overallTests.OTHER++;
    }
    
    const recentPatients = await patientsCollection.find().sort({ createdAt: -1 }).limit(50).toArray();
    const recentMissCalls = await missCallsCollection.find().sort({ createdAt: -1 }).limit(50).toArray();
    const topMissCallPatients = await patientsCollection.find().sort({ missCallCount: -1 }).limit(10).toArray();
    const recentFollowups = await followupCollection.find().sort({ sentAt: -1 }).limit(30).toArray();
    
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
    EXECUTIVES
  } = data;
  
  const dailyMissCallLabels = dailyMissCalls.map(d => d.date);
  const dailyMissCallValues = dailyMissCalls.map(d => d.count);
  
  const branchNames = Object.keys(branchTests);
  const branchMRIData = branchNames.map(b => branchTests[b]?.MRI || 0);
  const branchCTData = branchNames.map(b => branchTests[b]?.CT || 0);
  const branchXRayData = branchNames.map(b => branchTests[b]?.['X-RAY'] || 0);
  const branchUSGData = branchNames.map(b => branchTests[b]?.USG || 0);
  
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
      h1 { color: white; margin-bottom: 20px; font-size: 2.2em; }
      h2 { color: white; margin: 30px 0 15px; font-size: 1.6em; border-left: 4px solid #ffd700; padding-left: 15px; }
      h3 { color: #333; margin-bottom: 10px; font-size: 1.1em; }
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 25px; }
      .stat-card { background: white; border-radius: 12px; padding: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.2); transition: transform 0.2s; }
      .stat-card:hover { transform: translateY(-3px); }
      .stat-title { font-size: 0.7em; color: #666; text-transform: uppercase; letter-spacing: 1px; }
      .stat-value { font-size: 1.6em; font-weight: bold; color: #333; margin-top: 5px; }
      .misscall-card { background: linear-gradient(135deg, #ff6b6b, #ff8e8e); }
      .misscall-card .stat-title, .misscall-card .stat-value { color: white; }
      .alert-card { background: linear-gradient(135deg, #f59e0b, #ef4444); color: white; }
      .alert-card .stat-title, .alert-card .stat-value { color: white; }
      .escalation-card { background: linear-gradient(135deg, #dc2626, #991b1b); color: white; }
      .escalation-card .stat-title, .escalation-card .stat-value { color: white; }
      
      .branch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .branch-card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      .branch-header { background: linear-gradient(135deg, #075e54, #128C7E); color: white; padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; }
      .branch-name { font-weight: bold; font-size: 1.1em; }
      .branch-phone { font-size: 0.7em; opacity: 0.9; }
      .branch-stats { padding: 12px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #f8f9fa; }
      .branch-stat { text-align: center; padding: 5px; border-radius: 8px; background: white; }
      .branch-stat-number { font-size: 1.2em; font-weight: bold; }
      .branch-stat-label { font-size: 0.6em; color: #666; }
      .alert-row { background: #fff3e0; padding: 8px 12px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: 0.7em; border-top: 1px solid #fed7aa; }
      .alert-number { font-weight: bold; color: #f97316; }
      .blink-red { animation: blink 1s infinite; background-color: #ff6b6b !important; color: white !important; padding: 2px 8px; border-radius: 10px; display: inline-block; }
      @keyframes blink { 0% { opacity: 1; background-color: #ff6b6b; } 50% { opacity: 0.6; background-color: #ef4444; } 100% { opacity: 1; background-color: #ff6b6b; } }
      .high-miss-call { border-left: 4px solid #ff6b6b; background-color: #fff5f5; }
      .conversion-rate { padding: 8px 12px; text-align: center; background: #f0fdf4; border-top: 1px solid #bbf7d0; }
      .conversion-number { font-size: 1.2em; font-weight: bold; color: #16a34a; }
      
      .executive-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .executive-card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      .executive-header { background: linear-gradient(135deg, #7c3aed, #8b5cf6); color: white; padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; }
      .executive-name { font-weight: bold; font-size: 1.1em; }
      .executive-phone { font-size: 0.7em; opacity: 0.9; }
      .executive-stats { padding: 12px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #f8f9fa; }
      .executive-stat { text-align: center; }
      .executive-stat-number { font-size: 1em; font-weight: bold; }
      .executive-stat-label { font-size: 0.6em; color: #666; }
      .stage-row { padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 6px; border-top: 1px solid #eee; background: #fefce8; font-size: 0.7em; }
      .stage-badge { padding: 3px 8px; border-radius: 15px; font-size: 0.65em; }
      .alert-row-exec { padding: 8px 12px; display: flex; flex-wrap: wrap; justify-content: space-between; background: #fef2f2; border-top: 1px solid #fecaca; font-size: 0.7em; }
      .executive-detail-btn { background: #128C7E; color: white; border: none; padding: 5px 10px; border-radius: 5px; cursor: pointer; font-size: 0.7em; margin: 8px 15px; width: calc(100% - 30px); }
      .patient-list { display: none; margin: 0 15px 15px 15px; padding: 10px; background: #f8f9fa; border-radius: 8px; max-height: 250px; overflow-y: auto; font-size: 0.7em; }
      .patient-list.show { display: block; }
      .patient-item { padding: 6px; border-bottom: 1px solid #eee; }
      .no-reply { color: #ef4444; font-weight: bold; }
      
      .manager-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .manager-card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1); border-top: 4px solid #dc2626; }
      .manager-header { background: linear-gradient(135deg, #dc2626, #991b1b); color: white; padding: 12px 15px; }
      .escalated-patient { padding: 10px; border-bottom: 1px solid #eee; }
      .escalated-patient:last-child { border-bottom: none; }
      .escalated-action-btn { background: #128C7E; color: white; border: none; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 0.7em; margin-top: 5px; }
      
      .stage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 10px; margin-bottom: 25px; }
      .stage-card { background: white; border-radius: 10px; padding: 8px; text-align: center; border-left: 3px solid; }
      .stage-name { font-size: 0.6em; color: #666; text-transform: uppercase; }
      .stage-value { font-size: 1.2em; font-weight: bold; margin-top: 3px; }
      
      .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .chart-card { background: white; border-radius: 12px; padding: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      .recent-section { background: white; border-radius: 12px; padding: 20px; margin-bottom: 25px; overflow-x: auto; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      table { width: 100%; border-collapse: collapse; font-size: 0.75em; }
      th { background: #f8f9fa; padding: 8px; text-align: left; font-weight: 600; }
      td { padding: 8px; border-bottom: 1px solid #e2e8f0; }
      .badge { padding: 2px 6px; border-radius: 10px; font-size: 0.65em; font-weight: 600; }
      .badge-pending { background: #fef3c7; color: #92400e; }
      .badge-converted { background: #d1fae5; color: #065f46; }
      .badge-waiting { background: #dbeafe; color: #1e40af; }
      .top-patients-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
      .top-patient-card { background: #f8f9fa; border-radius: 10px; padding: 10px; border-left: 3px solid #ff6b6b; }
      .refresh-btn { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; margin-bottom: 15px; font-weight: bold; }
      .refresh-btn:hover { background: #5a67d8; }
      .last-updated { color: white; margin-bottom: 15px; font-size: 0.8em; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  </head>
  <body>
    <div class="container">
      <h1>🏥 Executive Dashboard - Complete Analytics</h1>
      
      <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Data</button>
      <div class="last-updated">Last updated: ${new Date().toLocaleString()}</div>
      
      <!-- Alert Cards -->
      <div class="stats-grid">
        <div class="stat-card alert-card"><div class="stat-title">⚠️ No Reply</div><div class="stat-value">${patientsWithoutReply.length}</div></div>
        <div class="stat-card alert-card"><div class="stat-title">📞 Single Miss Call</div><div class="stat-value">${singleMissCallPatients.length}</div></div>
        <div class="stat-card alert-card"><div class="stat-title">🔴 High Miss Call (3+)</div><div class="stat-value">${highMissCallPatients.length}</div></div>
        <div class="stat-card alert-card"><div class="stat-title">⏳ Waiting >2hrs</div><div class="stat-value">${waitingPatients.length}</div></div>
        <div class="stat-card escalation-card"><div class="stat-title">🚨 Escalated</div><div class="stat-value">${escalatedPatients.length}</div></div>
        <div class="stat-card"><div class="stat-title">📨 Template Sent</div><div class="stat-value">${templateSentPatients.length}</div></div>
      </div>
      
      <!-- Follow-up Stats -->
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-title">📢 Total Follow-ups</div><div class="stat-value">${followupStats.total}</div></div>
        <div class="stat-card"><div class="stat-title">⏰ No Reply</div><div class="stat-value">${followupStats.noReply}</div></div>
        <div class="stat-card"><div class="stat-title">⏳ Waiting</div><div class="stat-value">${followupStats.waiting}</div></div>
        <div class="stat-card escalation-card"><div class="stat-title">🚨 Escalations</div><div class="stat-value">${followupStats.escalation}</div></div>
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
        <div class="stat-card misscall-card"><div class="stat-title">Today's Miss Calls</div><div class="stat-value">${missCallToday}</div></div>
        <div class="stat-card"><div class="stat-title">Yesterday</div><div class="stat-value">${missCallYesterday}</div></div>
        <div class="stat-card"><div class="stat-title">Last 7 Days</div><div class="stat-value">${missCallLast7Days}</div></div>
      </div>
      
      <!-- Overall Test Distribution -->
      <h2>📊 Overall Test Distribution</h2>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-title">MRI</div><div class="stat-value">${overallTests.MRI}</div></div>
        <div class="stat-card"><div class="stat-title">CT</div><div class="stat-value">${overallTests.CT}</div></div>
        <div class="stat-card"><div class="stat-title">X-RAY</div><div class="stat-value">${overallTests['X-RAY']}</div></div>
        <div class="stat-card"><div class="stat-title">USG</div><div class="stat-value">${overallTests.USG}</div></div>
        <div class="stat-card"><div class="stat-title">Others</div><div class="stat-value">${overallTests.OTHER}</div></div>
      </div>
      
      <!-- Manager View - Escalated Patients -->
      <h2>🚨 Manager View - Escalated Patients</h2>
      <div class="manager-grid">
        <div class="manager-card">
          <div class="manager-header">
            <strong>⚠️ Escalated Patients (${managerView.totalEscalated})</strong>
            <div style="font-size: 0.7em;">Resolved Today: ${managerView.resolvedToday} | Pending Actions: ${managerView.pendingActions}</div>
          </div>
          <div style="max-height: 400px; overflow-y: auto;">
            ${managerView.escalatedPatients.length > 0 ? managerView.escalatedPatients.map(p => `
              <div class="escalated-patient">
                <strong>${p.patientName}</strong> (${p.patientPhone})<br>
                <small>Branch: ${p.branch} | Test: ${p.testType} - ${p.testDetails}</small><br>
                <small>Executive: ${p.executiveName} (${p.executiveNumber})</small><br>
                <small>Waiting: ${p.waitingTime} hours | Escalated: ${p.escalatedCount} times</small><br>
                <small>Escalated At: ${new Date(p.escalatedAt).toLocaleString()}</small><br>
                <button class="escalated-action-btn" onclick="alert('Action taken! In production, this would send reminder to executive.')">📢 Send Reminder to Executive</button>
              </div>
            `).join('') : '<div style="padding: 20px; text-align: center;">✅ No escalated patients</div>'}
          </div>
        </div>
      </div>
      
      <!-- Branch Wise Analytics -->
      <h2>🏢 Branch Wise Analytics</h2>
      <div class="branch-grid">
        ${Object.entries(branchTests).map(([branch, tests]) => `
          <div class="branch-card">
            <div class="branch-header">
              <div><div class="branch-name">${branch}</div><div class="branch-phone">📞 ${EXECUTIVES[branch] || 'Not set'}</div></div>
              <div style="font-size: 1.2em; font-weight: bold;">${tests.total} patients</div>
            </div>
            <div class="branch-stats">
              <div class="branch-stat"><div class="branch-stat-number" style="color: #10b981;">${tests.converted}</div><div class="branch-stat-label">Converted</div></div>
              <div class="branch-stat"><div class="branch-stat-number" style="color: #f59e0b;">${tests.pending}</div><div class="branch-stat-label">Pending</div></div>
              <div class="branch-stat"><div class="branch-stat-number" style="color: #3b82f6;">${tests.waiting}</div><div class="branch-stat-label">Waiting</div></div>
              <div class="branch-stat"><div class="branch-stat-number" style="color: #ef4444;">${tests.notConverted}</div><div class="branch-stat-label">Not Converted</div></div>
            </div>
            <div class="alert-row">
              <span>⚠️ No Reply: <span class="alert-number">${tests.patientsWithNoReply || 0}</span></span>
              <span>📞 Single Call: <span class="alert-number">${tests.singleMissCall || 0}</span></span>
              <span>🔴 High Call: <span class="alert-number ${tests.highMissCall > 0 ? 'blink-red' : ''}">${tests.highMissCall || 0}</span></span>
              <span>🚨 Escalated: <span class="alert-number">${tests.escalated || 0}</span></span>
              <span>⏳ Waiting >2hr: <span class="alert-number">${tests.waitingLong || 0}</span></span>
            </div>
            <div class="conversion-rate">
              <span class="conversion-number">${branchConversion[branch]?.rate || 0}%</span> Conversion Rate
              (${branchConversion[branch]?.converted || 0}/${branchConversion[branch]?.total || 0})
            </div>
          </div>
        `).join('')}
      </div>
      
      <!-- Executive Wise Stats -->
      <h2>👥 Executive Performance & Patient Tracking</h2>
      <div class="executive-grid">
        ${Object.entries(executiveStats).map(([branch, stats]) => `
          <div class="executive-card">
            <div class="executive-header">
              <div><div class="executive-name">${branch} Executive</div><div class="executive-phone">📞 ${stats.execNumber}</div></div>
              <div style="font-size: 1.2em; font-weight: bold;">${stats.total} patients</div>
            </div>
            <div class="executive-stats">
              <div class="executive-stat"><div class="executive-stat-number" style="color: #f59e0b;">${stats.pending}</div><div class="executive-stat-label">Pending</div></div>
              <div class="executive-stat"><div class="executive-stat-number" style="color: #10b981;">${stats.converted}</div><div class="executive-stat-label">Converted</div></div>
              <div class="executive-stat"><div class="executive-stat-number" style="color: #3b82f6;">${stats.waiting}</div><div class="executive-stat-label">Waiting</div></div>
              <div class="executive-stat"><div class="executive-stat-number" style="color: #ef4444;">${stats.notConverted}</div><div class="executive-stat-label">Not Converted</div></div>
            </div>
            <div class="stage-row">
              <span class="stage-badge" style="background:#fef3c7;">📌 Awaiting: ${stats.awaitingBranch}</span>
              <span class="stage-badge" style="background:#dbeafe;">✅ Selected: ${stats.branchSelected}</span>
              <span class="stage-badge" style="background:#fef3c7;">📝 Name: ${stats.awaitingName}</span>
              <span class="stage-badge" style="background:#fef3c7;">🔬 Test: ${stats.awaitingTestType + stats.awaitingTestDetails}</span>
              <span class="stage-badge" style="background:#ede9fe;">📢 Notified: ${stats.executiveNotified}</span>
              <span class="stage-badge" style="background:#c8e6e9;">💬 Connected: ${stats.connected}</span>
            </div>
            <div class="alert-row-exec">
              <span>⚠️ No Reply: <strong style="color:#ef4444;">${stats.noReply}</strong></span>
              <span>📞 Single Call: <strong style="color:#f97316;">${stats.singleMissCall}</strong></span>
              <span>🔴 High Call: <strong class="${stats.highMissCall > 0 ? 'blink-red' : ''}" style="color:#dc2626;">${stats.highMissCall}</strong></span>
              <span>🚨 Escalated: <strong style="color:#991b1b;">${stats.escalated}</strong></span>
              <span>⏳ Waiting >2hr: <strong style="color:#f97316;">${stats.waitingLong}</strong></span>
              <span>📨 Template Sent: <strong style="color:#10b981;">${stats.templateSent}</strong></span>
            </div>
            <button class="executive-detail-btn" onclick="togglePatientList('${branch}')">📋 View ${stats.total} Patients</button>
            <div id="patient-list-${branch}" class="patient-list">
              ${executivePatients[branch] && executivePatients[branch].length > 0 ? executivePatients[branch].slice(0, 30).map(p => `
                <div class="patient-item ${p.missCallCount >= 3 ? 'high-miss-call' : ''}">
                  <strong>${p.patientName || 'Unknown'}</strong> (${p.patientPhone})<br>
                  <small>Test: ${p.testDetails || p.testType || 'N/A'} | ${p.missCallCount} calls</small><br>
                  <small>Stage: ${p.currentStage || 'N/A'} | Status: ${p.status || 'N/A'}</small>
                  ${!p.executiveActionTaken ? '<span class="no-reply"> ⚠️ No reply</span>' : ''}
                  ${p.missCallCount >= 3 ? '<span class="blink-red"> 🔴 High Miss Call</span>' : ''}
                  ${p.escalatedToManager ? '<span style="color:#dc2626;"> 🚨 Escalated</span>' : ''}
                </div>
              `).join('') : '<div class="patient-item">No patients</div>'}
            </div>
          </div>
        `).join('')}
      </div>
      
      <!-- Stage Tracking -->
      <h2>📈 Stage Wise Tracking</h2>
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
        <div class="chart-card"><canvas id="dailyMissCallsChart"></canvas></div>
        <div class="chart-card"><canvas id="branchTestsChart"></canvas></div>
      </div>
      
      <!-- Top Miss Call Patients -->
      <h2>📞 Top Miss Call Patients (Most Active)</h2>
      <div class="top-patients-grid">
        ${topMissCallPatients.map(p => `
          <div class="top-patient-card ${p.missCallCount >= 3 ? 'high-miss-call' : ''}">
            <div style="font-weight: bold;">${p.patientName || 'Unknown'}</div>
            <div style="font-size: 0.75em;">${p.patientPhone}</div>
            <div style="color: #ff6b6b; font-weight: bold;">${p.missCallCount || 1} calls</div>
            <div style="font-size: 0.65em;">Branch: ${p.branch || 'N/A'} | ${p.status || 'pending'}</div>
            ${p.missCallCount >= 3 ? '<div class="blink-red" style="display:inline-block; margin-top:5px;">⚠️ High Miss Call</div>' : ''}
          </div>
        `).join('')}
      </div>
      
      <!-- Recent Patients -->
      <h2>🕒 Recent Patients (Last 50)</h2>
      <div class="recent-section">
        <table>
          <thead><tr><th>Patient</th><th>Phone</th><th>Branch</th><th>Tests</th><th>Stage</th><th>Status</th><th>Calls</th><th>Time</th></tr></thead>
          <tbody>
            ${recentPatients.slice(0, 50).map(p => `
              <tr class="${p.missCallCount >= 3 ? 'high-miss-call' : ''}">
                <td>${p.patientName || 'N/A'}${p.escalatedToManager ? ' 🚨' : ''}</td>
                <td>${p.patientPhone || 'N/A'}</td>
                <td>${p.branch || 'N/A'}</td>
                <td>${p.testDetails || p.testType || 'N/A'}</td>
                <td><span class="badge">${(p.currentStage || 'pending').replace(/_/g, ' ')}</span></td>
                <td><span class="badge badge-${p.status || 'pending'}">${p.status || 'pending'}</span></td>
                <td>${p.missCallCount || 1}${p.missCallCount >= 3 ? ' 🔴' : ''}</td>
                <td>${new Date(p.createdAt).toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      
      <!-- Recent Follow-ups -->
      <h2>📢 Recent Follow-ups</h2>
      <div class="recent-section">
        <table>
          <thead><tr><th>Type</th><th>Patient Phone</th><th>Executive</th><th>Count</th><th>Time</th></tr></thead>
          <tbody>
            ${recentFollowups.slice(0, 30).map(f => `
              <tr>
                <td><span class="badge">${f.type}</span></td>
                <td>${f.patientPhone || 'N/A'}</td>
                <td>${f.executiveNumber || 'N/A'}</td>
                <td>${f.waitingCount || f.noReplyFollowupCount || '-'}</td>
                <td>${new Date(f.sentAt).toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      
      <!-- Recent Miss Calls -->
      <h2>📞 Recent Miss Calls</h2>
      <div class="recent-section">
        <table>
          <thead><tr><th>Phone</th><th>Branch</th><th>Time</th></tr></thead>
          <tbody>
            ${recentMissCalls.slice(0, 30).map(m => `
              <tr><td>${m.phoneNumber || 'N/A'}</td><td>${m.branch || 'N/A'}</td><td>${new Date(m.createdAt).toLocaleString()}</td></tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    
    <script>
      function togglePatientList(branch) {
        document.getElementById('patient-list-' + branch).classList.toggle('show');
      }
      
      new Chart(document.getElementById('dailyMissCallsChart'), {
        type: 'line', data: { labels: ${JSON.stringify(dailyMissCallLabels)}, datasets: [{ label: 'Miss Calls', data: ${JSON.stringify(dailyMissCallValues)}, borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.1)', fill: true }] },
        options: { responsive: true }
      });
      
      new Chart(document.getElementById('branchTestsChart'), {
        type: 'bar', data: { labels: ${JSON.stringify(branchNames)}, datasets: [{ label: 'MRI', data: ${JSON.stringify(branchMRIData)}, backgroundColor: '#10b981' }, { label: 'CT', data: ${JSON.stringify(branchCTData)}, backgroundColor: '#3b82f6' }, { label: 'X-RAY', data: ${JSON.stringify(branchXRayData)}, backgroundColor: '#f59e0b' }, { label: 'USG', data: ${JSON.stringify(branchUSGData)}, backgroundColor: '#8b5cf6' }] },
        options: { responsive: true, scales: { y: { beginAtZero: true } } }
      });
      
      setTimeout(() => location.reload(), 60000);
    </script>
  </body>
  </html>
  `;
}

module.exports = router;
