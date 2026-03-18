// dashboard.js - Complete Admin Dashboard with Stage Tracking
const express = require('express');
const router = express.Router();

// Dashboard route
router.get('/', async (req, res) => {
  try {
    // Get collections from request (set in middleware)
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
    const processedCount = await processedCollection.countDocuments();
    const pendingCount = await patientsCollection.countDocuments({ status: 'pending' });
    const convertedCount = await patientsCollection.countDocuments({ status: 'converted' });
    const waitingCount = await patientsCollection.countDocuments({ status: 'waiting' });
    const notConvertedCount = await patientsCollection.countDocuments({ status: 'not_converted' });
    
    // Get stage wise stats
    const stageStats = {};
    for (const [key, value] of Object.entries(STAGES)) {
      stageStats[key] = await patientsCollection.countDocuments({ currentStage: value }) || 0;
    }
    
    // Get miss call specific stats
    const missCallCount = missCallsCollection ? await missCallsCollection.countDocuments() : 0;
    
    // Get today's miss calls
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMissCalls = missCallsCollection ? await missCallsCollection.countDocuments({
      createdAt: { $gte: today }
    }) : 0;
    
    // Get miss calls by branch
    const missCallsByBranch = missCallsCollection ? await missCallsCollection.aggregate([
      { $group: { _id: '$branch', count: { $sum: 1 } } }
    ]).toArray() : [];
    
    const branchMissCallMap = {};
    missCallsByBranch.forEach(b => { branchMissCallMap[b._id] = b.count; });
    
    // Get recent patients with stage info
    const recentPatients = await patientsCollection.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    
    // Get recent miss calls
    const recentMissCalls = missCallsCollection ? await missCallsCollection.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray() : [];
    
    // Get patients with most miss calls
    const topMissCallPatients = await patientsCollection.find()
      .sort({ missCallCount: -1 })
      .limit(5)
      .toArray();
    
    // HTML Template - Better UI
    res.send(getDashboardHTML({
      patientCount, 
      processedCount, 
      pendingCount, 
      convertedCount,
      waitingCount, 
      notConvertedCount,
      missCallCount,
      todayMissCalls,
      branchMissCallMap,
      stageStats,
      STAGES,
      recentPatients, 
      recentMissCalls,
      topMissCallPatients,
      PORT
    }));
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send(`
      <html>
        <head><title>Dashboard Error</title></head>
        <body style="font-family: Arial; padding: 30px; background: #f5f5f5;">
          <div style="max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px;">
            <h2 style="color: #dc3545;">❌ Dashboard Error</h2>
            <p>${error.message}</p>
            <button onclick="location.reload()" style="background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">Refresh Page</button>
          </div>
        </body>
      </html>
    `);
  }
});

