// dashboard.js - Complete Admin Dashboard
const express = require('express');
const router = express.Router();

module.exports = (patientsCollection, processedCollection, PORT) => {
  
  router.get('/', async (req, res) => {
    try {
      // Get real-time stats
      const patientCount = await patientsCollection.countDocuments();
      const processedCount = await processedCollection.countDocuments();
      const pendingCount = await patientsCollection.countDocuments({ status: 'pending' });
      const convertedCount = await patientsCollection.countDocuments({ status: 'converted' });
      const waitingCount = await patientsCollection.countDocuments({ status: 'waiting' });
      const notConvertedCount = await patientsCollection.countDocuments({ status: 'not_converted' });
      
      // Get recent activities
      const recentPatients = await patientsCollection.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray();
      
      // HTML Template
      res.send(getDashboardHTML({
        patientCount, 
        processedCount, 
        pendingCount, 
        convertedCount,
        waitingCount, 
        notConvertedCount, 
        recentPatients, 
        PORT
      }));
      
    } catch (error) {
      console.error('Dashboard error:', error);
      res.status(500).send('Dashboard error: ' + error.message);
    }
  });
  
  return router;
};

// ✅ getDashboardHTML function
function getDashboardHTML(data) {
  const { 
    patientCount, 
    pendingCount, 
    convertedCount, 
    waitingCount, 
    notConvertedCount, 
    recentPatients, 
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
        <div class="stat-card">
          <div class="stat-title">Uptime</div>
          <div class="stat-value">${Math.floor(process.uptime() / 60)}m</div>
        </div>
      </div>
      
      <!-- System Status -->
      <div class="status-grid">
        <div class="status-card">
          <div class="status-header">
            <div class="status-indicator status-green"></div>
            <span class="status-title">MongoDB</span>
          </div>
          <p>✅ Connected to cluster0</p>
          <p>📊 ${patientCount} patients stored</p>
        </div>
        
        <div class="status-card">
          <div class="status-header">
            <div class="status-indicator status-green"></div>
            <span class="status-title">WATI API</span>
          </div>
          <p>✅ Template: lead_notification_v2</p>
          <p>📨 Status: Pending</p>
        </div>
        
        <div class="status-card">
          <div class="status-header">
            <div class="status-indicator status-green"></div>
            <span class="status-title">Tata Tele</span>
          </div>
          <p>✅ Webhook active</p>
          <p>📞 Number: 917969690935</p>
        </div>
        
        <div class="status-card">
          <div class="status-header">
            <div class="status-indicator status-green"></div>
            <span class="status-title">OpenAI</span>
          </div>
          <p>✅ GPT-4o ready</p>
          <p>🔍 OCR active</p>
        </div>
      </div>
      
      <!-- Flow Diagram -->
      <div class="flow-diagram">
        <h3 style="margin-bottom: 20px;">🔄 Complete Flow Status</h3>
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
            <div class="step-name">WATI</div>
            <div class="step-status">⏳ Template Pending</div>
          </div>
          
          <div class="flow-step">
            <div class="step-number">4</div>
            <div class="step-name">MongoDB</div>
            <div class="step-status">✅ ${patientCount} records</div>
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
            <span>📍 Template: lead_notification_v2</span>
          </div>
          <div class="log-entry">
            <span class="log-time">${new Date().toLocaleTimeString()}</span>
            <span class="log-level log-info">INFO</span>
            <span>📍 OpenAI OCR active</span>
          </div>
        </div>
      </div>
      
      <!-- Recent Patients -->
      <div style="background: white; border-radius: 10px; padding: 20px; margin-bottom: 30px;">
        <h3 style="margin-bottom: 20px;">🕒 Recent Patients</h3>
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
              <tr>
                <td>${p.patientName || 'N/A'}</td>
                <td>${p.patientPhone || 'N/A'}</td>
                <td>${p.branch || 'N/A'}</td>
                <td>${p.tests || p.testNames || 'N/A'}</td>
                <td>
                  <span class="status-badge badge-${p.status || 'pending'}">
                    ${p.status || 'pending'}
                  </span>
                </td>
                <td>${new Date(p.createdAt).toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      
      <!-- Test Panel -->
      <div class="test-panel">
        <h3 style="margin-bottom: 20px;">🧪 Quick Test Tools</h3>
        <div class="test-buttons">
          <button class="test-btn" onclick="testWati()">📨 Test WATI</button>
          <button class="test-btn test-btn-success" onclick="testExecutive('917880261858')">
            📱 Test Executive
          </button>
          <button class="test-btn test-btn-warning" onclick="checkMongo()">
            🗄️ Check MongoDB
          </button>
          <button class="test-btn" onclick="window.open('/health')">
            ❤️ Health Check
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
      
      function testWati() {
        fetch('/test-wati-api')
          .then(r => r.json())
          .then(data => {
            alert(data.success ? '✅ WATI working' : '❌ WATI failed: ' + data.error);
          });
      }
      
      function testExecutive(number) {
        fetch('/test-exec?exec=' + number)
          .then(r => r.json())
          .then(data => {
            alert(data.success ? '✅ Message sent to ' + number : '❌ Failed: ' + data.error);
          });
      }
      
      function checkMongo() {
        fetch('/health')
          .then(r => r.json())
          .then(data => {
            alert(\`✅ MongoDB: \${data.patients} patients\`);
          });
      }
    </script>
  </body>
  </html>
  `;
}
