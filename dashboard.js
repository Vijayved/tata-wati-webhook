// dashboard.js - Complete Admin Dashboard with Separate Miss Call & GMB Tabs
const express = require('express');
const router = express.Router();

// Reset Database Endpoint
router.post('/reset', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== '2311') {
      return res.status(403).json({ success: false, error: 'Invalid password' });
    }
    
    const collections = ['patients', 'processed_messages', 'miss_calls', 'chat_sessions', 'chat_messages', 'followups'];
    const results = {};
    
    for (const coll of collections) {
      if (req[`${coll}Collection`]) {
        results[coll] = await req[`${coll}Collection`].deleteMany({});
      }
    }
    
    if (req.googleLeadsCollection) {
      results.google_leads = await req.googleLeadsCollection.deleteMany({});
    }
    
    res.json({ success: true, deleted: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const patientsCollection = req.patientsCollection;
    const processedCollection = req.processedCollection;
    const missCallsCollection = req.missCallsCollection;
    const chatSessionsCollection = req.chatSessionsCollection;
    const chatMessagesCollection = req.chatMessagesCollection;
    const followupCollection = req.followupCollection;
    const googleLeadsCollection = req.googleLeadsCollection;
    const STAGES = req.STAGES;
    
    if (!patientsCollection || !processedCollection) {
      throw new Error('Database collections not available');
    }
    
    // Get filter parameters
    const filters = {
      dateRange: req.query.dateRange || 'all',
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      branch: req.query.branch || 'all',
      executive: req.query.executive || 'all',
      modality: req.query.modality || 'all',
      status: req.query.status || 'all',
      stage: req.query.stage || 'all',
      search: req.query.search || '',
      tab: req.query.tab || 'misscall'
    };
    
    // Executive numbers mapping (15 branches)
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
      'Ahmedabad': process.env.AHMEDABAD_EXECUTIVE || '919106959092',
      'Surat': process.env.SURAT_EXECUTIVE || '919274682553',
      'Vadodara': process.env.VADODARA_EXECUTIVE || '918488931212',
      'Bhavnagar': process.env.BHAVNAGAR_EXECUTIVE || '917880261858',
      'Jamnagar': process.env.JAMNAGAR_EXECUTIVE || '917490029085',
      'Manager': process.env.MANAGER_NUMBER || '917698011233'
    };
    
    // 15 Branches Configuration
    const BRANCHES_CONFIG = {
      'Naroda': { name: 'Naroda', watiNumber: '917969690935', executive: EXECUTIVES['Naroda'] },
      'Usmanpura': { name: 'Usmanpura', watiNumber: '917969690901', executive: EXECUTIVES['Usmanpura'] },
      'Vadaj': { name: 'Vadaj', watiNumber: '917969690903', executive: EXECUTIVES['Vadaj'] },
      'Satellite': { name: 'Satellite', watiNumber: '917969690924', executive: EXECUTIVES['Satellite'] },
      'Maninagar': { name: 'Maninagar', watiNumber: '917969690936', executive: EXECUTIVES['Maninagar'] },
      'Bapunagar': { name: 'Bapunagar', watiNumber: '917969690923', executive: EXECUTIVES['Bapunagar'] },
      'Juhapura': { name: 'Juhapura', watiNumber: '917969690918', executive: EXECUTIVES['Juhapura'] },
      'Gandhinagar': { name: 'Gandhinagar', watiNumber: '917969690941', executive: EXECUTIVES['Gandhinagar'] },
      'Rajkot': { name: 'Rajkot', watiNumber: '917969690913', executive: EXECUTIVES['Rajkot'] },
      'Sabarmati': { name: 'Sabarmati', watiNumber: '917969690942', executive: EXECUTIVES['Sabarmati'] },
      'Ahmedabad': { name: 'Ahmedabad', watiNumber: '917969690900', executive: EXECUTIVES['Ahmedabad'] },
      'Surat': { name: 'Surat', watiNumber: '917969690911', executive: EXECUTIVES['Surat'] },
      'Vadodara': { name: 'Vadodara', watiNumber: '917969690912', executive: EXECUTIVES['Vadodara'] },
      'Bhavnagar': { name: 'Bhavnagar', watiNumber: '917969690914', executive: EXECUTIVES['Bhavnagar'] },
      'Jamnagar': { name: 'Jamnagar', watiNumber: '917969690915', executive: EXECUTIVES['Jamnagar'] }
    };
    
    // Get all data
    const allPatients = await patientsCollection.find({}).toArray();
    const allMissCalls = await missCallsCollection.find({}).toArray();
    const allFollowups = await followupCollection.find({}).toArray();
    const allSessions = await chatSessionsCollection.find({}).toArray();
    const allMessages = await chatMessagesCollection.find({}).toArray();
    
    // Separate Miss Call and GMB Patients
    const missCallPatients = allPatients.filter(p => p.source !== 'gmb');
    const gmbPatients = allPatients.filter(p => p.source === 'gmb');
    
    // Google Lead Stats
    let googleLeadStats = {
      totalClicks: 0,
      todayClicks: 0,
      byBranch: {},
      byStatus: {
        clicked: 0,
        template_sent: 0,
        patient_replied: 0,
        executive_connected: 0,
        converted: 0,
        not_converted: 0
      },
      recentLeads: []
    };
    
    if (googleLeadsCollection) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      googleLeadStats.totalClicks = await googleLeadsCollection.countDocuments();
      googleLeadStats.todayClicks = await googleLeadsCollection.countDocuments({ clickedAt: { $gte: today } });
      
      const branchStats = await googleLeadsCollection.aggregate([
        { $group: { _id: '$branch', count: { $sum: 1 } } }
      ]).toArray();
      branchStats.forEach(b => { googleLeadStats.byBranch[b._id] = b.count; });
      
      const statusStats = await googleLeadsCollection.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]).toArray();
      statusStats.forEach(s => {
        if (googleLeadStats.byStatus[s._id] !== undefined) {
          googleLeadStats.byStatus[s._id] = s.count;
        }
      });
      
      googleLeadStats.recentLeads = await googleLeadsCollection.find()
        .sort({ clickedAt: -1 })
        .limit(50)
        .toArray();
    }
    
    // Deduplicate patients for Miss Call system
    const uniqueMissCallPatients = new Map();
    for (const patient of missCallPatients) {
      const existing = uniqueMissCallPatients.get(patient.patientPhone);
      if (!existing || new Date(patient.createdAt) > new Date(existing.createdAt)) {
        uniqueMissCallPatients.set(patient.patientPhone, patient);
      }
    }
    let patients = Array.from(uniqueMissCallPatients.values());
    
    // Date filter
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const last7Days = new Date(today);
    last7Days.setDate(last7Days.getDate() - 7);
    const last30Days = new Date(today);
    last30Days.setDate(last30Days.getDate() - 30);
    
    let startDate = null, endDate = null;
    if (filters.dateRange === 'today') {
      startDate = today;
      endDate = new Date(today);
      endDate.setHours(23, 59, 59, 999);
    } else if (filters.dateRange === 'yesterday') {
      startDate = yesterday;
      endDate = new Date(today);
      endDate.setMilliseconds(-1);
    } else if (filters.dateRange === 'last7days') {
      startDate = last7Days;
      endDate = new Date();
    } else if (filters.dateRange === 'last30days') {
      startDate = last30Days;
      endDate = new Date();
    } else if (filters.dateRange === 'custom' && filters.startDate && filters.endDate) {
      startDate = new Date(filters.startDate);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(filters.endDate);
      endDate.setHours(23, 59, 59, 999);
    }
    
    if (startDate && endDate) {
      patients = patients.filter(p => {
        const date = new Date(p.createdAt);
        return date >= startDate && date <= endDate;
      });
    }
    
    // Apply filters
    if (filters.branch !== 'all') patients = patients.filter(p => p.branch === filters.branch);
    if (filters.executive !== 'all') {
      const execNumber = EXECUTIVES[filters.executive];
      patients = patients.filter(p => p.executiveNumber === execNumber);
    }
    if (filters.modality !== 'all') {
      patients = patients.filter(p => {
        const testType = (p.testType || p.testDetails || '').toUpperCase();
        if (filters.modality === 'MRI') return testType.includes('MRI');
        if (filters.modality === 'CT') return testType.includes('CT');
        if (filters.modality === 'X-RAY') return testType.includes('X-RAY') || testType.includes('XRAY');
        if (filters.modality === 'USG') return testType.includes('USG') || testType.includes('ULTRASOUND');
        if (filters.modality === 'OTHER') return !testType.includes('MRI') && !testType.includes('CT') && !testType.includes('X-RAY');
        return true;
      });
    }
    if (filters.status !== 'all') patients = patients.filter(p => p.status === filters.status);
    if (filters.stage !== 'all') patients = patients.filter(p => p.currentStage === filters.stage);
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      patients = patients.filter(p => 
        (p.patientName && p.patientName.toLowerCase().includes(searchLower)) ||
        (p.patientPhone && p.patientPhone.includes(searchLower))
      );
    }
    
    // Calculate Miss Call Stats
    const activeConversations = allSessions.filter(s => s.status === 'active');
    const connectedPatients = patients.filter(p => {
      const hasActiveSession = allSessions.some(s => s.patientPhone === p.patientPhone && s.status === 'active');
      return hasActiveSession && p.currentStage === 'connected';
    });
    const patientsWithoutReply = patients.filter(p => p.executiveActionTaken === false && p.currentStage !== 'converted' && p.currentStage !== 'not_converted');
    const singleMissCallPatients = patients.filter(p => (p.missCallCount || 1) === 1);
    const templateSentPatients = patients.filter(p => p.currentStage === 'executive_notified' || p.currentStage === 'connected');
    const escalatedPatients = patients.filter(p => p.escalatedToManager === true);
    const highMissCallPatients = patients.filter(p => (p.missCallCount || 1) >= 3);
    const waitingPatients = patients.filter(p => {
      if (p.currentStage !== 'waiting') return false;
      return Date.now() - new Date(p.updatedAt) > 2 * 60 * 60 * 1000;
    });
    
    // Follow-up stats
    const uniqueFollowups = new Map();
    for (const f of allFollowups) {
      const key = `${f.patientId}_${f.type}_${new Date(f.sentAt).toISOString().slice(0, 16)}`;
      if (!uniqueFollowups.has(key)) uniqueFollowups.set(key, f);
    }
    const followups = Array.from(uniqueFollowups.values());
    const followupStats = {
      total: followups.length,
      noReply: followups.filter(f => f.type === 'no_reply').length,
      waiting: followups.filter(f => f.type === 'waiting').length,
      escalation: followups.filter(f => f.type === 'escalation').length,
      today: followups.filter(f => new Date(f.sentAt) >= today).length
    };
    
    // Branch wise test distribution
    const branchTests = {};
    for (const patient of patients) {
      const branch = patient.branch || 'Unknown';
      if (!branchTests[branch]) {
        branchTests[branch] = { total: 0, converted: 0, pending: 0, waiting: 0, notConverted: 0,
          patientsWithNoReply: 0, singleMissCall: 0, highMissCall: 0, escalated: 0, connected: 0 };
      }
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
    }
    
    // Daily miss calls
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
      dailyMissCalls.push({ date: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), count });
    }
    
    // Executive stats for Miss Call
    const executiveStats = {};
    const executivePatients = {};
    for (const [branch, execNumber] of Object.entries(EXECUTIVES)) {
      if (branch === 'Manager') continue;
      executiveStats[branch] = {
        execNumber: execNumber, total: 0, pending: 0, converted: 0, waiting: 0, notConverted: 0,
        awaitingBranch: 0, branchSelected: 0, awaitingName: 0, awaitingTestType: 0, awaitingTestDetails: 0,
        executiveNotified: 0, connected: 0, noReply: 0, singleMissCall: 0, highMissCall: 0,
        templateSent: 0, escalated: 0, activeChat: 0
      };
      executivePatients[branch] = [];
    }
    
    for (const patient of patients) {
      const branch = patient.branch;
      if (branch && EXECUTIVES[branch] && branch !== 'Manager') {
        executiveStats[branch].total++;
        if (patient.status === 'pending') executiveStats[branch].pending++;
        else if (patient.status === 'converted') executiveStats[branch].converted++;
        else if (patient.status === 'waiting') executiveStats[branch].waiting++;
        else if (patient.status === 'not_converted') executiveStats[branch].notConverted++;
        
        if (patient.currentStage === 'awaiting_branch') executiveStats[branch].awaitingBranch++;
        else if (patient.currentStage === 'branch_selected') executiveStats[branch].branchSelected++;
        else if (patient.currentStage === 'awaiting_name') executiveStats[branch].awaitingName++;
        else if (patient.currentStage === 'awaiting_test_type') executiveStats[branch].awaitingTestType++;
        else if (patient.currentStage === 'awaiting_test_details') executiveStats[branch].awaitingTestDetails++;
        else if (patient.currentStage === 'executive_notified') executiveStats[branch].executiveNotified++;
        else if (patient.currentStage === 'connected') executiveStats[branch].connected++;
        
        const hasActiveSession = allSessions.some(s => s.patientPhone === patient.patientPhone && s.status === 'active');
        if (hasActiveSession && patient.currentStage === 'connected') executiveStats[branch].activeChat++;
        
        if (patient.executiveActionTaken === false) executiveStats[branch].noReply++;
        if ((patient.missCallCount || 1) === 1) executiveStats[branch].singleMissCall++;
        if ((patient.missCallCount || 1) >= 3) executiveStats[branch].highMissCall++;
        if (patient.currentStage === 'executive_notified' || patient.currentStage === 'connected') executiveStats[branch].templateSent++;
        if (patient.escalatedToManager === true) executiveStats[branch].escalated++;
        
        executivePatients[branch].push({
          patientName: patient.patientName || 'Unknown', patientPhone: patient.patientPhone,
          testDetails: patient.testDetails, testType: patient.testType,
          status: patient.status, currentStage: patient.currentStage,
          createdAt: patient.createdAt, missCallCount: patient.missCallCount || 1,
          executiveActionTaken: patient.executiveActionTaken,
          hasActiveSession: allSessions.some(s => s.patientPhone === patient.patientPhone && s.status === 'active'),
          escalatedToManager: patient.escalatedToManager
        });
      }
    }
    
    // Overall stats
    const totalPatients = patients.length;
    const pendingCount = patients.filter(p => p.status === 'pending').length;
    const convertedCount = patients.filter(p => p.status === 'converted').length;
    const waitingCount = patients.filter(p => p.status === 'waiting').length;
    const notConvertedCount = patients.filter(p => p.status === 'not_converted').length;
    const missCallTotal = allMissCalls.length;
    const missCallToday = allMissCalls.filter(c => new Date(c.createdAt) >= today).length;
    const missCallYesterday = allMissCalls.filter(c => {
      const date = new Date(c.createdAt);
      return date >= yesterday && date < today;
    }).length;
    const missCallLast7Days = allMissCalls.filter(c => new Date(c.createdAt) >= last7Days).length;
    
    // Test distribution
    const overallTests = { MRI: 0, CT: 0, 'X-RAY': 0, USG: 0, OTHER: 0 };
    for (const patient of patients) {
      const testType = (patient.testType || patient.testDetails || '').toUpperCase();
      if (testType.includes('MRI')) overallTests.MRI++;
      else if (testType.includes('CT')) overallTests.CT++;
      else if (testType.includes('X-RAY') || testType.includes('XRAY')) overallTests['X-RAY']++;
      else if (testType.includes('USG') || testType.includes('ULTRASOUND')) overallTests.USG++;
      else overallTests.OTHER++;
    }
    
    const recentPatients = patients.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100);
    const recentMissCalls = allMissCalls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
    const topMissCallPatients = patients.sort((a, b) => (b.missCallCount || 0) - (a.missCallCount || 0)).slice(0, 10);
    const recentFollowups = followups.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)).slice(0, 30);
    const branches = [...new Set(allPatients.map(p => p.branch).filter(b => b))];
    const executivesList = Object.keys(EXECUTIVES).filter(e => e !== 'Manager');
    
    const exportData = recentPatients.map(p => ({
      'Patient Name': p.patientName || 'N/A', 'Phone': p.patientPhone || 'N/A',
      'Branch': p.branch || 'N/A', 'Test': p.testDetails || p.testType || 'N/A',
      'Status': p.status || 'N/A', 'Stage': p.currentStage || 'N/A',
      'Miss Calls': p.missCallCount || 1, 'Active Chat': p.hasActiveSession ? 'Yes' : 'No',
      'Created At': new Date(p.createdAt).toLocaleString()
    }));
    
    res.send(getDashboardHTML({
      filters, EXECUTIVES, BRANCHES_CONFIG, googleLeadStats,
      totalPatients, pendingCount, convertedCount, waitingCount, notConvertedCount,
      missCallTotal, missCallToday, missCallYesterday, missCallLast7Days,
      patientsWithoutReply, singleMissCallPatients, templateSentPatients,
      highMissCallPatients, waitingPatients, escalatedPatients,
      activeConversations, connectedPatients, followupStats,
      branchTests, overallTests, dailyMissCalls,
      recentPatients, recentMissCalls, topMissCallPatients,
      recentFollowups, executiveStats, executivePatients,
      branches, executivesList, exportData, gmbPatients
    }));
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send(`<h2>Error: ${error.message}</h2><pre>${error.stack}</pre>`);
  }
});

