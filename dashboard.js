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

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: white;
            border-radius: 15px;
            padding: 25px;
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

        .misscall-card {
            background: linear-gradient(135deg, #ff6b6b 0%, #ff8e8e 100%);
            color: white;
        }

        .misscall-card .stat-title,
        .misscall-card .stat-value {
            color: white;
        }

        .stage-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }

        .stage-card {
            background: white;
            border-radius: 10px;
            padding: 20px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            border-left: 4px solid;
        }

        .stage-card.awaiting_branch { border-color: #f59e0b; }
        .stage-card.branch_selected { border-color: #3b82f6; }
        .stage-card.executive_notified { border-color: #8b5cf6; }
        .stage-card.converted { border-color: #10b981; }

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
        }

        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }

        th {
            background: #f8f9fa;
            font-weight: 600;
        }

        tr:hover {
            background: #f5f5f5;
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

        .refresh-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            margin-bottom: 20px;
        }

        .refresh-btn:hover {
            background: #5a67d8;
        }

        .last-updated {
            color: #666;
            font-size: 0.9em;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Executive Dashboard</h1>
        
        <button class="refresh-btn" onclick="refreshData()">🔄 Refresh Data</button>
        <div class="last-updated" id="lastUpdated"></div>

        <div class="stats-grid" id="stats"></div>

        <div class="stage-grid" id="stages"></div>

        <div class="charts-grid">
            <div class="chart-card">
                <canvas id="stageChart"></canvas>
            </div>
            <div class="chart-card">
                <canvas id="branchChart"></canvas>
            </div>
        </div>

        <div class="recent-section">
            <h2>🕒 Recent Patients</h2>
            <table id="patientsTable">
                <thead>
                    <tr>
                        <th>Patient</th>
                        <th>Phone</th>
                        <th>Branch</th>
                        <th>Stage</th>
                        <th>Status</th>
                        <th>Miss Calls</th>
                        <th>Time</th>
                    </tr>
                </thead>
                <tbody id="patientsBody"></tbody>
            </table>
        </div>

        <div class="recent-section">
            <h2>📞 Recent Miss Calls</h2>
            <table id="missCallsTable">
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

        async function refreshData() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();
                
                document.getElementById('lastUpdated').innerHTML = `Last updated: ${new Date().toLocaleString()}`;
                
                updateStats(data);
                updateStages(data.stageStats);
                updateTables(data);
                updateCharts(data);
            } catch (error) {
                console.error('Error fetching data:', error);
            }
        }

        function updateStats(data) {
            const statsHtml = `
                <div class="stat-card">
                    <div class="stat-title">Total Patients</div>
                    <div class="stat-value">${data.totalPatients || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-title">Pending</div>
                    <div class="stat-value">${data.pendingCount || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-title">Converted</div>
                    <div class="stat-value">${data.convertedCount || 0}</div>
                </div>
                <div class="stat-card misscall-card">
                    <div class="stat-title">Total Miss Calls</div>
                    <div class="stat-value">${data.missCallTotal || 0}</div>
                </div>
                <div class="stat-card misscall-card">
                    <div class="stat-title">Today's Miss Calls</div>
                    <div class="stat-value">${data.missCallToday || 0}</div>
                </div>
            `;
            document.getElementById('stats').innerHTML = statsHtml;
        }

        function updateStages(stageStats) {
            const stages = [
                { key: 'awaiting_branch', label: 'Awaiting Branch', color: '#f59e0b' },
                { key: 'branch_selected', label: 'Branch Selected', color: '#3b82f6' },
                { key: 'executive_notified', label: 'Executive Notified', color: '#8b5cf6' },
                { key: 'converted', label: 'Converted', color: '#10b981' },
                { key: 'waiting', label: 'Waiting', color: '#f59e0b' },
                { key: 'not_converted', label: 'Not Converted', color: '#ef4444' }
            ];
            
            const stagesHtml = stages.map(s => `
                <div class="stage-card ${s.key}">
                    <div class="stage-name">${s.label}</div>
                    <div class="stage-value">${stageStats[s.key] || 0}</div>
                </div>
            `).join('');
            
            document.getElementById('stages').innerHTML = stagesHtml;
        }

        function updateTables(data) {
            // Patients table
            const patientsHtml = data.recentPatients.map(p => `
                <tr>
                    <td>${p.patientName || 'N/A'}</td>
                    <td>${p.patientPhone || 'N/A'}</td>
                    <td>${p.branch || 'N/A'}</td>
                    <td><span class="badge badge-${p.currentStage || 'pending'}">${p.currentStage || 'pending'}</span></td>
                    <td><span class="badge badge-${p.status || 'pending'}">${p.status || 'pending'}</span></td>
                    <td>${p.missCallCount || 1}</td>
                    <td>${new Date(p.createdAt).toLocaleString()}</td>
                </tr>
            `).join('');
            document.getElementById('patientsBody').innerHTML = patientsHtml;

            // Miss calls table
            const missCallsHtml = data.recentMissCalls.map(m => `
                <tr>
                    <td>${m.phoneNumber || 'N/A'}</td>
                    <td>${m.branch || 'N/A'}</td>
                    <td>${new Date(m.createdAt).toLocaleString()}</td>
                </tr>
            `).join('');
            document.getElementById('missCallsBody').innerHTML = missCallsHtml;
        }

        function updateCharts(data) {
            // Destroy existing charts
            if (stageChart) stageChart.destroy();
            if (branchChart) branchChart.destroy();

            // Stage chart
            const stageCtx = document.getElementById('stageChart').getContext('2d');
            stageChart = new Chart(stageCtx,
