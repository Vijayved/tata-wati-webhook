// dashboard.js - Complete Admin Dashboard with Branch-wise Analytics
const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const patientsCollection = req.patientsCollection;
    const processedCollection = req.processedCollection;
    const missCallsCollection = req.missCallsCollection;
    const STAGES = req.STAGES;
    const PORT = req.PORT;
    
    if (!patientsCollection || !processedCollection) {
      throw new Error('Database collections not available');
    }
    
    // ============================================
    // ✅ EXECUTIVE NUMBERS (from env or hardcoded)
    // ============================================
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
      'Sabarmati': process.env.SABARMATI_EXECUTIVE || '917880261858'
    };
    
    // Get all patients
    const allPatients = await patientsCollection.find().toArray();
    const allMissCalls = await missCallsCollection.find().toArray();
    
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
      
      if (callDate >= today) {
        branchMissCallsToday[branch] = (branchMissCallsToday[branch] || 0) + 1;
      }
      if (callDate >= last7Days) {
        branchMissCallsLast7Days[branch] = (branchMissCallsLast7Days[branch] || 0) + 1;
      }
      if (callDate >= last30Days) {
        branchMissCallsLast30Days[branch] = (branchMissCallsLast30Days[branch] || 0) + 1;
      }
    }
    
    // ============================================
    // ✅ BRANCH WISE TEST DISTRIBUTION
    // ============================================
    const branchTests = {};
    const testTypes = ['MRI', 'CT', 'X-RAY', 'XRAY', 'USG', 'ULTRASOUND', 'SONOGRAPHY', 'OTHER'];
    
    for (const patient of allPatients) {
      const branch = patient.branch || 'Unknown';
      if (!branchTests[branch]) {
        branchTests[branch] = {
          MRI: 0, CT: 0, 'X-RAY': 0, USG: 0, OTHER: 0,
          total: 0,
          converted: 0,
          pending: 0,
          waiting: 0,
          notConverted: 0
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
    // ✅ BRANCH WISE CONVERSION RATE
    // ============================================
    const branchConversion = {};
    for (const [branch, tests] of Object.entries(branchTests)) {
      if (tests.total > 0) {
        branchConversion[branch] = {
          rate: ((tests.converted / tests.total) * 100).toFixed(1),
          converted: tests.converted,
          total: tests.total
        };
      } else {
        branchConversion[branch] = { rate: 0, converted: 0, total: 0 };
      }
    }
    
    // ============================================
    // ✅ EXECUTIVE WISE PATIENT COUNT
    // ============================================
    const executiveStats = {};
    const executivePatients = {};
    
    for (const [branch, execNumber] of Object.entries(EXECUTIVES)) {
      executiveStats[branch] = {
        execNumber: execNumber,
        total: 0,
        pending: 0,
        converted: 0,
        waiting: 0,
        notConverted: 0,
        awaitingBranch: 0,
        branchSelected: 0,
        executiveNotified: 0,
        connected: 0
      };
      executivePatients[branch] = [];
    }
    
    for (const patient of allPatients) {
      const branch = patient.branch;
      if (branch && EXECUTIVES[branch]) {
        executiveStats[branch].total++;
        if (patient.status === 'pending') executiveStats[branch].pending++;
        else if (patient.status === 'converted') executiveStats[branch].converted++;
        else if (patient.status === 'waiting') executiveStats[branch].waiting++;
        else if (patient.status === 'not_converted') executiveStats[branch].notConverted++;
        
        if (patient.currentStage === 'awaiting_branch') executiveStats[branch].awaitingBranch++;
        else if (patient.currentStage === 'branch_selected') executiveStats[branch].branchSelected++;
        else if (patient.currentStage === 'executive_notified') executiveStats[branch].executiveNotified++;
        else if (patient.currentStage === 'connected') executiveStats[branch].connected++;
        
        executivePatients[branch].push({
          patientName: patient.patientName,
          patientPhone: patient.patientPhone,
          testType: patient.testType,
          testDetails: patient.testDetails,
          status: patient.status,
          currentStage: patient.currentStage,
          createdAt: patient.createdAt,
          missCallCount: patient.missCallCount || 1
        });
      }
    }
    
    // ============================================
    // ✅ OVERALL STATS
    // ============================================
    const totalPatients = allPatients.length;
    const pendingCount = await patientsCollection.countDocuments({ status: 'pending' });
    const convertedCount = await patientsCollection.countDocuments({ status: 'converted' });
    const waitingCount = await patientsCollection.countDocuments({ status: 'waiting' });
    const notConvertedCount = await patientsCollection.countDocuments({ status: 'not_converted' });
    
    const stageStats = {};
    for (const stage of Object.values(STAGES)) {
      stageStats[stage] = await patientsCollection.countDocuments({ currentStage: stage }) || 0;
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
    
    const branchStats = await missCallsCollection.aggregate([
      { $group: { _id: '$branch', count: { $sum: 1 } } }
    ]).toArray();
    
    const branchMissCallMap = {};
    branchStats.forEach(b => { branchMissCallMap[b._id] = b.count; });
    
    const recentPatients = await patientsCollection.find()
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();
    
    const recentMissCalls = await missCallsCollection.find()
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();
    
    const topMissCallPatients = await patientsCollection.find()
      .sort({ missCallCount: -1 })
      .limit(5)
      .toArray();
    
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
      branchMissCallMap,
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
      EXECUTIVES,
      PORT
    }));
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send(`<h2>Error: ${error.message}</h2>`);
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
    branchMissCallMap,
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
    EXECUTIVES,
    PORT
  } = data;
  
  // Prepare chart data
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
    <meta http-equiv="refresh" content="30">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
      .container { max-width: 1600px; margin: 0 auto; }
      h1 { color: white; margin-bottom: 20px; font-size: 2.2em; }
      h2 { color: white; margin: 30px 0 15px; font-size: 1.6em; border-left: 4px solid #ffd700; padding-left: 15px; }
      h3 { color: #333; margin-bottom: 10px; font-size: 1.2em; }
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 25px; }
      .stat-card { background: white; border-radius: 12px; padding: 18px; box-shadow: 0 5px 15px rgba(0,0,0,0.2); transition: transform 0.2s; }
      .stat-card:hover { transform: translateY(-3px); }
      .stat-title { font-size: 0.8em; color: #666; text-transform: uppercase; letter-spacing: 1px; }
      .stat-value { font-size: 2em; font-weight: bold; color: #333; margin-top: 5px; }
      .stat-change { font-size: 0.7em; margin-top: 5px; }
      .stat-up { color: #10b981; }
      .stat-down { color: #ef4444; }
      .misscall-card { background: linear-gradient(135deg, #ff6b6b, #ff8e8e); }
      .misscall-card .stat-title, .misscall-card .stat-value { color: white; }
      
      .branch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .branch-card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      .branch-header { background: linear-gradient(135deg, #075e54, #128C7E); color: white; padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; }
      .branch-name { font-weight: bold; font-size: 1.1em; }
      .branch-phone { font-size: 0.7em; opacity: 0.9; }
      .branch-stats { padding: 15px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #f8f9fa; }
      .branch-stat { text-align: center; padding: 5px; border-radius: 8px; background: white; }
      .branch-stat-number { font-size: 1.2em; font-weight: bold; }
      .branch-stat-label { font-size: 0.6em; color: #666; }
      .test-distribution { padding: 12px 15px; border-top: 1px solid #eee; }
      .test-badge { display: inline-block; padding: 4px 8px; border-radius: 20px; font-size: 0.7em; margin: 3px; }
      .test-mri { background: #d1fae5; color: #065f46; }
      .test-ct { background: #dbeafe; color: #1e40af; }
      .test-xray { background: #fef3c7; color: #92400e; }
      .test-usg { background: #ede9fe; color: #5b21b6; }
      .test-other { background: #f1f5f9; color: #475569; }
      .misscall-stats { padding: 12px 15px; background: #fff7ed; border-top: 1px solid #fed7aa; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
      .misscall-stat { text-align: center; }
      .misscall-stat-number { font-weight: bold; font-size: 1.1em; color: #f97316; }
      .misscall-stat-label { font-size: 0.6em; color: #9a3412; }
      .conversion-rate { padding: 10px 15px; text-align: center; background: #f0fdf4; border-top: 1px solid #bbf7d0; }
      .conversion-number { font-size: 1.3em; font-weight: bold; color: #16a34a; }
      
      .executive-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .executive-card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      .executive-header { background: linear-gradient(135deg, #7c3aed, #8b5cf6); color: white; padding: 12px 15px; }
      .executive-name { font-weight: bold; font-size: 1.1em; }
      .executive-phone { font-size: 0.7em; opacity: 0.9; }
      .executive-stats { padding: 12px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #f8f9fa; }
      .executive-stat { text-align: center; }
      .executive-stat-number { font-size: 1.1em; font-weight: bold; }
      .executive-stat-label { font-size: 0.6em; color: #666; }
      .status-badge { padding: 4px 8px; border-radius: 15px; font-size: 0.7em; display: inline-block; margin: 2px; }
      .status-pending { background: #fef3c7; color: #92400e; }
      .status-converted { background: #d1fae5; color: #065f46; }
      .status-waiting { background: #dbeafe; color: #1e40af; }
      .status-not-converted { background: #fee2e2; color: #991b1b; }
      
      .stage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 25px; }
      .stage-card { background: white; border-radius: 10px; padding: 12px; text-align: center; border-left: 3px solid; }
      .stage-card.awaiting_branch { border-color: #f59e0b; }
      .stage-card.branch_selected { border-color: #3b82f6; }
      .stage-card.executive_notified { border-color: #8b5cf6; }
      .stage-card.converted { border-color: #10b981; }
      .stage-name { font-size: 0.7em; color: #666; text-transform: uppercase; }
      .stage-value { font-size: 1.5em; font-weight: bold; margin-top: 3px; }
      
      .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .chart-card { background: white; border-radius: 12px; padding: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      
      .recent-section { background: white; border-radius: 12px; padding: 20px; margin-bottom: 25px; overflow-x: auto; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
      th { background: #f8f9fa; padding: 10px; text-align: left; font-weight: 600; }
      td { padding: 10px; border-bottom: 1px solid #e2e8f0; }
      .badge { padding: 3px 8px; border-radius: 12px; font-size: 0.7em; font-weight: 600; }
      .badge-pending { background: #fef3c7; color: #92400e; }
      .badge-converted { background: #d1fae5; color: #065f46; }
      .badge-waiting { background: #dbeafe; color: #1e40af; }
      .badge-not-converted { background: #fee2e2; color: #991b1b; }
      
      .top-patients-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
      .top-patient-card { background: #f8f9fa; border-radius: 10px; padding: 12px; border-left: 4px solid #ff6b6b; }
      .refresh-btn { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; margin-bottom: 15px; font-weight: bold; }
      .refresh-btn:hover { background: #5a67d8; }
      .last-updated { color: white; margin-bottom: 15px; font-size: 0.8em; }
      .executive-detail-btn { background: #128C7E; color: white; border: none; padding: 5px 10px; border-radius: 5px; cursor: pointer; font-size: 0.7em; margin: 8px 15px; width: calc(100% - 30px); }
      .patient-list { display: none; margin: 0 15px 15px 15px; padding: 10px; background: #f8f9fa; border-radius: 8px; max-height: 250px; overflow-y: auto; font-size: 0.75em; }
      .patient-list.show { display: block; }
      .patient-item { padding: 6px; border-bottom: 1px solid #eee; }
      .patient-item:last-child { border-bottom: none; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  </head>
  <body>
    <div class="container">
      <h1>🏥 Executive Dashboard - Complete Analytics</h1>
      
      <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Data</button>
      <div class="last-updated">Last updated: ${new Date().toLocaleString()}</div>
      
      <!-- Overall Stats -->
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-title">Total Patients</div><div class="stat-value">${totalPatients}</div></div>
        <div class="stat-card"><div class="stat-title">Pending</div><div class="stat-value">${pendingCount}</div></div>
        <div class="stat-card"><div class="stat-title">Converted</div><div class="stat-value">${convertedCount}</div></div>
        <div class="stat-card"><div class="stat-title">Waiting</div><div class="stat-value">${waitingCount}</div></div>
        <div class="stat-card"><div class="stat-title">Not Converted</div><div class="stat-value">${notConvertedCount}</div></div>
        <div class="stat-card misscall-card"><div class="stat-title">Total Miss Calls</div><div class="stat-value">${missCallTotal}</div></div>
        <div class="stat-card misscall-card"><div class="stat-title">Today's Miss Calls</div><div class="stat-value">${missCallToday}</div></div>
        <div class="stat-card"><div class="stat-title">Yesterday</div><div class="stat-value">${missCallYesterday}</div><div class="stat-change ${missCallToday > missCallYesterday ? 'stat-up' : 'stat-down'}">${missCallToday > missCallYesterday ? '↑' : '↓'} ${Math.abs(missCallToday - missCallYesterday)}</div></div>
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
      
      <!-- Branch Wise Analytics -->
      <h2>🏢 Branch Wise Analytics</h2>
      <div class="branch-grid">
        ${Object.entries(branchTests).map(([branch, tests]) => `
          <div class="branch-card">
            <div class="branch-header">
              <div>
                <div class="branch-name">${branch}</div>
                <div class="branch-phone">📞 ${EXECUTIVES[branch] || 'Not set'}</div>
              </div>
              <div style="font-size: 1.2em; font-weight: bold;">${tests.total} patients</div>
            </div>
            <div class="branch-stats">
              <div class="branch-stat"><div class="branch-stat-number" style="color: #10b981;">${tests.converted}</div><div class="branch-stat-label">Converted</div></div>
              <div class="branch-stat"><div class="branch-stat-number" style="color: #f59e0b;">${tests.pending}</div><div class="branch-stat-label">Pending</div></div>
              <div class="branch-stat"><div class="branch-stat-number" style="color: #3b82f6;">${tests.waiting}</div><div class="branch-stat-label">Waiting</div></div>
              <div class="branch-stat"><div class="branch-stat-number" style="color: #ef4444;">${tests.notConverted}</div><div class="branch-stat-label">Not Converted</div></div>
            </div>
            <div class="test-distribution">
              <strong>Test Distribution:</strong>
              <span class="test-badge test-mri">MRI: ${tests.MRI}</span>
              <span class="test-badge test-ct">CT: ${tests.CT}</span>
              <span class="test-badge test-xray">X-RAY: ${tests['X-RAY']}</span>
              <span class="test-badge test-usg">USG: ${tests.USG}</span>
              <span class="test-badge test-other">Other: ${tests.OTHER}</span>
            </div>
            <div class="misscall-stats">
              <div class="misscall-stat"><div class="misscall-stat-number">${branchMissCalls[branch] || 0}</div><div class="misscall-stat-label">Total Miss Calls</div></div>
              <div class="misscall-stat"><div class="misscall-stat-number">${branchMissCallsToday[branch] || 0}</div><div class="misscall-stat-label">Today</div></div>
              <div class="misscall-stat"><div class="misscall-stat-number">${branchMissCallsLast7Days[branch] || 0}</div><div class="misscall-stat-label">Last 7 Days</div></div>
              <div class="misscall-stat"><div class="misscall-stat-number">${branchMissCallsLast30Days[branch] || 0}</div><div class="misscall-stat-label">Last 30 Days</div></div>
            </div>
            <div class="conversion-rate">
              <span class="conversion-number">${branchConversion[branch]?.rate || 0}%</span> Conversion Rate
              (${branchConversion[branch]?.converted || 0}/${branchConversion[branch]?.total || 0})
            </div>
          </div>
        `).join('')}
      </div>
      
      <!-- Executive Wise Stats -->
      <h2>👥 Executive Performance</h2>
      <div class="executive-grid">
        ${Object.entries(executiveStats).map(([branch, stats]) => `
          <div class="executive-card">
            <div class="executive-header">
              <div>
                <div class="executive-name">${branch} Executive</div>
                <div class="executive-phone">📞 ${stats.execNumber}</div>
              </div>
              <div style="font-size: 1.2em; font-weight: bold;">${stats.total} patients</div>
            </div>
            <div class="executive-stats">
              <div class="executive-stat"><div class="executive-stat-number" style="color: #f59e0b;">${stats.pending}</div><div class="executive-stat-label">Pending</div></div>
              <div class="executive-stat"><div class="executive-stat-number" style="color: #10b981;">${stats.converted}</div><div class="executive-stat-label">Converted</div></div>
              <div class="executive-stat"><div class="executive-stat-number" style="color: #3b82f6;">${stats.waiting}</div><div class="executive-stat-label">Waiting</div></div>
              <div class="executive-stat"><div class="executive-stat-number" style="color: #ef4444;">${stats.notConverted}</div><div class="executive-stat-label">Not Converted</div></div>
            </div>
            <div style="padding: 10px 15px; border-top: 1px solid #eee;">
              <span class="status-badge status-pending">📌 Awaiting: ${stats.awaitingBranch}</span>
              <span class="status-badge status-waiting">✅ Selected: ${stats.branchSelected}</span>
              <span class="status-badge" style="background:#ede9fe;color:#5b21b6;">📢 Notified: ${stats.executiveNotified}</span>
              <span class="status-badge" style="background:#c8e6e9;color:#00695c;">💬 Connected: ${stats.connected}</span>
            </div>
            <button class="executive-detail-btn" onclick="togglePatientList('${branch}')">📋 View Patients (${stats.total})</button>
            <div id="patient-list-${branch}" class="patient-list">
              ${executivePatients[branch] && executivePatients[branch].length > 0 ? executivePatients[branch].map(p => `
                <div class="patient-item">
                  <strong>${p.patientName || 'Unknown'}</strong> (${p.patientPhone})<br>
                  <small>Tests: ${p.testDetails || 'N/A'} | ${p.status} | ${p.currentStage}</small>
                </div>
              `).join('') : '<div class="patient-item">No patients assigned</div>'}
            </div>
          </div>
        `).join('')}
      </div>
      
      <!-- Stage Tracking -->
      <h2>📈 Stage Wise Tracking</h2>
      <div class="stage-grid">
        <div class="stage-card awaiting_branch"><div class="stage-name">Awaiting Branch</div><div class="stage-value">${stageStats.awaiting_branch || 0}</div></div>
        <div class="stage-card branch_selected"><div class="stage-name">Branch Selected</div><div class="stage-value">${stageStats.branch_selected || 0}</div></div>
        <div class="stage-card executive_notified"><div class="stage-name">Executive Notified</div><div class="stage-value">${stageStats.executive_notified || 0}</div></div>
        <div class="stage-card converted"><div class="stage-name">Converted</div><div class="stage-value">${stageStats.converted || 0}</div></div>
        <div class="stage-card waiting"><div class="stage-name">Waiting</div><div class="stage-value">${stageStats.waiting || 0}</div></div>
        <div class="stage-card not_converted"><div class="stage-name">Not Converted</div><div class="stage-value">${stageStats.not_converted || 0}</div></div>
      </div>
      
      <!-- Charts -->
      <div class="charts-grid">
        <div class="chart-card">
          <canvas id="dailyMissCallsChart" style="width:100%; max-height:300px;"></canvas>
        </div>
        <div class="chart-card">
          <canvas id="branchTestsChart" style="width:100%; max-height:300px;"></canvas>
        </div>
      </div>
      
      <!-- Top Miss Call Patients -->
      <h2>📞 Top Miss Call Patients</h2>
      <div class="top-patients-grid">
        ${topMissCallPatients.map(p => `
          <div class="top-patient-card">
            <div style="font-weight: bold;">${p.patientName || 'Unknown'}</div>
            <div style="color: #666; font-size: 0.8em;">${p.patientPhone}</div>
            <div style="color: #ff6b6b; font-weight: bold; margin-top: 3px;">${p.missCallCount || 1} calls</div>
            <div style="font-size: 0.7em; color: #888;">Branch: ${p.branch || 'N/A'}</div>
          </div>
        `).join('')}
      </div>
      
      <!-- Recent Patients -->
      <h2>🕒 Recent Patients</h2>
      <div class="recent-section">
        <table>
          <thead>
            <tr><th>Patient</th><th>Phone</th><th>Branch</th><th>Tests</th><th>Stage</th><th>Status</th><th>Time</th></tr>
          </thead>
          <tbody>
            ${recentPatients.slice(0, 20).map(p => `
              <tr>
                <td>${p.patientName || 'N/A'}</td>
                <td>${p.patientPhone || 'N/A'}</td>
                <td>${p.branch || 'N/A'}</td>
                <td>${p.testDetails || p.tests || 'N/A'}</td>
                <td><span class="badge badge-${p.currentStage || 'pending'}">${(p.currentStage || 'pending').replace(/_/g, ' ')}</span></td>
                <td><span class="badge badge-${p.status || 'pending'}">${p.status || 'pending'}</span></td>
                <td>${new Date(p.createdAt).toLocaleString()}</td>
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
            ${recentMissCalls.slice(0, 20).map(m => `
              <tr><td>${m.phoneNumber || 'N/A'}</td><td>${m.branch || 'N/A'}</td><td>${new Date(m.createdAt).toLocaleString()}</td></tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    
    <script>
      function togglePatientList(branch) {
        const element = document.getElementById('patient-list-' + branch);
        element.classList.toggle('show');
      }
      
      // Daily Miss Calls Chart
      new Chart(document.getElementById('dailyMissCallsChart'), {
        type: 'line',
        data: {
          labels: ${JSON.stringify(dailyMissCallLabels)},
          datasets: [{
            label: 'Miss Calls',
            data: ${JSON.stringify(dailyMissCallValues)},
            borderColor: '#f97316',
            backgroundColor: 'rgba(249,115,22,0.1)',
            fill: true,
            tension: 0.3
          }]
        },
        options: { responsive: true, maintainAspectRatio: true }
      });
      
      // Branch Tests Chart
      new Chart(document.getElementById('branchTestsChart'), {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(branchNames)},
          datasets: [
            { label: 'MRI', data: ${JSON.stringify(branchMRIData)}, backgroundColor: '#10b981' },
            { label: 'CT', data: ${JSON.stringify(branchCTData)}, backgroundColor: '#3b82f6' },
            { label: 'X-RAY', data: ${JSON.stringify(branchXRayData)}, backgroundColor: '#f59e0b' },
            { label: 'USG', data: ${JSON.stringify(branchUSGData)}, backgroundColor: '#8b5cf6' }
          ]
        },
        options: { responsive: true, maintainAspectRatio: true, scales: { x: { stacked: false }, y: { beginAtZero: true } } }
      });
      
      setTimeout(() => location.reload(), 60000);
    </script>
  </body>
  </html>
  `;
}

module.exports = router;