// ✅ getDashboardHTML function - Better UI
function getDashboardHTML(data) {
  const { 
    patientCount, 
    pendingCount, 
    convertedCount, 
    waitingCount, 
    notConvertedCount,
    missCallCount,
    todayMissCalls,
    branchMissCallMap,
    stageStats,
    STAGES,
    recentPatients, 
    recentMissCalls,
    topMissCallPatients,
    PORT 
  } = data;
  
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Executive Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      
      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        min-height: 100vh;
        padding: 20px;
      }
      
      .container {
        max-width: 1400px;
        margin: 0 auto;
      }
      
      h1 {
        color: white;
        margin-bottom: 30px;
        font-size: 2.5em;
        text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
      }
      
      h2 {
        color: white;
        margin: 30px 0 15px 0;
        font-size: 1.8em;
      }
      
      h3 {
        color: #333;
        margin-bottom: 20px;
      }
      
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }
      
      .stat-card {
        background: white;
        border-radius: 10px;
        padding: 20px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        transition: transform 0.3s;
      }
      
      .stat-card:hover {
        transform: translateY(-5px);
      }
      
      .stat-title {
        font-size: 0.9em;
        color: #666;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
      
      .stat-value {
        font-size: 2.5em;
        font-weight: bold;
        color: #333;
        margin-top: 10px;
      }
      
      .misscall-highlight {
        background: linear-gradient(135deg, #ff6b6b 0%, #ff8e8e 100%);
      }
      
      .misscall-highlight .stat-title,
      .misscall-highlight .stat-value {
        color: white;
      }
      
      .stage-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 15px;
        margin-bottom: 30px;
      }
      
      .stage-card {
        background: white;
        border-radius: 8px;
        padding: 15px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        border-left: 4px solid;
      }
      
      .stage-card.awaiting_branch { border-color: #f59e0b; }
      .stage-card.branch_selected { border-color: #3b82f6; }
      .stage-card.executive_notified { border-color: #8b5cf6; }
      .stage-card.converted { border-color: #10b981; }
      .stage-card.waiting { border-color: #f59e0b; }
      .stage-card.not_converted { border-color: #ef4444; }
      .stage-card.escalated { border-color: #dc3545; }
      
      .stage-name {
        font-size: 0.8em;
        color: #666;
        text-transform: uppercase;
      }
      
      .stage-value {
        font-size: 1.8em;
        font-weight: bold;
        margin-top: 5px;
      }
      
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }
      
      .chart-card {
        background: white;
        border-radius: 10px;
        padding: 20px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
      }
      
      .recent-section {
        background: white;
        border-radius: 10px;
        padding: 20px;
        margin-bottom: 30px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
      }
      
      table {
        width: 100%;
        border-collapse: collapse;
        background: white;
        border-radius: 10px;
        overflow: hidden;
      }
      
      th {
        background: #f8f9fa;
        padding: 12px;
        text-align: left;
        font-weight: 600;
        color: #333;
      }
      
      td {
        padding: 12px;
        border-bottom: 1px solid #e2e8f0;
      }
      
      tr:hover {
        background: #f8f9fa;
      }
      
      .misscall-row {
        background: #fff3e0;
      }
      
      .badge {
        padding: 4px 8px;
        border-radius: 12px;
        font-size: 0.8em;
        font-weight: 600;
      }
      
      .badge-pending { background: #fef3c7; color: #92400e; }
      .badge-converted { background: #d1fae5; color: #065f46; }
      .badge-waiting { background: #dbeafe; color: #1e40af; }
      .badge-not-converted { background: #fee2e2; color: #991b1b; }
      .badge-awaiting_branch { background: #fef3c7; color: #92400e; }
      .badge-branch_selected { background: #dbeafe; color: #1e40af; }
      .badge-executive_notified { background: #ede9fe; color: #5b21b6; }
      
      .refresh-btn {
        background: #667eea;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 5px;
        cursor: pointer;
        margin-bottom: 20px;
        font-size: 1em;
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      
      .refresh-btn:hover {
        background: #5a67d8;
      }
      
      .last-updated {
        color: white;
        margin-bottom: 20px;
        font-size: 0.9em;
      }
      
      .top-patients-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 15px;
        margin-bottom: 20px;
      }
      
      .top-patient-card {
        background: #f8f9fa;
        border-radius: 8px;
        padding: 15px;
        border-left: 4px solid #ff6b6b;
      }
      
      .top-patient-name {
        font-weight: bold;
        font-size: 1.1em;
        margin-bottom: 5px;
      }
      
      .top-patient-phone {
        color: #666;
        font-size: 0.9em;
        margin-bottom: 5px;
      }
      
      .top-patient-miss {
        color: #ff6b6b;
        font-weight: bold;
        font-size: 1.2em;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>🚀 Executive Dashboard</h1>
      
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <button class="refresh-btn" onclick="refreshData()">
          🔄 Refresh Data
        </button>
        <div class="last-updated" id="lastUpdated"></div>
      </div>
      
      <!-- Statistics Cards -->
      <div class="stats-grid" id="stats"></div>
      
      <!-- Stage Wise Tracking -->
      <h2>📊 Stage Tracking</h2>
      <div class="stage-grid" id="stages"></div>
      
      <!-- Charts -->
      <div class="charts-grid">
        <div class="chart-card">
          <canvas id="stageChart"></canvas>
        </div>
        <div class="chart-card">
          <canvas id="branchChart"></canvas>
        </div>
      </div>
      
      <!-- Top Miss Call Patients -->
      <h2>📞 Top Miss Call Patients</h2>
      <div class="top-patients-grid" id="topPatients"></div>
      
      <!-- Recent Patients -->
      <h2>🕒 Recent Patients</h2>
      <div class="recent-section">
        <table id="patientsTable">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Phone</th>
              <th>Branch</th>
              <th>Tests</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Miss Calls</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody id="patientsBody"></tbody>
        </table>
      </div>
      
      <!-- Recent Miss Calls -->
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
          <tbody id="missCallsBody"></tbody>
        </table>
      </div>
    </div>
    
    <script>
      let stageChart, branchChart;
      
      // Initial load
      document.addEventListener('DOMContentLoaded', function() {
        refreshData();
        setInterval(refreshData, 10000); // Refresh every 10 seconds
      });
      
      async function refreshData() {
        try {
          const response = await fetch('/api/stats');
          if (!response.ok) throw new Error('Network response was not ok');
          const data = await response.json();
          
          document.getElementById('lastUpdated').innerHTML = 'Last updated: ' + new Date().toLocaleTimeString();
          
          updateStats(data);
          updateStages(data.stageStats);
          updateTables(data);
          updateTopPatients(data.topMissCallPatients);
          updateCharts(data);
        } catch (error) {
          console.error('Error fetching data:', error);
          document.getElementById('lastUpdated').innerHTML = 'Error loading data: ' + error.message;
        }
      }
      
      function updateStats(data) {
        const statsHtml = \`
          <div class="stat-card">
            <div class="stat-title">Total Patients</div>
            <div class="stat-value">\${data.totalPatients || 0}</div>
          </div>
          <div class="stat-card">
            <div class="stat-title">Pending</div>
            <div class="stat-value">\${data.pendingCount || 0}</div>
          </div>
          <div class="stat-card">
            <div class="stat-title">Converted</div>
            <div class="stat-value">\${data.convertedCount || 0}</div>
          </div>
          <div class="stat-card">
            <div class="stat-title">Waiting</div>
            <div class="stat-value">\${data.waitingCount || 0}</div>
          </div>
          <div class="stat-card">
            <div class="stat-title">Not Converted</div>
            <div class="stat-value">\${data.notConvertedCount || 0}</div>
          </div>
          <div class="stat-card misscall-highlight">
            <div class="stat-title">📞 Total Miss Calls</div>
            <div class="stat-value">\${data.missCallTotal || 0}</div>
          </div>
          <div class="stat-card misscall-highlight">
            <div class="stat-title">📞 Today's Miss Calls</div>
            <div class="stat-value">\${data.missCallToday || 0}</div>
          </div>
          <div class="stat-card">
            <div class="stat-title">Uptime</div>
            <div class="stat-value">\${Math.floor((data.uptime || 0) / 60)}m</div>
          </div>
        \`;
        document.getElementById('stats').innerHTML = statsHtml;
      }
      
      function updateStages(stageStats) {
        const stages = [
          { key: 'awaiting_branch', label: 'Awaiting Branch' },
          { key: 'branch_selected', label: 'Branch Selected' },
          { key: 'executive_notified', label: 'Executive Notified' },
          { key: 'converted', label: 'Converted' },
          { key: 'waiting', label: 'Waiting' },
          { key: 'not_converted', label: 'Not Converted' },
          { key: 'escalated', label: 'Escalated' }
        ];
        
        const stagesHtml = stages.map(s => {
          const count = stageStats[s.key] || 0;
          return \`
            <div class="stage-card \${s.key}">
              <div class="stage-name">\${s.label}</div>
              <div class="stage-value">\${count}</div>
            </div>
          \`;
        }).join('');
        
        document.getElementById('stages').innerHTML = stagesHtml;
      }
      
      function updateTables(data) {
        // Patients table
        const patientsHtml = (data.recentPatients || []).map(p => {
          const stageClass = p.currentStage || 'pending';
          const statusClass = p.status || 'pending';
          return \`
            <tr class="\${p.sourceType === 'Miss Call' ? 'misscall-row' : ''}">
              <td>\${p.patientName || 'N/A'}</td>
              <td>\${p.patientPhone || 'N/A'}</td>
              <td>\${p.branch || 'N/A'}</td>
              <td>\${p.testNames || p.tests || 'N/A'}</td>
              <td><span class="badge badge-\${stageClass}">\${(p.currentStage || 'pending').replace(/_/g, ' ')}</span></td>
              <td><span class="badge badge-\${statusClass}">\${p.status || 'pending'}</span></td>
              <td>\${p.missCallCount || 1}</td>
              <td>\${new Date(p.createdAt).toLocaleString()}</td>
            </tr>
          \`;
        }).join('');
        document.getElementById('patientsBody').innerHTML = patientsHtml || '<tr><td colspan="8" style="text-align: center;">No patients found</td></tr>';
        
        // Miss calls table
        const missCallsHtml = (data.recentMissCalls || []).map(m => \`
          <tr class="misscall-row">
            <td>\${m.phoneNumber || 'N/A'}</td>
            <td>\${m.branch || 'N/A'}</td>
            <td>\${new Date(m.createdAt).toLocaleString()}</td>
          </tr>
        \`).join('');
        document.getElementById('missCallsBody').innerHTML = missCallsHtml || '<tr><td colspan="3" style="text-align: center;">No miss calls found</td></tr>';
      }
      
      function updateTopPatients(patients) {
        if (!patients || patients.length === 0) {
          document.getElementById('topPatients').innerHTML = '<div class="recent-section"><p>No data available</p></div>';
          return;
        }
        
        const html = patients.map(p => \`
          <div class="top-patient-card">
            <div class="top-patient-name">\${p.patientName || 'Unknown'}</div>
            <div class="top-patient-phone">\${p.patientPhone}</div>
            <div class="top-patient-miss">Miss Calls: \${p.missCallCount || 1}</div>
            <div style="margin-top: 5px; color: #666;">Branch: \${p.branch || 'N/A'}</div>
          </div>
        \`).join('');
        
        document.getElementById('topPatients').innerHTML = html;
      }
      
      function updateCharts(data) {
        // Destroy existing charts
        if (stageChart) stageChart.destroy();
        if (branchChart) branchChart.destroy();
        
        // Stage Chart
        const stageCtx = document.getElementById('stageChart').getContext('2d');
        stageChart = new Chart(stageCtx, {
          type: 'doughnut',
          data: {
            labels: ['Awaiting Branch', 'Branch Selected', 'Executive Notified', 'Converted', 'Waiting', 'Not Converted', 'Escalated'],
            datasets: [{
              data: [
                data.stageStats?.awaiting_branch || 0,
                data.stageStats?.branch_selected || 0,
                data.stageStats?.executive_notified || 0,
                data.stageStats?.converted || 0,
                data.stageStats?.waiting || 0,
                data.stageStats?.not_converted || 0,
                data.stageStats?.escalated || 0
              ],
              backgroundColor: [
                '#f59e0b',
                '#3b82f6',
                '#8b5cf6',
                '#10b981',
                '#f59e0b',
                '#ef4444',
                '#dc3545'
              ]
            }]
          },
          options: {
            responsive: true,
            plugins: {
              title: {
                display: true,
                text: 'Patient Stages Distribution'
              },
              legend: {
                position: 'bottom'
              }
            }
          }
        });
        
        // Branch Chart
        const branchLabels = Object.keys(data.branchMissCallMap || {});
        const branchValues = Object.values(data.branchMissCallMap || {});
        
        if (branchLabels.length > 0) {
          const branchCtx = document.getElementById('branchChart').getContext('2d');
          branchChart = new Chart(branchCtx, {
            type: 'bar',
            data: {
              labels: branchLabels,
              datasets: [{
                label: 'Miss Calls by Branch',
                data: branchValues,
                backgroundColor: '#667eea',
                borderRadius: 5
              }]
            },
            options: {
              responsive: true,
              plugins: {
                title: {
                  display: true,
                  text: 'Miss Calls by Branch'
                }
              },
              scales: {
                y: {
                  beginAtZero: true,
                  ticks: {
                    stepSize: 1
                  }
                }
              }
            }
          });
        } else {
          document.getElementById('branchChart').getContext('2d').clearRect(0, 0, 400, 200);
        }
      }
    </script>
  </body>
  </html>
  \`;
}

module.exports = router;
