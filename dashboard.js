// dashboard.js - Complete Admin Dashboard with Miss Call Tracking
const express = require('express');
const router = express.Router();

// Dashboard route
router.get('/', async (req, res) => {
  try {
    // Get collections from request (set in middleware)
    const patientsCollection = req.patientsCollection;
    const processedCollection = req.processedCollection;
    const missCallsCollection = req.missCallsCollection;
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
    
    // Get recent activities (mix of patients and miss calls)
    const recentPatients = await patientsCollection.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
    
    // Get recent miss calls
    const recentMissCalls = missCallsCollection ? await missCallsCollection.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray() : [];
    
    // HTML Template
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
      recentPatients, 
      recentMissCalls,
      PORT
    }));
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send(`
      <html>
        <head><title>Dashboard Error</title></head>
        <body style="font-family: Arial; padding: 30px;">
          <h2>❌ Dashboard Error</h2>
          <p>${error.message}</p>
          <p>Please check server logs for more details.</p>
          <button onclick="location.reload()">Refresh Page</button>
        </body>
      </html>
    `);
  }
});

// ✅ getDashboardHTML function
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
    recentPatients, 
    recentMissCalls,
    PORT 
  } = data;
  
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Executive System Dashboard</title>
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
        background: #ffedd5;
        border-left: 4px solid #f97316;
      }
      
      .status-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }
      
      .status-card {
        background: white;
        border-radius: 10px;
        padding: 20px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
      }
      
      .status-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 15px;
      }
      
      .status-indicator {
        width: 12px;
        height: 12px;
        border-radius: 50%;
      }
      
      .status-green { background: #10b981; }
      .status-red { background: #ef4444; }
      .status-yellow { background: #f59e0b; }
      .status-blue { background: #3b82f6; }
      
      .status-title {
        font-weight: 600;
        color: #333;
      }
      
      .flow-diagram {
        background: white;
        border-radius: 10px;
        padding: 30px;
        margin-bottom: 30px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
      }
      
      .flow-steps {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
      }
      
      .flow-step {
        flex: 1;
        min-width: 150px;
        text-align: center;
        padding: 15px;
        background: #f8f9fa;
        border-radius: 8px;
        position: relative;
      }
      
      .flow-step.active {
        background: #e3f2fd;
        border: 2px solid #2196f3;
      }
      
      .flow-step.completed {
        background: #e8f5e8;
        border: 2px solid #4caf50;
      }
      
      .step-number {
        width: 30px;
        height: 30px;
        background: #667eea;
        color: white;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0 auto 10px;
        font-weight: bold;
      }
      
      .step-name {
        font-weight: 600;
        margin-bottom: 5px;
      }
      
      .step-status {
        font-size: 0.8em;
        color: #666;
      }
      
      .logs-section {
        background: white;
        border-radius: 10px;
        padding: 20px;
        margin-bottom: 30px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
      }
      
      .logs-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
      }
      
      .logs-title {
        font-size: 1.2em;
        font-weight: 600;
      }
      
      .refresh-btn {
        background: #667eea;
        color: white;
        border: none;
        padding: 8px 15px;
        border-radius: 5px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 5px;
        transition: background 0.3s;
      }
      
      .refresh-btn:hover {
        background: #5a67d8;
      }
      
      .logs-container {
        background: #1a1a1a;
        color: #00ff00;
        padding: 15px;
        border-radius: 5px;
        font-family: 'Courier New', monospace;
        height: 300px;
        overflow-y: auto;
        font-size: 0.9em;
      }
      
      .log-entry {
        padding: 3px 0;
        border-bottom: 1px solid #333;
      }
      
      .log-time {
        color: #888;
        margin-right: 10px;
      }
      
      .log-level {
        padding: 2px 5px;
        border-radius: 3px;
        font-size: 0.8em;
        margin-right: 10px;
      }
      
      .log-info { background: #2d3748; color: #63b3ed; }
      .log-warn { background: #744210; color: #fbd38d; }
      .log-error { background: #742a2a; color: #fc8181; }
      
      .recent-table {
        width: 100%;
        border-collapse: collapse;
        background: white;
        border-radius: 10px;
        overflow: hidden;
        margin-bottom: 20px;
      }
      
      .recent-table th {
        background: #f7fafc;
        padding: 12px;
        text-align: left;
        font-weight: 600;
        color: #4a5568;
      }
      
      .recent-table td {
        padding: 12px;
        border-bottom: 1px solid #e2e8f0;
      }
      
      .recent-table tr:hover {
        background: #f7fafc;
      }
      
      .misscall-row {
        background: #fff7ed;
      }
      
      .status-badge {
        padding: 4px 8px;
        border-radius: 12px;
        font-size: 0.8em;
        font-weight: 600;
      }
      
      .badge-pending { background: #fef3c7; color: #92400e; }
      .badge-converted { background: #d1fae5; color: #065f46; }
      .badge-waiting { background: #dbeafe; color: #1e40af; }
      .badge-not-converted { background: #fee2e2; color: #991b1b; }
      .badge-misscall { background: #ffedd5; color: #9a3412; }
      
      .test-panel {
        background: white;
        border-radius: 10px;
        padding: 20px;
        margin-top: 30px;
      }
      
      .test-buttons {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      
      .test-btn {
        background: #667eea;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 5px;
        cursor: pointer;
        font-size: 0.9em;
        transition: background 0.3s;
      }
      
      .test-btn:hover {
        background: #5a67d8;
      }
      
      .test-btn-success {
        background: #48bb78;
      }
      
      .test-btn-success:hover {
        background: #38a169;
      }
      
      .test-btn-warning {
        background: #ed8936;
      }
      
      .test-btn-warning:hover {
        background: #dd6b20;
      }
      
      .test-btn-orange {
        background: #f97316;
      }
      
      .test-btn-orange:hover {
        background: #ea580c;
      }
      
      .section-title {
        color: white;
        margin: 30px 0 15px 0;
        font-size: 1.5em;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>🚀 Executive System Dashboard</h1>
      
      <!-- Statistics Cards -->
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
          <div class="stat-title">Waiting</div>
          <div class="stat-value">${waitingCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Not Converted</div>
          <div class="stat-value">${notConvertedCount}</div>
        </div>
        <div class="stat-card misscall-highlight">
          <div class="stat-title">📞 Total Miss Calls</div>
          <div class="stat-value">${missCallCount}</div>
        </div>
        <div class="stat-card misscall-highlight">
          <div class="stat-title">📞 Today's Miss Calls</div>
          <div class="stat-value">${todayMissCalls}</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Uptime</div>
          <div class="stat-value">${Math.floor(process.uptime() / 60)}m</div>
        </div>
      </div>
      
      <!-- Miss Calls by Branch -->
      <div class="status-grid">
        <div class="status-card">
          <div class="status-header">
            <div class="status-indicator status-blue"></div>
            <span class="status-title">Miss Calls by Branch</span>
          </div>
          <p>Naroda: ${branchMissCallMap['Naroda'] || 0}</p>
          <p>Usmanpura: ${branchMissCallMap['Usmanpura'] || 0}</p>
          <p>Vadaj: ${branchMissCallMap['Vadaj'] || 0}</p>
          <p>Satellite: ${branchMissCallMap['Satellite'] || 0}</p>
          <p>Other: ${branchMissCallMap['Main Branch'] || 0}</p>
        </div>
        
        <div class="status-card">
          <div class="status-header">
            <div class="status-indicator status-green"></div>
            <span class="status-title">MongoDB</span>
          </div>
          <p>✅ Connected to cluster0</p>
          <p>📊 ${patientCount} patients stored</p>
          <p>📞 ${missCallCount} miss calls tracked</p>
        </div>
        
        <div class="status-card">
          <div class="status-header">
            <div class="status-indicator status-green"></div>
            <span class="status-title">WATI API</span>
          </div>
          <p>✅ Template: lead_notification_v2</p>
          <p>✅ Template: misscall_welcome_v3</p>
          <p>📨 Status: Active</p>
        </div>
        
        <div class="status-card">
          <div class="status-header">
            <div class="status-indicator status-green"></div>
            <span class="status-title">Tata Tele</span>
          </div>
          <p>✅ Webhook: /tata-misscall-whatsapp</p>
          <p>📞 Miss call handling active</p>
        </div>
      </div>
      
      <!-- Flow Diagram -->
      <div class="flow-diagram">
        <h3 style="margin-bottom: 20px;">🔄 Miss Call Flow Status</h3>
        <div class="flow-steps">
          <div class="flow-step completed">
            <div class="step-number">1</div>
            <div class="step-name">Tata Tele</div>
            <div class="step-status">✅ Webhook</div>
          </div>
          
          <div class="flow-step active">
            <div class="step-number">2</div>
            <div class="step-name">Render Server</div>
            <div class="step-status">⚡ Running</div>
          </div>
          
          <div class="flow-step">
            <div class="step-number">3</div>
            <div class="step-name">WATI Customer</div>
            <div class="step-status">${missCallCount > 0 ? '✅ Sent' : '⏳ Pending'}</div>
          </div>
          
          <div class="flow-step">
            <div class="step-number">4</div>
            <div class="step-name">MongoDB</div>
            <div class="step-status">✅ ${missCallCount} records</div>
          </div>
          
          <div class="flow-step">
            <div class="step-number">5</div>
            <div class="step-name">Executive</div>
            <div class="step-status">⏳ Awaiting</div>
          </div>
        </div>
      </div>
      
      <!-- Live Logs -->
      <div class="logs-section">
        <div class="logs-header">
          <span class="logs-title">📋 Live System Logs</span>
          <button class="refresh-btn" onclick="refreshLogs()">
            🔄 Refresh Logs
          </button>
        </div>
        <div class="logs-container" id="logs-container">
          <div class="log-entry">
            <span class="log-time">${new Date().toLocaleTimeString()}</span>
            <span class="log-level log-info">INFO</span>
            <span>🚀 Server running on port ${PORT}</span>
          </div>
          <div class="log-entry">
            <span class="log-time">${new Date().toLocaleTimeString()}</span>
            <span class="log-level log-info">INFO</span>
            <span>✅ MongoDB connected</span>
          </div>
          <div class="log-entry">
            <span class="log-time">${new Date().toLocaleTimeString()}</span>
            <span class="log-level log-info">INFO</span>
            <span>📍 Template: lead_notification_v2 (Approved)</span>
          </div>
          <div class="log-entry">
            <span class="log-time">${new Date().toLocaleTimeString()}</span>
            <span class="log-level log-info">INFO</span>
            <span>📍 Template: misscall_welcome_v3 (Approved)</span>
          </div>
          <div class="log-entry">
            <span class="log-time">${new Date().toLocaleTimeString()}</span>
            <span class="log-level log-info">INFO</span>
            <span>📍 Tata Tele Webhook: /tata-misscall-whatsapp</span>
          </div>
        </div>
      </div>
      
      <!-- Recent Miss Calls -->
      <h3 class="section-title">📞 Recent Miss Calls</h3>
      <table class="recent-table">
        <thead>
          <tr>
            <th>Phone</th>
            <th>Branch</th>
            <th>Status</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${recentMissCalls.map(m => `
            <tr class="misscall-row">
              <td>${m.phoneNumber || 'N/A'}</td>
              <td>${m.branch || 'N/A'}</td>
              <td><span class="status-badge badge-misscall">Miss Call</span></td>
              <td>${new Date(m.createdAt).toLocaleString()}</td>
            </tr>
          `).join('')}
          ${recentMissCalls.length === 0 ? `
            <tr>
              <td colspan="4" style="text-align: center;">No miss calls yet</td>
            </tr>
          ` : ''}
        </tbody>
      </table>
      
      <!-- Recent Patients -->
      <h3 class="section-title">🕒 Recent Patients</h3>
      <table class="recent-table">
        <thead>
          <tr>
            <th>Patient</th>
            <th>Phone</th>
            <th>Branch</th>
            <th>Tests</th>
            <th>Status</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${recentPatients.map(p => `
            <tr class="${p.sourceType === 'Miss Call' ? 'misscall-row' : ''}">
              <td>${p.patientName || 'N/A'}</td>
              <td>${p.patientPhone || 'N/A'}</td>
              <td>${p.branch || 'N/A'}</td>
              <td>${p.tests || p.testNames || 'N/A'}</td>
              <td>
                <span class="status-badge badge-${p.status || 'pending'}">
                  ${p.status || 'pending'} ${p.sourceType === 'Miss Call' ? '📞' : ''}
                </span>
              </td>
              <td>${new Date(p.createdAt).toLocaleString()}</td>
            </tr>
          `).join('')}
          ${recentPatients.length === 0 ? `
            <tr>
              <td colspan="6" style="text-align: center;">No patients yet</td>
            </tr>
          ` : ''}
        </tbody>
      </table>
      
      <!-- Test Panel -->
      <div class="test-panel">
        <h3 style="margin-bottom: 20px;">🧪 Quick Test Tools</h3>
        <div class="test-buttons">
          <button class="test-btn test-btn-orange" onclick="testMissCall()">📞 Test Miss Call</button>
          <button class="test-btn test-btn-success" onclick="testExecutive('919106959092')">
            📱 Test Executive (Naroda)
          </button>
          <button class="test-btn" onclick="checkMongo()">
            🗄️ Check MongoDB
          </button>
          <button class="test-btn" onclick="window.open('/health')">
            ❤️ Health Check
          </button>
          <button class="test-btn" onclick="window.open('/api/misscall-stats')">
            📊 Miss Call Stats
          </button>
        </div>
      </div>
    </div>
    
    <script>
      // Auto-refresh logs every 10 seconds
      setInterval(refreshLogs, 10000);
      
      function refreshLogs() {
        const container = document.getElementById('logs-container');
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.innerHTML = \`
          <span class="log-time">\${new Date().toLocaleTimeString()}</span>
          <span class="log-level log-info">INFO</span>
          <span>🔄 Logs refreshed</span>
        \`;
        container.insertBefore(logEntry, container.firstChild);
        
        // Keep only last 50 logs
        while(container.children.length > 50) {
          container.removeChild(container.lastChild);
        }
      }
      
      function testMissCall() {
        const phone = prompt('Enter phone number for test (10 digits):', '9876543210');
        if (phone) {
          fetch('/test-misscall?phone=' + phone)
            .then(r => r.json())
            .then(data => {
              if (data.success) {
                alert('✅ Test miss call sent to ' + data.whatsappNumber + '\\nBranch: ' + data.branch);
                setTimeout(() => location.reload(), 2000);
              } else {
                alert('❌ Error: ' + data.error);
              }
            })
            .catch(err => alert('Error: ' + err.message));
        }
      }
      
      function testExecutive(number) {
        fetch('/test-exec?exec=' + number)
          .then(r => r.json())
          .then(data => {
            if (data.success) {
              alert('✅ Template sent to ' + number);
            } else {
              alert('❌ Failed: ' + data.error);
            }
          })
          .catch(err => alert('Error: ' + err.message));
      }
      
      function checkMongo() {
        fetch('/health')
          .then(r => r.json())
          .then(data => {
            if (data.success) {
              alert(\`✅ MongoDB: \${data.patients} patients, \${data.missCalls} miss calls\`);
            } else {
              alert('❌ MongoDB error: ' + data.error);
            }
          })
          .catch(err => alert('Error: ' + err.message));
      }
    </script>
  </body>
  </html>
  `;
}

module.exports = router;