function getDashboardHTML(data) {
  const {
    filters, EXECUTIVES, BRANCHES_CONFIG, googleLeadStats,
    totalPatients, pendingCount, convertedCount, waitingCount, notConvertedCount,
    missCallTotal, missCallToday, missCallYesterday, missCallLast7Days,
    patientsWithoutReply, singleMissCallPatients, templateSentPatients,
    highMissCallPatients, waitingPatients, escalatedPatients,
    activeConversations, connectedPatients, followupStats,
    branchTests, overallTests, dailyMissCalls,
    recentPatients, recentMissCalls, topMissCallPatients,
    recentFollowups, executiveStats, executivePatients,
    branches, executivesList, exportData, gmbPatients
  } = data;
  
  const dailyMissCallLabels = dailyMissCalls.map(d => d.date);
  const dailyMissCallValues = dailyMissCalls.map(d => d.count);
  const branchNames = Object.keys(branchTests);
  const branchTotalData = branchNames.map(b => branchTests[b]?.total || 0);
  const branchConvertedData = branchNames.map(b => branchTests[b]?.converted || 0);
  const branchConnectedData = branchNames.map(b => branchTests[b]?.connected || 0);
  const exportDataJson = JSON.stringify(exportData);
  
  const activeTab = filters.tab || 'misscall';
  
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>UIC Support Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
      .container { max-width: 1600px; margin: 0 auto; }
      h1 { color: white; margin-bottom: 20px; font-size: 2em; }
      
      /* Tab Styles */
      .tabs { display: flex; gap: 10px; margin-bottom: 25px; background: rgba(255,255,255,0.1); padding: 10px; border-radius: 12px; }
      .tab-btn { padding: 12px 30px; border: none; border-radius: 10px; font-size: 1em; font-weight: bold; cursor: pointer; transition: all 0.3s; }
      .tab-btn.misscall { background: #075e54; color: white; }
      .tab-btn.misscall.active { background: #128C7E; box-shadow: 0 0 15px rgba(18,140,126,0.5); }
      .tab-btn.gmb { background: #4285f4; color: white; }
      .tab-btn.gmb.active { background: #34a853; box-shadow: 0 0 15px rgba(52,168,83,0.5); }
      .tab-content { display: none; }
      .tab-content.active { display: block; }
      
      .filter-bar { background: white; border-radius: 12px; padding: 20px; margin-bottom: 25px; box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
      .filter-row { display: flex; flex-wrap: wrap; gap: 15px; margin-bottom: 15px; align-items: flex-end; }
      .filter-group { flex: 1; min-width: 150px; }
      .filter-group label { display: block; font-size: 0.7em; color: #666; margin-bottom: 5px; text-transform: uppercase; font-weight: bold; }
      .filter-group select, .filter-group input { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 0.9em; }
      .filter-actions { display: flex; gap: 10px; align-items: center; }
      .btn-filter { background: #075e54; color: white; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; }
      .btn-reset-filter { background: #6c757d; color: white; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; text-align: center; }
      .btn-export { background: #10b981; color: white; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; }
      .btn-reset-db { background: #dc2626; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-left: 10px; }
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
      .google-lead-card { background: linear-gradient(135deg, #4285f4, #34a853); color: white; }
      .blink-red { animation: blink 1s infinite; background-color: #ff6b6b !important; color: white !important; padding: 2px 6px; border-radius: 8px; display: inline-block; }
      @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
      
      .google-branch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 25px; }
      .google-branch-card { background: white; border-radius: 12px; padding: 15px; text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
      .google-branch-name { font-size: 1.1em; font-weight: bold; color: #4285f4; }
      .google-branch-count { font-size: 2em; font-weight: bold; margin: 10px 0; }
      .google-status-badge { display: inline-block; padding: 3px 8px; border-radius: 20px; font-size: 0.7em; font-weight: bold; }
      .status-clicked { background: #fef3c7; color: #92400e; }
      .status-template_sent { background: #dbeafe; color: #1e40af; }
      .status-patient_replied { background: #d1fae5; color: #065f46; }
      .status-executive_connected { background: #c8e6e9; color: #00695c; }
      .status-converted { background: #10b981; color: white; }
      
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
    <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
    <script>
      function toggleCustomDate() {
        const dateRange = document.querySelector('select[name="dateRange"]').value;
        const customDiv = document.getElementById('customDateRange');
        customDiv.style.display = dateRange === 'custom' ? 'flex' : 'none';
      }
      function togglePatientList(branch) { document.getElementById('patient-list-' + branch).classList.toggle('show'); }
      function exportToExcel() { const ws = XLSX.utils.json_to_sheet(${exportDataJson}); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Patients'); XLSX.writeFile(wb, 'patients_export.xlsx'); }
      function resetDatabase() { const pwd = prompt('Enter reset password:'); if(pwd) fetch('/admin/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})}).then(r=>r.json()).then(d=>{if(d.success){alert('Reset successful!');location.reload();}else alert('Error: '+d.error);}); }
      function switchTab(tab) {
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('tab-' + tab).classList.add('active');
        document.querySelector('.tab-btn.' + tab).classList.add('active');
        const url = new URL(window.location.href);
        url.searchParams.set('tab', tab);
        window.history.pushState({}, '', url);
      }
      document.addEventListener('DOMContentLoaded', () => {
        const urlParams = new URLSearchParams(window.location.search);
        const activeTab = urlParams.get('tab') || 'misscall';
        switchTab(activeTab);
      });
    </script>
  </head>
  <body>
    <div class="container">
      <h1>🏥 UIC Support Executive Dashboard</h1>
      
      <!-- Tabs -->
      <div class="tabs">
        <button class="tab-btn misscall active" onclick="switchTab('misscall')">📞 Miss Call System</button>
        <button class="tab-btn gmb" onclick="switchTab('gmb')">🌟 Google My Business</button>
      </div>
      
      <!-- Filter Bar -->
      <div class="filter-bar">
        <form method="GET" action="/admin" id="filterForm">
          <input type="hidden" name="tab" value="${activeTab}">
          <div class="filter-row">
            <div class="filter-group"><label>📅 Date Range</label><select name="dateRange" onchange="toggleCustomDate()"><option value="all">All Time</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="last7days">Last 7 Days</option><option value="last30days">Last 30 Days</option><option value="custom">Custom</option></select></div>
            <div id="customDateRange" style="display:none; gap:10px;"><div class="filter-group"><label>From</label><input type="date" name="startDate"></div><div class="filter-group"><label>To</label><input type="date" name="endDate"></div></div>
            <div class="filter-group"><label>🏢 Branch</label><select name="branch"><option value="all">All Branches</option>${branches.map(b => `<option value="${b}">${b}</option>`).join('')}</select></div>
            <div class="filter-group"><label>👤 Executive</label><select name="executive"><option value="all">All Executives</option>${executivesList.map(e => `<option value="${e}">${e}</option>`).join('')}</select></div>
          </div>
          <div class="filter-row">
            <div class="filter-group"><label>🔬 Modality</label><select name="modality"><option value="all">All</option><option value="MRI">MRI</option><option value="CT">CT</option><option value="X-RAY">X-RAY</option><option value="USG">USG</option><option value="OTHER">OTHER</option></select></div>
            <div class="filter-group"><label>📊 Status</label><select name="status"><option value="all">All</option><option value="pending">Pending</option><option value="converted">Converted</option><option value="waiting">Waiting</option><option value="not_converted">Not Converted</option></select></div>
            <div class="filter-group"><label>🎯 Stage</label><select name="stage"><option value="all">All</option><option value="awaiting_branch">Awaiting Branch</option><option value="executive_notified">Notified</option><option value="connected">Connected</option><option value="converted">Converted</option><option value="waiting">Waiting</option></select></div>
            <div class="filter-group"><label>🔍 Search</label><input type="text" name="search" placeholder="Name or Phone"></div>
            <div class="filter-actions"><button type="submit" class="btn-filter">🔍 Apply</button><a href="/admin" class="btn-reset-filter">🔄 Reset</a><button type="button" class="btn-export" onclick="exportToExcel()">📊 Excel</button><button type="button" class="btn-reset-db" onclick="resetDatabase()">🗑️ Reset DB</button></div>
          </div>
        </form>
      </div>
      
      <!-- ==================== MISS CALL TAB ==================== -->
      <div id="tab-misscall" class="tab-content active">
        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
        <div class="last-updated">Updated: ${new Date().toLocaleString()}</div>
        
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
        
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-title">📢 Total Follow-ups</div><div class="stat-value">${followupStats.total}</div></div>
          <div class="stat-card"><div class="stat-title">⏰ No Reply</div><div class="stat-value">${followupStats.noReply}</div></div>
          <div class="stat-card"><div class="stat-title">⏳ Waiting</div><div class="stat-value">${followupStats.waiting}</div></div>
          <div class="stat-card"><div class="stat-title">🚨 Escalations</div><div class="stat-value">${followupStats.escalation}</div></div>
          <div class="stat-card"><div class="stat-title">📅 Today</div><div class="stat-value">${followupStats.today}</div></div>
        </div>
        
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
        
        <h2>📊 Test Distribution</h2>
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-title">MRI</div><div class="stat-value">${overallTests.MRI}</div></div>
          <div class="stat-card"><div class="stat-title">CT</div><div class="stat-value">${overallTests.CT}</div></div>
          <div class="stat-card"><div class="stat-title">X-RAY</div><div class="stat-value">${overallTests['X-RAY']}</div></div>
          <div class="stat-card"><div class="stat-title">USG</div><div class="stat-value">${overallTests.USG}</div></div>
          <div class="stat-card"><div class="stat-title">Others</div><div class="stat-value">${overallTests.OTHER}</div></div>
        </div>
        
        <h2>👥 Executive Performance</h2>
        <div class="executive-grid">
          ${Object.entries(executiveStats).map(([branch, stats]) => `
            <div class="executive-card">
              <div class="executive-header"><div><div class="executive-name">${branch}</div><div class="executive-phone">${stats.execNumber}</div></div><div>${stats.total} patients</div></div>
              <div class="executive-stats"><div><div class="executive-stat-number" style="color:#f59e0b;">${stats.pending}</div><div class="executive-stat-label">Pending</div></div><div><div class="executive-stat-number" style="color:#10b981;">${stats.converted}</div><div class="executive-stat-label">Converted</div></div><div><div class="executive-stat-number" style="color:#3b82f6;">${stats.waiting}</div><div class="executive-stat-label">Waiting</div></div><div><div class="executive-stat-number" style="color:#ef4444;">${stats.notConverted}</div><div class="executive-stat-label">Not Conv</div></div><div><div class="executive-stat-number" style="color:#10b981;">${stats.activeChat}</div><div class="executive-stat-label">Active</div></div></div>
              <div class="stage-row"><span class="stage-badge">📌 Await: ${stats.awaitingBranch}</span><span class="stage-badge">✅ Selected: ${stats.branchSelected}</span><span class="stage-badge">📝 Name: ${stats.awaitingName}</span><span class="stage-badge">🔬 Test: ${stats.awaitingTestType+stats.awaitingTestDetails}</span><span class="stage-badge">📢 Notified: ${stats.executiveNotified}</span><span class="stage-badge">💬 Connected: ${stats.connected}</span></div>
              <div class="alert-row-exec"><span>⚠️ No Reply: <strong>${stats.noReply}</strong></span><span>📞 Single: ${stats.singleMissCall}</span><span>🔴 High: <span class="${stats.highMissCall > 0 ? 'blink-red' : ''}">${stats.highMissCall}</span></span><span>🚨 Escalated: ${stats.escalated}</span></div>
              <button class="executive-detail-btn" onclick="togglePatientList('${branch}')">📋 View ${stats.total} Patients</button>
              <div id="patient-list-${branch}" class="patient-list">${executivePatients[branch] && executivePatients[branch].length > 0 ? executivePatients[branch].slice(0, 30).map(p => `<div class="patient-item ${p.missCallCount >= 3 ? 'high-miss-call' : ''}"><strong>${p.patientName}</strong> (${p.patientPhone})${p.hasActiveSession ? '<span class="connected-badge">💬 Active</span>' : ''}<br><small>Test: ${p.testDetails || p.testType || 'N/A'} | ${p.missCallCount} calls</small><br><small>Stage: ${p.currentStage || 'N/A'}</small>${!p.executiveActionTaken ? '<span class="no-reply"> ⚠️ No reply</span>' : ''}</div>`).join('') : '<div>No patients</div>'}</div>
            </div>
          `).join('')}
        </div>
        
        <h2>📈 Stage Tracking</h2>
        <div class="stage-grid"><div class="stage-card"><div class="stage-name">Awaiting Branch</div><div class="stage-value">0</div></div><div class="stage-card"><div class="stage-name">Notified</div><div class="stage-value">0</div></div><div class="stage-card"><div class="stage-name">Connected</div><div class="stage-value">0</div></div><div class="stage-card"><div class="stage-name">Converted</div><div class="stage-value">${convertedCount}</div></div><div class="stage-card"><div class="stage-name">Waiting</div><div class="stage-value">${waitingCount}</div></div><div class="stage-card"><div class="stage-name">Escalated</div><div class="stage-value">${escalatedPatients.length}</div></div></div>
        
        <div class="charts-grid"><div class="chart-card"><canvas id="dailyChart"></canvas></div><div class="chart-card"><canvas id="branchChart"></canvas></div></div>
        
        <h2>📞 Top Miss Call Patients</h2>
        <div class="top-patients-grid">${topMissCallPatients.map(p => `<div class="top-patient-card ${p.missCallCount >= 3 ? 'high-miss-call' : ''}"><strong>${p.patientName || 'Unknown'}</strong><br><small>${p.patientPhone}</small><br><span style="color:#ff6b6b;">${p.missCallCount || 1} calls</span><br><small>${p.branch || 'N/A'}</small></div>`).join('')}</div>
        
        <h2>🕒 Recent Patients</h2>
        <div class="recent-section"><table><thead><tr><th>Patient</th><th>Phone</th><th>Branch</th><th>Test</th><th>Stage</th><th>Status</th><th>Calls</th><th>Active</th><th>Time</th></tr></thead><tbody>${recentPatients.slice(0, 50).map(p => `<tr><td>${p.patientName || 'N/A'}</td><td>${p.patientPhone || 'N/A'}</td><td>${p.branch || 'N/A'}</td><td>${p.testDetails || p.testType || 'N/A'}</td><td>${(p.currentStage || 'pending').replace(/_/g, ' ')}</td><td>${p.status || 'pending'}</td><td>${p.missCallCount || 1}</td><td>${p.hasActiveSession ? '✅' : '❌'}</td><td>${new Date(p.createdAt).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>
        
        <h2>📞 Recent Miss Calls</h2>
        <div class="recent-section"><table><thead><tr><th>Phone</th><th>Branch</th><th>Time</th></tr></thead><tbody>${recentMissCalls.slice(0, 30).map(m => `<tr><td>${m.phoneNumber || 'N/A'}</td><td>${m.branch || 'N/A'}</td><td>${new Date(m.createdAt).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>
      </div>
      
      <!-- ==================== GOOGLE MY BUSINESS TAB ==================== -->
      <div id="tab-gmb" class="tab-content">
        <div class="stats-grid">
          <div class="stat-card google-lead-card"><div class="stat-title">Total Clicks</div><div class="stat-value">${googleLeadStats.totalClicks}</div></div>
          <div class="stat-card google-lead-card"><div class="stat-title">Today's Clicks</div><div class="stat-value">${googleLeadStats.todayClicks}</div></div>
          <div class="stat-card"><div class="stat-title">📨 Template Sent</div><div class="stat-value">${googleLeadStats.byStatus.template_sent || 0}</div></div>
          <div class="stat-card"><div class="stat-title">💬 Patient Replied</div><div class="stat-value">${googleLeadStats.byStatus.patient_replied || 0}</div></div>
          <div class="stat-card connected-card"><div class="stat-title">🤝 Executive Connected</div><div class="stat-value">${googleLeadStats.byStatus.executive_connected || 0}</div></div>
          <div class="stat-card"><div class="stat-title">✅ Converted</div><div class="stat-value">${googleLeadStats.byStatus.converted || 0}</div></div>
          <div class="stat-card"><div class="stat-title">❌ Not Converted</div><div class="stat-value">${googleLeadStats.byStatus.not_converted || 0}</div></div>
        </div>
        
        <h2>📍 Branch-wise Clicks</h2>
        <div class="google-branch-grid">
          ${Object.entries(BRANCHES_CONFIG).map(([branch, config]) => `
            <div class="google-branch-card"><div class="google-branch-name">${branch}</div><div class="google-branch-count">${googleLeadStats.byBranch[branch] || 0}</div><div class="wa-number">📞 ${config.watiNumber}</div></div>
          `).join('')}
        </div>
        
        <h2>🕒 Recent Google Leads</h2>
        <div class="recent-section"><table><thead><tr><th>Time</th><th>Branch</th><th>Phone</th><th>Status</th></tr></thead><tbody>${googleLeadStats.recentLeads.slice(0, 50).map(lead => `<tr><td>${new Date(lead.clickedAt).toLocaleString()}</td><td><strong>${lead.branch}</strong></td><td>${lead.phoneNumber}</td><td><span class="google-status-badge status-${lead.status}">${lead.status.replace(/_/g, ' ')}</span></td></tr>`).join('')}</tbody></table></div>
        
        <h2>📊 Google Lead Templates</h2>
        <div class="recent-section">
          <h3>Template 1: google_lead_notification_v1</h3>
          <pre style="background:#f0f2f5;padding:10px;border-radius:8px;font-size:0.7em;">
🌟 Google My Business Lead Alert 🌟

Patient: {{1}}
Phone: {{2}}
Branch: {{3}}
Type: {{4}}
Tests: {{5}}
Time: {{6}}
Source: Google My Business 🏢

👇 Click to chat with patient:
{{7}}

Buttons: ✅ Convert Done | ⏰ Waiting</pre>
          
          <h3>Template 2: google_followup_no_reply</h3>
          <pre style="background:#f0f2f5;padding:10px;border-radius:8px;font-size:0.7em;">
🔔 Google Lead Reminder: Patient waiting for response

Source: Google My Business 🏢
Patient: {{1}}
Phone: {{2}}
Branch: {{3}}
Test: {{4}} - {{5}}
Time: {{6}}

👇 Click to reply:
{{7}}

DO NOT IGNORE - Google Lead

Buttons: ✅ Convert Done | ⏰ Waiting</pre>
          
          <h3>Template 3: google_followup_waiting</h3>
          <pre style="background:#f0f2f5;padding:10px;border-radius:8px;font-size:0.7em;">
⏳ Google Lead - Status Update Required

Source: Google My Business 🏢
Patient: {{1}}
Phone: {{2}}
Branch: {{3}}
Test: {{4}} - {{5}}
Waiting since: {{6}}

Please update status:

Buttons: ✅ Convert Done | ⏰ Waiting | ❌ Not Convert</pre>
          
          <h3>Template 4: google_executive_report</h3>
          <pre style="background:#f0f2f5;padding:10px;border-radius:8px;font-size:0.7em;">
📊 Google Lead - Your Performance Report

Period: {{1}} to {{2}}
Your Stats:
Total Leads: {{3}}
Connected: {{4}}
Converted: {{5}}
Conversion Rate: {{6}}%
Avg Response Time: {{7}} min

Branch-wise:
{{8}}

Keep up the good work! 🎉

Button: ✅ Read Done</pre>
          
          <h3>Template 5: google_escalation_manager</h3>
          <pre style="background:#f0f2f5;padding:10px;border-radius:8px;font-size:0.7em;">
🚨 GOOGLE LEAD ESCALATION ALERT

Source: Google My Business 🏢
Patient has been waiting for {{7}} hours.

Patient: {{1}}
Phone: {{2}}
Branch: {{3}}
Test: {{4}} - {{5}}
Waiting Count: {{6}}
Assigned Executive: {{8}}
Executive Phone: {{9}}

Please take action immediately.

Buttons: ✅ Convert Done | ⏰ Waiting | 📞 Call Executive | 👁️ View Details</pre>
        </div>
      </div>
    </div>
    
    <script>
      new Chart(document.getElementById('dailyChart'), { type: 'line', data: { labels: ${JSON.stringify(dailyMissCallLabels)}, datasets: [{ label: 'Miss Calls', data: ${JSON.stringify(dailyMissCallValues)}, borderColor: '#f97316', fill: true }] }, options: { responsive: true } });
      new Chart(document.getElementById('branchChart'), { type: 'bar', data: { labels: ${JSON.stringify(branchNames)}, datasets: [{ label: 'Total', data: ${JSON.stringify(branchTotalData)}, backgroundColor: '#075e54' }, { label: 'Converted', data: ${JSON.stringify(branchConvertedData)}, backgroundColor: '#10b981' }, { label: 'Connected', data: ${JSON.stringify(branchConnectedData)}, backgroundColor: '#3b82f6' }] }, options: { responsive: true, scales: { y: { beginAtZero: true } } } });
      setTimeout(() => location.reload(), 60000);
    </script>
  </body>
  </html>
  `;
}

module.exports = router;
