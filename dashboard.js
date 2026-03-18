// dashboard.js - Complete Admin Dashboard with Stage Tracking
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
    
    // Get real-time stats
    const patientCount = await patientsCollection.countDocuments();
    const pendingCount = await patientsCollection.countDocuments({ status: 'pending' });
    const convertedCount = await patientsCollection.countDocuments({ status: 'converted' });
    const waitingCount = await patientsCollection.countDocuments({ status: 'waiting' });
    const notConvertedCount = await patientsCollection.countDocuments({ status: 'not_converted' });
    
    // Get stage wise stats
    const stageStats = {};
    for (const [key, value] of Object.entries(STAGES)) {
      stageStats[key] = await patientsCollection.countDocuments({ currentStage: value }) || 0;
    }
    
    // Get miss call stats
    const missCallCount = missCallsCollection ? await missCallsCollection.countDocuments() : 0;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMissCalls = missCallsCollection ? await missCallsCollection.countDocuments({
      createdAt: { $gte: today }
    }) : 0;
    
    // Get recent patients
    const recentPatients = await patientsCollection.find()
      .sort({ createdAt: -1 })
      .limit(15)
      .toArray();
    
    // Get recent miss calls
    const recentMissCalls = missCallsCollection ? await missCallsCollection.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray() : [];
    
    // HTML Template
    res.send(getDashboardHTML({
      patientCount, 
      pendingCount, 
      convertedCount,
      waitingCount, 
      notConvertedCount,
      missCallCount,
      todayMissCalls,
      stageStats,
      STAGES,
      recentPatients, 
      recentMissCalls,
      PORT
    }));
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send(`<h2>❌ Dashboard Error: ${error.message}</h2>`);
  }
});

function getDashboardHTML(data) {
  const { 
    patientCount, 
    pendingCount, 
    convertedCount,
    waitingCount, 
    notConvertedCount,
    missCallCount,
    todayMissCalls,
    stageStats,
    STAGES,
    recentPatients, 
    recentMissCalls,
    PORT 
  } = data;
  
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Executive Dashboard</title>
    <meta http-equiv="refresh" content="10">
    <style>
      body { font-family: Arial; padding: 20px; background: #f5f5f5; }
      .container { max-width: 1200px; margin: 0 auto; }
      h1 { color: #333; }
      .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
      .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
      .stat-title { font-size: 14px; color: #666; }
      .stat-value { font-size: 32px; font-weight: bold; color: #333; }
      .stage-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 20px 0; }
      .stage-card { background: white; padding: 15px; border-radius: 8px; border-left: 4px solid; }
      .stage-name { font-size: 12px; color: #666; }
      .stage-value { font-size: 24px; font-weight: bold; }
      table { width: 100%; background: white; border-collapse: collapse; margin: 20px 0; }
      th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
      th { background: #f8f9fa; }
      .misscall-row { background: #fff3e0; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>🚀 Executive Dashboard</h1>
      
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-title">Total Patients</div>
          <div class="stat-value">${patientCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Pending</div>
          <div class="stat-value">${pendingCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Converted</div>
          <div class="stat-value">${convertedCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Miss Calls</div>
          <div class="stat-value">${missCallCount}</div>
        </div>
      </div>
      
      <h2>📊 Stage Tracking</h2>
      <div class="stage-grid">
        ${Object.entries(stageStats).map(([stage, count]) => `
          <div class="stage-card">
            <div class="stage-name">${stage.replace(/_/g, ' ')}</div>
            <div class="stage-value">${count}</div>
          </div>
        `).join('')}
      </div>
      
      <h2>🕒 Recent Patients</h2>
      <table>
        <thead>
          <tr>
            <th>Patient</th>
            <th>Phone</th>
            <th>Branch</th>
            <th>Stage</th>
            <th>Status</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${recentPatients.map(p => `
            <tr>
              <td>${p.patientName || 'N/A'}</td>
              <td>${p.patientPhone || 'N/A'}</td>
              <td>${p.branch || 'N/A'}</td>
              <td>${p.currentStage || 'pending'}</td>
              <td>${p.status || 'pending'}</td>
              <td>${new Date(p.createdAt).toLocaleString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      
      <h2>📞 Recent Miss Calls</h2>
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
            <tr class="misscall-row">
              <td>${m.phoneNumber || 'N/A'}</td>
              <td>${m.branch || 'N/A'}</td>
              <td>${new Date(m.createdAt).toLocaleString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </body>
  </html>
  `;
}

module.exports = router;
