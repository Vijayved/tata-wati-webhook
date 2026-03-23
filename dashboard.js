// dashboard.js - Complete Professional Dashboard with Miss Call & GMB System
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
    
    res.json({ success: true, message: 'Database reset successful!', deleted: results });
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
    
    // Executive numbers mapping (4 executives + manager)
    const EXECUTIVES = {
      'Aditi': '8488931212',
      'Khyati': '7490029085',
      'Jay': '9274682553',
      'Mital': '9558591212',
      'Manager': '7698011233'
    };
    
    // Executive Names for display
    const EXECUTIVE_NAMES = {
      '8488931212': 'Aditi',
      '7490029085': 'Khyati',
      '9274682553': 'Jay',
      '9558591212': 'Mital',
      '7698011233': 'Manager'
    };
    
    // 20 Branches Configuration
    const BRANCHES_CONFIG = {
      'Naroda': { executive: 'Aditi', number: '8488931212' },
      'Ahmedabad': { executive: 'Aditi', number: '8488931212' },
      'Gandhinagar': { executive: 'Aditi', number: '8488931212' },
      'Sabarmati': { executive: 'Aditi', number: '8488931212' },
      'Anand': { executive: 'Aditi', number: '8488931212' },
      'Usmanpura': { executive: 'Khyati', number: '7490029085' },
      'Satellite': { executive: 'Khyati', number: '7490029085' },
      'Nadiad': { executive: 'Khyati', number: '7490029085' },
      'Jamnagar': { executive: 'Khyati', number: '7490029085' },
      'Bhavnagar': { executive: 'Khyati', number: '7490029085' },
      'Bapunagar': { executive: 'Jay', number: '9274682553' },
      'Juhapura': { executive: 'Jay', number: '9274682553' },
      'Surat': { executive: 'Jay', number: '9274682553' },
      'Changodar': { executive: 'Jay', number: '9274682553' },
      'Bareja': { executive: 'Jay', number: '9274682553' },
      'Vadaj': { executive: 'Mital', number: '9558591212' },
      'Maninagar': { executive: 'Mital', number: '9558591212' },
      'Rajkot': { executive: 'Mital', number: '9558591212' },
      'Vadodara': { executive: 'Mital', number: '9558591212' },
      'Morbi': { executive: 'Mital', number: '9558591212' }
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
      thisWeekClicks: 0,
      thisMonthClicks: 0,
      byBranch: {},
      byExecutive: {},
      byStatus: {
        clicked: 0,
        template_sent: 0,
        patient_replied: 0,
        executive_connected: 0,
        converted: 0,
        not_converted: 0
      },
      recentLeads: [],
      conversionRate: 0
    };
    
    if (googleLeadsCollection) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const monthAgo = new Date(today);
      monthAgo.setDate(monthAgo.getDate() - 30);
      
      googleLeadStats.totalClicks = await googleLeadsCollection.countDocuments();
      googleLeadStats.todayClicks = await googleLeadsCollection.countDocuments({ clickedAt: { $gte: today } });
      googleLeadStats.thisWeekClicks = await googleLeadsCollection.countDocuments({ clickedAt: { $gte: weekAgo } });
      googleLeadStats.thisMonthClicks = await googleLeadsCollection.countDocuments({ clickedAt: { $gte: monthAgo } });
      
      const branchStats = await googleLeadsCollection.aggregate([
        { $group: { _id: '$branch', count: { $sum: 1 } } }
      ]).toArray();
      branchStats.forEach(b => { googleLeadStats.byBranch[b._id] = b.count; });
      
      const execStats = await googleLeadsCollection.aggregate([
        { $group: { _id: '$executiveName', count: { $sum: 1 } } }
      ]).toArray();
      execStats.forEach(e => { googleLeadStats.byExecutive[e._id] = e.count; });
      
      const statusStats = await googleLeadsCollection.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]).toArray();
      statusStats.forEach(s => {
        if (googleLeadStats.byStatus[s._id] !== undefined) {
          googleLeadStats.byStatus[s._id] = s.count;
        }
      });
      
      const converted = googleLeadStats.byStatus.converted || 0;
      const total = googleLeadStats.totalClicks;
      googleLeadStats.conversionRate = total > 0 ? ((converted / total) * 100).toFixed(1) : 0;
      
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
    for (const [execName, execNumber] of Object.entries(EXECUTIVES)) {
      if (execName === 'Manager') continue;
      executiveStats[execName] = {
        execNumber: execNumber,
        total: 0, pending: 0, converted: 0, waiting: 0, notConverted: 0,
        awaitingBranch: 0, branchSelected: 0, awaitingName: 0, awaitingTestType: 0, awaitingTestDetails: 0,
        executiveNotified: 0, connected: 0, noReply: 0, singleMissCall: 0, highMissCall: 0,
        templateSent: 0, escalated: 0, activeChat: 0
      };
      executivePatients[execName] = [];
    }
    
    for (const patient of patients) {
      const execNumber = patient.executiveNumber;
      let execName = EXECUTIVE_NAMES[execNumber];
      if (execName && execName !== 'Manager') {
        executiveStats[execName].total++;
        if (patient.status === 'pending') executiveStats[execName].pending++;
        else if (patient.status === 'converted') executiveStats[execName].converted++;
        else if (patient.status === 'waiting') executiveStats[execName].waiting++;
        else if (patient.status === 'not_converted') executiveStats[execName].notConverted++;
        
        if (patient.currentStage === 'awaiting_branch') executiveStats[execName].awaitingBranch++;
        else if (patient.currentStage === 'branch_selected') executiveStats[execName].branchSelected++;
        else if (patient.currentStage === 'awaiting_name') executiveStats[execName].awaitingName++;
        else if (patient.currentStage === 'awaiting_test_type') executiveStats[execName].awaitingTestType++;
        else if (patient.currentStage === 'awaiting_test_details') executiveStats[execName].awaitingTestDetails++;
        else if (patient.currentStage === 'executive_notified') executiveStats[execName].executiveNotified++;
        else if (patient.currentStage === 'connected') executiveStats[execName].connected++;
        
        const hasActiveSession = allSessions.some(s => s.patientPhone === patient.patientPhone && s.status === 'active');
        if (hasActiveSession && patient.currentStage === 'connected') executiveStats[execName].activeChat++;
        
        if (patient.executiveActionTaken === false) executiveStats[execName].noReply++;
        if ((patient.missCallCount || 1) === 1) executiveStats[execName].singleMissCall++;
        if ((patient.missCallCount || 1) >= 3) executiveStats[execName].highMissCall++;
        if (patient.currentStage === 'executive_notified' || patient.currentStage === 'connected') executiveStats[execName].templateSent++;
        if (patient.escalatedToManager === true) executiveStats[execName].escalated++;
        
        executivePatients[execName].push({
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
      filters, EXECUTIVES, EXECUTIVE_NAMES, BRANCHES_CONFIG, googleLeadStats,
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
    filters, EXECUTIVES, EXECUTIVE_NAMES, BRANCHES_CONFIG, googleLeadStats,
    totalPatients, pendingCount, convertedCount, waitingCount, notConvertedCount,
    missCallTotal, missCallToday, missCallYesterday, missCallLast7Days,
    patientsWithoutReply, singleMissCallPatients, templateSentPatients,
    highMissCallPatients, waitingPatients, escalatedPatients,
    activeConversations, connectedPatients, followupStats,
    branchTests, overallTests, dailyMissCalls,
    recentPatients, recentMissCalls, topMissCallPatients,
    recentFollowups, executiveStats, executivePatients,
    branches, executivesList, exportData
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
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>UIC Support Dashboard | Executive Management System</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { 
        font-family: 'Inter', sans-serif; 
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); 
        min-height: 100vh; 
        padding: 20px;
      }
      .container { max-width: 1600px; margin: 0 auto; }
      
      /* Header */
      .dashboard-header { margin-bottom: 30px; }
      .dashboard-header h1 { 
        font-size: 2rem; 
        font-weight: 700; 
        background: linear-gradient(135deg, #fff 0%, #94a3b8 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        margin-bottom: 8px;
      }
      .dashboard-header p { color: #64748b; font-size: 0.9rem; }
      
      /* Tabs */
      .tabs { display: flex; gap: 12px; margin-bottom: 25px; background: rgba(255,255,255,0.05); padding: 8px; border-radius: 16px; backdrop-filter: blur(10px); }
      .tab-btn { 
        padding: 12px 28px; 
        border: none; 
        border-radius: 12px; 
        font-size: 0.95rem; 
        font-weight: 600; 
        cursor: pointer; 
        transition: all 0.3s ease;
        display: flex;
        align-items: center;
        gap: 8px;
        background: transparent;
        color: #94a3b8;
      }
      .tab-btn.misscall.active { background: linear-gradient(135deg, #075e54, #128C7E); color: white; box-shadow: 0 4px 15px rgba(18,140,126,0.3); }
      .tab-btn.gmb.active { background: linear-gradient(135deg, #1e40af, #3b82f6); color: white; box-shadow: 0 4px 15px rgba(59,130,246,0.3); }
      .tab-content { display: none; }
      .tab-content.active { display: block; animation: fadeIn 0.4s ease; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      
      /* Filter Bar */
      .filter-bar { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 20px; padding: 20px; margin-bottom: 25px; border: 1px solid rgba(255,255,255,0.1); }
      .filter-row { display: flex; flex-wrap: wrap; gap: 15px; margin-bottom: 15px; align-items: flex-end; }
      .filter-group { flex: 1; min-width: 140px; }
      .filter-group label { display: block; font-size: 0.7rem; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
      .filter-group select, .filter-group input { width: 100%; padding: 10px 14px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: white; font-size: 0.85rem; transition: all 0.2s; }
      .filter-group select:focus, .filter-group input:focus { outline: none; border-color: #10b981; }
      .filter-actions { display: flex; gap: 12px; align-items: center; }
      .btn-filter { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 10px 24px; border-radius: 12px; cursor: pointer; font-weight: 600; transition: all 0.2s; }
      .btn-filter:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(16,185,129,0.3); }
      .btn-reset-filter { background: rgba(255,255,255,0.1); color: white; border: 1px solid rgba(255,255,255,0.2); padding: 10px 24px; border-radius: 12px; cursor: pointer; font-weight: 600; text-decoration: none; display: inline-block; text-align: center; }
      .btn-reset-filter:hover { background: rgba(255,255,255,0.2); }
      .btn-export { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; border: none; padding: 10px 24px; border-radius: 12px; cursor: pointer; font-weight: 600; }
      .btn-reset-db { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; border: none; padding: 10px 20px; border-radius: 12px; cursor: pointer; font-weight: 600; margin-left: 10px; }
      
      /* Stats Grid */
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; margin-bottom: 30px; }
      .stat-card { background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border-radius: 20px; padding: 20px 16px; border: 1px solid rgba(255,255,255,0.05); transition: all 0.3s ease; }
      .stat-card:hover { transform: translateY(-3px); background: rgba(255,255,255,0.12); }
      .stat-title { font-size: 0.7rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
      .stat-value { font-size: 2rem; font-weight: 700; color: white; margin-bottom: 4px; }
      .stat-change { font-size: 0.7rem; color: #10b981; }
      .stat-card.alert { background: linear-gradient(135deg, rgba(239,68,68,0.2), rgba(220,38,38,0.1)); border-color: rgba(239,68,68,0.3); }
      .stat-card.success { background: linear-gradient(135deg, rgba(16,185,129,0.2), rgba(5,150,105,0.1)); border-color: rgba(16,185,129,0.3); }
      .stat-card.info { background: linear-gradient(135deg, rgba(59,130,246,0.2), rgba(37,99,235,0.1)); border-color: rgba(59,130,246,0.3); }
      .stat-card.warning { background: linear-gradient(135deg, rgba(245,158,11,0.2), rgba(217,119,6,0.1)); border-color: rgba(245,158,11,0.3); }
      
      /* Cards */
      .card { background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border-radius: 20px; padding: 20px; margin-bottom: 25px; border: 1px solid rgba(255,255,255,0.05); }
      .card-title { font-size: 1.1rem; font-weight: 600; color: white; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; border-left: 3px solid #10b981; padding-left: 12px; }
      
      /* Executive Grid */
      .executive-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .executive-card { background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border-radius: 20px; overflow: hidden; border: 1px solid rgba(255,255,255,0.05); transition: all 0.3s; }
      .executive-card:hover { transform: translateY(-3px); background: rgba(255,255,255,0.12); }
      .executive-header { background: linear-gradient(135deg, rgba(7,94,84,0.3), rgba(18,140,126,0.2)); padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .executive-name { font-weight: 700; font-size: 1.1rem; color: white; }
      .executive-phone { font-size: 0.7rem; color: #94a3b8; margin-top: 4px; }
      .executive-stats { padding: 16px 20px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; background: rgba(0,0,0,0.2); text-align: center; }
      .executive-stat-number { font-size: 1.3rem; font-weight: 700; color: white; }
      .executive-stat-label { font-size: 0.65rem; color: #94a3b8; margin-top: 4px; }
      .stage-row { padding: 12px 20px; display: flex; flex-wrap: wrap; gap: 8px; background: rgba(0,0,0,0.15); font-size: 0.7rem; }
      .stage-badge { padding: 4px 10px; border-radius: 20px; font-size: 0.7rem; background: rgba(255,255,255,0.1); color: #94a3b8; }
      .alert-row-exec { padding: 12px 20px; display: flex; flex-wrap: wrap; justify-content: space-between; background: rgba(239,68,68,0.1); font-size: 0.7rem; }
      .executive-detail-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 8px 16px; border-radius: 12px; cursor: pointer; font-weight: 600; margin: 16px 20px; width: calc(100% - 40px); transition: all 0.2s; }
      .executive-detail-btn:hover { transform: translateY(-2px); }
      .patient-list { display: none; margin: 0 20px 20px; padding: 16px; background: rgba(0,0,0,0.2); border-radius: 12px; max-height: 300px; overflow-y: auto; }
      .patient-list.show { display: block; }
      .patient-item { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); font-size: 0.75rem; }
      .connected-badge { background: #10b981; color: white; padding: 2px 8px; border-radius: 20px; font-size: 0.65rem; margin-left: 8px; }
      .no-reply { color: #f97316; font-weight: 600; }
      .blink-red { animation: blink 1s infinite; background: #ef4444; color: white; padding: 2px 6px; border-radius: 8px; display: inline-block; font-size: 0.7rem; }
      @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.6; } 100% { opacity: 1; } }
      
      /* Charts */
      .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .chart-card { background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border-radius: 20px; padding: 20px; border: 1px solid rgba(255,255,255,0.05); }
      canvas { max-height: 300px; width: 100%; }
      
      /* Tables */
      .recent-section { background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border-radius: 20px; padding: 20px; margin-bottom: 25px; overflow-x: auto; border: 1px solid rgba(255,255,255,0.05); }
      table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
      th { text-align: left; padding: 12px 8px; color: #94a3b8; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.1); }
      td { padding: 10px 8px; color: #e2e8f0; border-bottom: 1px solid rgba(255,255,255,0.05); }
      .badge { padding: 4px 8px; border-radius: 20px; font-size: 0.7rem; font-weight: 600; background: rgba(255,255,255,0.1); }
      
      /* Google Branch Grid */
      .google-branch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 25px; }
      .google-branch-card { background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border-radius: 16px; padding: 16px; text-align: center; border: 1px solid rgba(255,255,255,0.05); }
      .google-branch-name { font-weight: 600; color: white; margin-bottom: 8px; }
      .google-branch-count { font-size: 2rem; font-weight: 700; color: #3b82f6; margin: 8px 0; }
      .google-status-badge { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 0.7rem; font-weight: 600; }
      .status-clicked { background: #fef3c7; color: #92400e; }
      .status-template_sent { background: #dbeafe; color: #1e40af; }
      .status-patient_replied { background: #d1fae5; color: #065f46; }
      .status-executive_connected { background: #c8e6e9; color: #00695c; }
      .status-converted { background: #10b981; color: white; }
      
      /* Top Patients */
      .top-patients-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 25px; }
      .top-patient-card { background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border-radius: 16px; padding: 15px; border-left: 3px solid #f97316; }
      .refresh-btn { background: rgba(255,255,255,0.1); color: white; border: 1px solid rgba(255,255,255,0.2); padding: 10px 20px; border-radius: 12px; cursor: pointer; margin-bottom: 20px; font-weight: 600; }
      .refresh-btn:hover { background: rgba(255,255,255,0.2); }
      .last-updated { color: #64748b; margin-bottom: 20px; font-size: 0.75rem; }
    </style>
    <script>
      function toggleCustomDate() {
        const dateRange = document.querySelector('select[name="dateRange"]').value;
        const customDiv = document.getElementById('customDateRange');
        customDiv.style.display = dateRange === 'custom' ? 'flex' : 'none';
      }
      function togglePatientList(exec) { document.getElementById('patient-list-' + exec).classList.toggle('show'); }
      function exportToExcel() { 
        const tableData = ${exportDataJson};
        const ws = XLSX.utils.json_to_sheet(tableData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Patients Data');
        XLSX.writeFile(wb, 'patients_export_' + new Date().toISOString().slice(0,19) + '.xlsx');
      }
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
        toggleCustomDate();
      });
    </script>
  </head>
  <body>
    <div class="container">
      <div class="dashboard-header">
        <h1>🏥 Executive Dashboard</h1>
        <p>Real-time analytics & performance tracking for UIC Support System</p>
      </div>
      
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
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Data</button>
          <div class="last-updated">Last updated: ${new Date().toLocaleString()}</div>
        </div>
        
        <!-- Alert Cards -->
        <div class="stats-grid">
          <div class="stat-card alert"><div class="stat-title">⚠️ No Reply</div><div class="stat-value">${patientsWithoutReply.length}</div></div>
          <div class="stat-card warning"><div class="stat-title">📞 Single Miss Call</div><div class="stat-value">${singleMissCallPatients.length}</div></div>
          <div class="stat-card alert"><div class="stat-title">🔴 High Miss Call (3+)</div><div class="stat-value">${highMissCallPatients.length}</div></div>
          <div class="stat-card warning"><div class="stat-title">⏳ Waiting >2hrs</div><div class="stat-value">${waitingPatients.length}</div></div>
          <div class="stat-card alert"><div class="stat-title">🚨 Escalated</div><div class="stat-value">${escalatedPatients.length}</div></div>
          <div class="stat-card success"><div class="stat-title">💬 Active Chats</div><div class="stat-value">${activeConversations.length}</div></div>
          <div class="stat-card success"><div class="stat-title">✅ Connected</div><div class="stat-value">${connectedPatients.length}</div></div>
          <div class="stat-card info"><div class="stat-title">📨 Template Sent</div><div class="stat-value">${templateSentPatients.length}</div></div>
        </div>
        
        <!-- Follow-up Stats -->
        <div class="stats-grid">
          <div class="stat-card info"><div class="stat-title">📢 Total Follow-ups</div><div class="stat-value">${followupStats.total}</div></div>
          <div class="stat-card"><div class="stat-title">⏰ No Reply</div><div class="stat-value">${followupStats.noReply}</div></div>
          <div class="stat-card"><div class="stat-title">⏳ Waiting</div><div class="stat-value">${followupStats.waiting}</div></div>
          <div class="stat-card alert"><div class="stat-title">🚨 Escalations</div><div class="stat-value">${followupStats.escalation}</div></div>
          <div class="stat-card"><div class="stat-title">📅 Today</div><div class="stat-value">${followupStats.today}</div></div>
        </div>
        
        <!-- Overall Stats -->
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-title">Total Patients</div><div class="stat-value">${totalPatients}</div></div>
          <div class="stat-card warning"><div class="stat-title">Pending</div><div class="stat-value">${pendingCount}</div></div>
          <div class="stat-card success"><div class="stat-title">Converted</div><div class="stat-value">${convertedCount}</div></div>
          <div class="stat-card info"><div class="stat-title">Waiting</div><div class="stat-value">${waitingCount}</div></div>
          <div class="stat-card"><div class="stat-title">Not Converted</div><div class="stat-value">${notConvertedCount}</div></div>
          <div class="stat-card misscall-card"><div class="stat-title">Total Miss Calls</div><div class="stat-value">${missCallTotal}</div></div>
          <div class="stat-card"><div class="stat-title">Today</div><div class="stat-value">${missCallToday}</div><div class="stat-change">${missCallToday > missCallYesterday ? '↑' : '↓'} ${Math.abs(missCallToday - missCallYesterday)}</div></div>
          <div class="stat-card"><div class="stat-title">Last 7 Days</div><div class="stat-value">${missCallLast7Days}</div></div>
        </div>
        
        <!-- Test Distribution -->
        <div class="card">
          <div class="card-title">📊 Test Distribution</div>
          <div class="stats-grid" style="margin-bottom: 0;">
            <div class="stat-card"><div class="stat-title">MRI</div><div class="stat-value">${overallTests.MRI}</div></div>
            <div class="stat-card"><div class="stat-title">CT</div><div class="stat-value">${overallTests.CT}</div></div>
            <div class="stat-card"><div class="stat-title">X-RAY</div><div class="stat-value">${overallTests['X-RAY']}</div></div>
            <div class="stat-card"><div class="stat-title">USG</div><div class="stat-value">${overallTests.USG}</div></div>
            <div class="stat-card"><div class="stat-title">Others</div><div class="stat-value">${overallTests.OTHER}</div></div>
          </div>
        </div>
        
        <!-- Executive Performance -->
        <div class="card">
          <div class="card-title">👥 Executive Performance</div>
          <div class="executive-grid">
            ${Object.entries(executiveStats).map(([execName, stats]) => `
              <div class="executive-card">
                <div class="executive-header">
                  <div><div class="executive-name">${execName}</div><div class="executive-phone">${stats.execNumber}</div></div>
                  <div style="font-weight: 700; font-size: 1.2rem;">${stats.total}</div>
                </div>
                <div class="executive-stats">
                  <div><div class="executive-stat-number" style="color:#f59e0b;">${stats.pending}</div><div class="executive-stat-label">Pending</div></div>
                  <div><div class="executive-stat-number" style="color:#10b981;">${stats.converted}</div><div class="executive-stat-label">Converted</div></div>
                  <div><div class="executive-stat-number" style="color:#3b82f6;">${stats.waiting}</div><div class="executive-stat-label">Waiting</div></div>
                  <div><div class="executive-stat-number" style="color:#ef4444;">${stats.notConverted}</div><div class="executive-stat-label">Not Conv</div></div>
                  <div><div class="executive-stat-number" style="color:#10b981;">${stats.activeChat}</div><div class="executive-stat-label">Active</div></div>
                </div>
                <div class="stage-row">
                  <span class="stage-badge">📌 Await: ${stats.awaitingBranch}</span>
                  <span class="stage-badge">✅ Selected: ${stats.branchSelected}</span>
                  <span class="stage-badge">📝 Name: ${stats.awaitingName}</span>
                  <span class="stage-badge">🔬 Test: ${stats.awaitingTestType+stats.awaitingTestDetails}</span>
                  <span class="stage-badge">📢 Notified: ${stats.executiveNotified}</span>
                  <span class="stage-badge">💬 Connected: ${stats.connected}</span>
                </div>
                <div class="alert-row-exec">
                  <span>⚠️ No Reply: <strong style="color:#f97316;">${stats.noReply}</strong></span>
                  <span>📞 Single: ${stats.singleMissCall}</span>
                  <span>🔴 High: <span class="${stats.highMissCall > 0 ? 'blink-red' : ''}">${stats.highMissCall}</span></span>
                  <span>🚨 Escalated: ${stats.escalated}</span>
                </div>
                <button class="executive-detail-btn" onclick="togglePatientList('${execName}')">📋 View ${stats.total} Patients</button>
                <div id="patient-list-${execName}" class="patient-list">
                  ${executivePatients[execName] && executivePatients[execName].length > 0 ? executivePatients[execName].slice(0, 30).map(p => `
                    <div class="patient-item ${p.missCallCount >= 3 ? 'high-miss-call' : ''}">
                      <strong>${p.patientName || 'Unknown'}</strong> (${p.patientPhone})${p.hasActiveSession ? '<span class="connected-badge">💬 Active</span>' : ''}<br>
                      <small>Test: ${p.testDetails || p.testType || 'N/A'} | ${p.missCallCount} calls</small><br>
                      <small>Stage: ${p.currentStage || 'N/A'} | Status: ${p.status || 'N/A'}</small>
                      ${!p.executiveActionTaken ? '<span class="no-reply"> ⚠️ No reply</span>' : ''}
                    </div>
                  `).join('') : '<div style="padding: 10px; text-align: center;">No patients</div>'}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        
        <!-- Charts -->
        <div class="charts-grid">
          <div class="chart-card"><canvas id="dailyChart"></canvas></div>
          <div class="chart-card"><canvas id="branchChart"></canvas></div>
        </div>
        
        <!-- Top Miss Call Patients -->
        <div class="card">
          <div class="card-title">📞 Top Miss Call Patients</div>
          <div class="top-patients-grid">
            ${topMissCallPatients.map(p => `
              <div class="top-patient-card ${p.missCallCount >= 3 ? 'high-miss-call' : ''}">
                <strong>${p.patientName || 'Unknown'}</strong><br>
                <small>${p.patientPhone}</small><br>
                <span style="color:#f97316; font-weight:700;">${p.missCallCount || 1} calls</span><br>
                <small>${p.branch || 'N/A'} | ${p.status || 'pending'}</small>
              </div>
            `).join('')}
          </div>
        </div>
        
        <!-- Recent Patients -->
        <div class="card">
          <div class="card-title">🕒 Recent Patients</div>
          <div class="recent-section">
            <table>
              <thead><tr><th>Patient</th><th>Phone</th><th>Branch</th><th>Test</th><th>Stage</th><th>Status</th><th>Calls</th><th>Active</th><th>Time</th></tr></thead>
              <tbody>${recentPatients.slice(0, 50).map(p => `<tr><td><strong>${p.patientName || 'N/A'}</strong>${p.escalatedToManager ? ' 🚨' : ''}</td><td>${p.patientPhone || 'N/A'}</td><td>${p.branch || 'N/A'}</td><td>${p.testDetails || p.testType || 'N/A'}</td><td><span class="badge">${(p.currentStage || 'pending').replace(/_/g, ' ')}</span></td><td><span class="badge">${p.status || 'pending'}</span></td><td>${p.missCallCount || 1}</td><td>${p.hasActiveSession ? '✅' : '❌'}</td><td>${new Date(p.createdAt).toLocaleString()}</td></tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
        
        <!-- Recent Miss Calls -->
        <div class="card">
          <div class="card-title">📞 Recent Miss Calls</div>
          <div class="recent-section">
            <table>
              <thead><tr><th>Phone</th><th>Branch</th><th>Time</th></tr></thead>
              <tbody>${recentMissCalls.slice(0, 30).map(m => `<tr><td>${m.phoneNumber || 'N/A'}</td><td>${m.branch || 'N/A'}</td><td>${new Date(m.createdAt).toLocaleString()}</td></tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
        
        <!-- Recent Follow-ups -->
        <div class="card">
          <div class="card-title">📢 Recent Follow-ups</div>
          <div class="recent-section">
            <table>
              <thead><tr><th>Type</th><th>Patient Phone</th><th>Executive</th><th>Time</th></tr></thead>
              <tbody>${recentFollowups.slice(0, 30).map(f => `<tr><td><span class="badge">${f.type}</span></td><td>${f.patientPhone || 'N/A'}</td><td>${f.executiveNumber || 'N/A'}</td><td>${new Date(f.sentAt).toLocaleString()}</td></tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
      </div>
      
      <!-- ==================== GOOGLE MY BUSINESS TAB ==================== -->
      <div id="tab-gmb" class="tab-content">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Data</button>
          <div class="last-updated">Last updated: ${new Date().toLocaleString()}</div>
        </div>
        
        <!-- Google Lead Stats -->
        <div class="stats-grid">
          <div class="stat-card success"><div class="stat-title">Total Clicks</div><div class="stat-value">${googleLeadStats.totalClicks}</div></div>
          <div class="stat-card success"><div class="stat-title">Today's Clicks</div><div class="stat-value">${googleLeadStats.todayClicks}</div></div>
          <div class="stat-card info"><div class="stat-title">This Week</div><div class="stat-value">${googleLeadStats.thisWeekClicks}</div></div>
          <div class="stat-card info"><div class="stat-title">This Month</div><div class="stat-value">${googleLeadStats.thisMonthClicks}</div></div>
          <div class="stat-card"><div class="stat-title">📨 Template Sent</div><div class="stat-value">${googleLeadStats.byStatus.template_sent || 0}</div></div>
          <div class="stat-card"><div class="stat-title">💬 Patient Replied</div><div class="stat-value">${googleLeadStats.byStatus.patient_replied || 0}</div></div>
          <div class="stat-card success"><div class="stat-title">🤝 Executive Connected</div><div class="stat-value">${googleLeadStats.byStatus.executive_connected || 0}</div></div>
          <div class="stat-card"><div class="stat-title">✅ Converted</div><div class="stat-value">${googleLeadStats.byStatus.converted || 0}</div></div>
          <div class="stat-card"><div class="stat-title">❌ Not Converted</div><div class="stat-value">${googleLeadStats.byStatus.not_converted || 0}</div></div>
          <div class="stat-card success"><div class="stat-title">📊 Conversion Rate</div><div class="stat-value">${googleLeadStats.conversionRate}%</div></div>
        </div>
        
        <!-- Executive-wise Performance -->
        <div class="card">
          <div class="card-title">👥 Executive Performance (GMB)</div>
          <div class="executive-grid">
            ${Object.entries(googleLeadStats.byExecutive).map(([exec, count]) => `
              <div class="executive-card">
                <div class="executive-header">
                  <div><div class="executive-name">${exec}</div><div class="executive-phone">${EXECUTIVES[exec] || 'N/A'}</div></div>
                  <div style="font-size: 1.5rem; font-weight: 700;">${count}</div>
                </div>
                <div style="padding: 16px; text-align: center;">
                  <div class="executive-stat-number" style="color:#10b981;">${((count / googleLeadStats.totalClicks) * 100).toFixed(1)}%</div>
                  <div class="executive-stat-label">of total leads</div>
                </div>
              </div>
            `).join('')}
            ${Object.keys(googleLeadStats.byExecutive).length === 0 ? '<div style="padding: 40px; text-align: center; color: #64748b;">No GMB leads yet</div>' : ''}
          </div>
        </div>
        
        <!-- Branch-wise Clicks -->
        <div class="card">
          <div class="card-title">📍 Branch-wise Clicks</div>
          <div class="google-branch-grid">
            ${Object.entries(BRANCHES_CONFIG).map(([branch, config]) => `
              <div class="google-branch-card">
                <div class="google-branch-name">${branch}</div>
                <div class="google-branch-count">${googleLeadStats.byBranch[branch] || 0}</div>
                <div class="executive-phone">👤 ${config.executive}</div>
                <div class="executive-phone">📞 ${config.number}</div>
              </div>
            `).join('')}
          </div>
        </div>
        
        <!-- Recent Google Leads -->
        <div class="card">
          <div class="card-title">🕒 Recent Google Leads</div>
          <div class="recent-section">
            <table>
              <thead><tr><th>Time</th><th>Branch</th><th>Phone</th><th>Executive</th><th>Status</th></tr></thead>
              <tbody>${googleLeadStats.recentLeads.slice(0, 50).map(lead => `
                <tr>
                  <td>${new Date(lead.clickedAt).toLocaleString()}</td>
                  <td><strong>${lead.branch}</strong></td>
                  <td>${lead.phoneNumber}</td>
                  <td>${lead.executiveName || 'N/A'}</td>
                  <td><span class="google-status-badge status-${lead.status}">${lead.status.replace(/_/g, ' ')}</span></td>
                </tr>
              `).join('')}</tbody>
            </table>
          </div>
        </div>
        
        <!-- Google Templates Info -->
        <div class="card">
          <div class="card-title">📋 Google Lead Templates</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px;">
            <div style="background: rgba(0,0,0,0.2); border-radius: 12px; padding: 15px;">
              <div style="font-weight: 600; color: #10b981; margin-bottom: 8px;">google_lead_notification_v1</div>
              <div style="font-size: 0.7rem; color: #94a3b8;">New lead alert to executive with buttons</div>
            </div>
            <div style="background: rgba(0,0,0,0.2); border-radius: 12px; padding: 15px;">
              <div style="font-weight: 600; color: #3b82f6; margin-bottom: 8px;">google_followup_no_reply</div>
              <div style="font-size: 0.7rem; color: #94a3b8;">Reminder when executive doesn't reply</div>
            </div>
            <div style="background: rgba(0,0,0,0.2); border-radius: 12px; padding: 15px;">
              <div style="font-weight: 600; color: #f59e0b; margin-bottom: 8px;">google_followup_waiting</div>
              <div style="font-size: 0.7rem; color: #94a3b8;">Status update reminder after waiting</div>
            </div>
            <div style="background: rgba(0,0,0,0.2); border-radius: 12px; padding: 15px;">
              <div style="font-weight: 600; color: #8b5cf6; margin-bottom: 8px;">google_executive_report</div>
              <div style="font-size: 0.7rem; color: #94a3b8;">Weekly performance report for executives</div>
            </div>
            <div style="background: rgba(0,0,0,0.2); border-radius: 12px; padding: 15px;">
              <div style="font-weight: 600; color: #ef4444; margin-bottom: 8px;">google_escalation_manager</div>
              <div style="font-size: 0.7rem; color: #94a3b8;">Escalation alert to manager</div>
            </div>
            <div style="background: rgba(0,0,0,0.2); border-radius: 12px; padding: 15px;">
              <div style="font-weight: 600; color: #14b8a6; margin-bottom: 8px;">gmb_customer_welcome</div>
              <div style="font-size: 0.7rem; color: #94a3b8;">Customer welcome template with services</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <script>
      new Chart(document.getElementById('dailyChart'), {
        type: 'line',
        data: { labels: ${JSON.stringify(dailyMissCallLabels)}, datasets: [{ label: 'Miss Calls', data: ${JSON.stringify(dailyMissCallValues)}, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3 }] },
        options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: '#94a3b8' } } } }
      });
      new Chart(document.getElementById('branchChart'), {
        type: 'bar',
        data: { labels: ${JSON.stringify(branchNames)}, datasets: [{ label: 'Total', data: ${JSON.stringify(branchTotalData)}, backgroundColor: '#3b82f6' }, { label: 'Converted', data: ${JSON.stringify(branchConvertedData)}, backgroundColor: '#10b981' }, { label: 'Connected', data: ${JSON.stringify(branchConnectedData)}, backgroundColor: '#8b5cf6' }] },
        options: { responsive: true, maintainAspectRatio: true, scales: { y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.1)' } }, x: { ticks: { color: '#94a3b8' } } }, plugins: { legend: { labels: { color: '#94a3b8' } } } }
      });
      setTimeout(() => location.reload(), 60000);
    </script>
  </body>
  </html>
  `;
}

module.exports = router;
