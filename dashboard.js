// dashboard.js - Complete Admin Dashboard
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
    
    // Get stats
    const totalPatients = await patientsCollection.countDocuments();
    const pendingCount = await patientsCollection.countDocuments({ status: 'pending' });
    const convertedCount = await patientsCollection.countDocuments({ status: 'converted' });
    const waitingCount = await patientsCollection.countDocuments({ status: 'waiting' });
    const notConvertedCount = await patientsCollection.countDocuments({ status: 'not_converted' });
    
    const stageStats = {};
    for (const stage of Object.values(STAGES)) {
      stageStats[stage] = await patientsCollection.countDocuments({ currentStage: stage }) || 0;
    }
    
    const missCallTotal = await missCallsCollection.countDocuments();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const missCallToday = await missCallsCollection.countDocuments({
      createdAt: { $gte: today }
    });
    
    const branchStats = await missCallsCollection.aggregate([
      { $group: { _id: '$branch', count: { $sum: 1 } } }
    ]).toArray();
    
    const branchMissCallMap = {};
    branchStats.forEach(b => { branchMissCallMap[b._id] = b.count; });
    
    const recentPatients = await patientsCollection.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    
    const recentMissCalls = await missCallsCollection.find()
      .sort({ createdAt: -1 })
      .limit(20)
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
      branchMissCallMap,
      recentPatients,
      recentMissCalls,
      topMissCallPatients,
      PORT
    }));
    
  } catch (error) {
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
    branchMissCallMap,
    recentPatients,
    recentMissCalls,
    topMissCallPatients,
    PORT
  } = data;
  
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Executive Dashboard</title>
    <meta http-equiv="refresh" content="10">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
      .container { max-width: 1400px; margin: 0 auto; }
      h1 { color: white; margin-bottom: 30px; font-size: 2.5em; }
      h2 { color: white; margin: 30px 0 15px; font-size: 1.8em; }
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .stat-card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); transition: transform 0.3s; }
      .stat-card:hover { transform: translateY(-5px); }
      .stat-title { font-size: 0.9em; color: #666; text-transform: uppercase; }
      .stat-value { font-size: 2.5em; font-weight: bold; color: #333; margin-top: 10px; }
      .misscall-card { background: linear-gradient(135deg, #ff6b6b, #ff8e8e); }
      .misscall-card .stat-title, .misscall-card .stat-value { color: white; }
      .stage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 30px; }
      .stage-card { background: white; border-radius: 8px; padding: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); border-left: 4px solid; }
      .stage-card.awaiting_branch { border-color: #f59e0b; }
      .stage-card.branch_selected { border-color: #3b82f6; }
      .stage-card.executive_notified { border-color: #8b5cf6; }
      .stage-card.converted { border-color: #10b981; }
      .stage-card.waiting { border-color: #f59e0b; }
      .stage-card.not_converted { border-color: #ef4444; }
      .stage-name { font-size: 0.8em; color: #666; text-transform: uppercase; }
      .stage-value { font-size: 1.8em; font-weight: bold; margin-top: 5px; }
      .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .chart-card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      .recent-section { background: white; border-radius: 10px; padding: 20px; margin-bottom: 30px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
      table { width: 100%; border-collapse: collapse; }
      th { background: #f8f9fa; padding: 12px; text-align: left; }
      td { padding: 12px; border-bottom: 1px solid #e2e8f0; }
      .badge { padding: 4px 8px; border-radius: 12px; font-size: 0.8em; font-weight: 600; }
      .badge-pending { background: #fef3c7; color: #92400e; }
      .badge-converted { background: #d1fae5; color: #065f46; }
      .badge-waiting { background: #dbeafe; color: #1e40af; }
      .badge-not-converted { background: #fee2e2; color: #991b1b; }
      .top-patients-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
      .top-patient-card { background: #f8f9fa; border-radius: 8px; padding: 15px; border-left: 4px solid #ff6b6b; }
      .refresh-btn { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-bottom: 20px; }
      .refresh-btn:hover { background: #5a67d8; }
      .last-updated { color: white; margin-bottom: 20px; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  </head>
  <body>
    <div class="container">
      <h1>🚀 Executive Dashboard</h1>
      
      <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
      <div class="last-updated">Last updated: ${new Date().toLocaleTimeString()}</div>
      
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-title">Total Patients</div><div class="stat-value">${totalPatients}</div></div>
        <div class="stat-card"><div class="stat-title">Pending</div><div class="stat-value">${pendingCount}</div></div>
        <div class="stat-card"><div class="stat-title">Converted</div><div class="stat-value">${convertedCount}</div></div>
        <div class="stat-card"><div class="stat-title">Waiting</div><div class="stat-value">${waitingCount}</div></div>
        <div class="stat-card"><div class="stat-title">Not Converted</div><div class="stat-value">${notConvertedCount}</div></div>
        <div class="stat-card misscall-card"><div class="stat-title">Total Miss Calls</div><div class="stat-value">${missCallTotal}</div></div>
        <div class="stat-card misscall-card"><div class="stat-title">Today's Miss Calls</div><div class="stat-value">${missCallToday}</div></div>
      </div>
      
      <h2>📊 Stage Tracking</h2>
      <div class="stage-grid">
        <div class="stage-card awaiting_branch"><div class="stage-name">Awaiting Branch</div><div class="stage-value">${stageStats.awaiting_branch || 0}</div></div>
        <div class="stage-card branch_selected"><div class="stage-name">Branch Selected</div><div class="stage-value">${stageStats.branch_selected || 0}</div></div>
        <div class="stage-card executive_notified"><div class="stage-name">Executive Notified</div><div class="stage-value">${stageStats.executive_notified || 0}</div></div>
        <div class="stage-card converted"><div class="stage-name">Converted</div><div class="stage-value">${stageStats.converted || 0}</div></div>
        <div class="stage-card waiting"><div class="stage-name">Waiting</div><div class="stage-value">${stageStats.waiting || 0}</div></div>
        <div class="stage-card not_converted"><div class="stage-name">Not Converted</div><div class="stage-value">${stageStats.not_converted || 0}</div></div>
      </div>
      
      <h2>📞 Top Miss Call Patients</h2>
      <div class="top-patients-grid">
        ${topMissCallPatients.map(p => `
          <div class="top-patient-card">
            <div style="font-weight: bold;">${p.patientName || 'Unknown'}</div>
            <div style="color: #666; font-size: 0.9em;">${p.patientPhone}</div>
            <div style="color: #ff6b6b; font-weight: bold; margin-top: 5px;">${p.missCallCount || 1} calls</div>
          </div>
        `).join('')}
      </div>
      
      <h2>🕒 Recent Patients</h2>
      <div class="recent-section">
        <table>
          <thead>
            <tr>
              <th>Patient</th>
              <th>Phone</th>
              <th>Branch</th>
              <th>Tests</th>
              <th>Stage</th>
              <th>Miss Calls</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${recentPatients.map(p => `
              <tr>
                <td>${p.patientName || 'N/A'}</td>
                <td>${p.patientPhone || 'N/A'}</td>
                <td>${p.branch || 'N/A'}</td>
                <td>${p.testNames || p.tests || 'N/A'}</td>
                <td><span class="badge badge-${p.currentStage || 'pending'}">${(p.currentStage || 'pending').replace(/_/g, ' ')}</span></td>
                <td>${p.missCallCount || 1}</td>
                <td>${new Date(p.createdAt).toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      
      <h2>📞 Recent Miss Calls</h2>
      <div class="recent-section">
        <table>
          <thead>
            <tr>
              <th>Phone</th>
              <th>Branch</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${recentMissCalls.map(m => `
              <tr>
                <td>${m.phoneNumber || 'N/A'}</td>
                <td>${m.branch || 'N/A'}</td>
                <td>${new Date(m.createdAt).toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </body>
  </html>
  `;
}

module.exports = router;
