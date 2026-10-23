const appContent = document.querySelector('#app-content');
const breadcrumb = document.querySelector('#breadcrumb');
const syncLabel = document.querySelector('#sync-label');
const toast = document.querySelector('#toast');
const socket = io();

const pageNames = {
  overview: 'Overview',
  monitoring: 'Live Monitoring',
  risk: 'Risk Analysis',
  predictions: 'Trend Predictions',
  reports: 'Reports & Clinical Logs',
  care: 'Care Team & Specialists',
  hardware: 'USB Hardware Device',
  profile: 'Patient Profile',
};

let currentPage = 'overview';
let readings = [];
let reportRecords = [];
let predictionData = null;
let predictionLoading = false;
let predictionError = null;
let predictionUpdatedAt = 0;
let assistantMessages = [];
let assistantSending = false;
let assistantDraft = '';
let status = { database: 'memory', source: 'MOCKED' };
let demoPaused = false;
let serialPort = null;
let toastTimer;
let chartSequence = 0;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function localDateInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftLocalDate(date, days) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

let reportStart = localDateInput(shiftLocalDate(new Date(), -30));
let reportEnd = localDateInput(new Date());
let loadedReportRange = null;
let requestedReportRange = null;
let reportRequestId = 0;
let reportRangeCustomized = false;
let currentLocalDay = localDateInput(new Date());
const completedTasks = new Set(['Morning check-in reading']);

function formatTime(value, options = { hour: '2-digit', minute: '2-digit' }) {
  return new Date(value).toLocaleTimeString([], options);
}

function reportReadings() {
  return reportRecords;
}

function downsample(points, maximum = 320) {
  if (points.length <= maximum) return points;
  const bucketSize = points.length / maximum;
  return Array.from({ length: maximum }, (_, bucketIndex) => {
    const start = Math.floor(bucketIndex * bucketSize);
    const end = Math.floor((bucketIndex + 1) * bucketSize);
    const bucket = points.slice(start, Math.max(end, start + 1));
    const frequency_hz = bucket.reduce((total, point) => total + point.frequency_hz, 0) / bucket.length;
    const amplitude_mv = bucket.reduce((total, point) => total + point.amplitude_mv, 0) / bucket.length;
    const severity = Math.max(...bucket.map((point) => point.severity));
    return { ...bucket.at(-1), frequency_hz, amplitude_mv, severity };
  });
}

function formatDate(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return new Date(value).toLocaleDateString([], options);
}

function latestReading() {
  return readings[readings.length - 1] || { frequency_hz: 42.8, amplitude_mv: 1.24, severity: 1, recorded_at: new Date().toISOString() };
}

function severityLabel(severity) {
  return ({ 1: 'Normal', 2: 'Mild', 3: 'High risk' })[severity] || 'Unknown';
}

function severityClass(severity) {
  return ({ 1: 'normal', 2: 'mild', 3: 'high' })[severity] || 'normal';
}

function sourceBadge() {
  return status.source === 'FPGA'
    ? '<span class="mock-pill">FPGA CONNECTED</span>'
    : '<span class="mock-pill">⚡ MOCKED</span>';
}

function drawChart(points, height = 130, showBands = false) {
  const width = 800;
  const lineGradientId = `chartLine-${++chartSequence}`;
  const values = points.length ? points.map((point) => point.frequency_hz) : [42.8];
  const min = Math.min(28, ...values);
  const max = Math.max(82, ...values);
  const xStep = width / Math.max(values.length - 1, 1);
  const coordinates = values.map((value, index) => {
    const y = height - ((value - min) / (max - min)) * (height - 18) - 9;
    return [index * xStep, y];
  });
  const path = coordinates.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const fillPath = `${path} L ${width} ${height} L 0 ${height} Z`;
  const markers = coordinates.map(([x, y], index) => {
    const severity = points[index]?.severity;
    if (severity !== 2 && severity !== 3) return '';
    return `<circle class="chart-alert ${severity === 3 ? 'high' : 'mild'}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`;
  }).join('');
  const grid = [height * .22, height * .5, height * .78].map((y) =>
    `<line class="chart-grid" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`).join('');
  const bands = showBands ? `
    <rect x="0" y="${height * .58}" width="${width}" height="${height * .27}" fill="#e5f7ec" opacity=".62"/>
    <rect x="0" y="${height * .33}" width="${width}" height="${height * .25}" fill="#fff3d5" opacity=".52"/>
    <rect x="0" y="${height * .06}" width="${width}" height="${height * .27}" fill="#ffebf0" opacity=".5"/>` : '';
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Frequency history line chart">
    <defs>
      <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#a875f0" stop-opacity=".22"/><stop offset="1" stop-color="#a875f0" stop-opacity="0"/></linearGradient>
      <linearGradient id="${lineGradientId}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#27b8a4"/><stop offset=".52" stop-color="#7b62e8"/><stop offset="1" stop-color="#f07c92"/></linearGradient>
    </defs>
    ${bands}${grid}<path class="chart-area" d="${fillPath}"/><path class="chart-glow" d="${path}"/><path class="chart-line" stroke="url(#${lineGradientId})" d="${path}"/>
    ${markers}
    ${coordinates.length ? `<circle class="chart-current-halo" cx="${coordinates.at(-1)[0]}" cy="${coordinates.at(-1)[1]}" r="8"/><circle class="chart-current" cx="${coordinates.at(-1)[0]}" cy="${coordinates.at(-1)[1]}" r="4"/>` : ''}
  </svg>`;
}

function metricCard(label, value, unit, note, icon, color = '') {
  return `<article class="card metric-card ${color}">
    <span class="metric-icon">${icon}</span><div class="tiny-label">${label}</div>
    <div class="metric-value">${value}<span class="metric-unit">${unit}</span></div><div class="metric-note">${note}</div>
  </article>`;
}

function pageHeading(eyebrow, title, subtitle, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div>${action}</div>`;
}

function readingRows(limit = 8, records = readings) {
  return records.slice(-limit).reverse().map((reading) => `<tr>
    <td class="mono">${formatDate(reading.recorded_at, { month: 'short', day: 'numeric' })} · ${formatTime(reading.recorded_at)}</td>
    <td class="mono">${reading.frequency_hz.toFixed(1)} Hz</td>
    <td class="mono">${reading.amplitude_mv.toFixed(2)} mV</td>
    <td><span class="severity ${severityClass(reading.severity)}">${reading.severity} · ${severityLabel(reading.severity)}</span></td>
  </tr>`).join('');
}

function renderOverview() {
  const latest = latestReading();
  const riskClass = severityClass(latest.severity);
  const chartReadings = readings.slice(-40);
  return `<section class="welcome-card">
    <div class="welcome-copy">
      <div class="welcome-topline"><span class="tiny-label">⚑ &nbsp;MONITORING SYNCED</span>${sourceBadge()}</div>
      <div class="welcome-date" id="welcome-date">${formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
      <h1>Welcome back, Samruddhi 👋</h1>
      <p>Your device telemetry is currently synced. We’ll keep the important changes clear and easy to understand.</p>
    </div>
    <div class="risk-status ${riskClass}"><div class="risk-status-top"><span class="tiny-label">CURRENT RISK STATUS</span><span class="status-dot"></span></div>
      <strong>${severityLabel(latest.severity)} risk</strong><a class="button secondary small full" href="#risk" data-page="risk" style="margin-top:9px">Preview high-risk state ›</a></div>
  </section>
  <div class="metrics-grid">
    ${metricCard('LIVE FREQUENCY', `${latest.frequency_hz.toFixed(1)}<span class="metric-unit"> Hz</span>`, '', `Stable · updated ${formatTime(latest.recorded_at)}`, '⌁')}
    ${metricCard('SIGNAL AMPLITUDE', latest.amplitude_mv.toFixed(2), ' mV', 'Within expected range', 'ϟ', 'green')}
    ${metricCard('SIGNAL QUALITY', '96', ' %', 'Excellent connection quality', '◉', 'green')}
    ${metricCard('BATTERY LEVEL', '92', ' %', 'Approx. 8 hours remaining', '▰', 'yellow')}
  </div>
  <div class="dashboard-grid">
    <section class="card chart-card">
      <div class="card-heading"><div><h2>Frequency telemetry</h2><p>Last 40 minutes · baseline band 35–45 Hz</p></div><span class="live-badge">LIVE</span></div>
      ${drawChart(chartReadings, 130)}
      <div class="chart-labels"><span>${chartReadings.length ? formatTime(chartReadings[0].recorded_at) : '09:00'}</span><span>Now · ${latest.frequency_hz.toFixed(1)} Hz</span></div>
    </section>
    <section class="device-card">
      <div class="device-icon">⚡</div>${sourceBadge()}
      <h3 style="margin:17px 0 7px">Pulse sensor connected</h3><div class="device-meta">USB-COM3 · v2.4</div>
      <div class="device-connected"><span class="online-dot"></span>Receiving frames every 2.5 seconds</div>
      <a href="#hardware" data-page="hardware" class="button secondary small full">Manage device ↗</a>
    </section>
  </div>
  <div class="bottom-grid">
    <section class="card care-plan"><div class="card-heading"><div><h2>Your care plan</h2><p>Small steps that support a steady baseline</p></div><span class="tiny-label">▱</span></div>
      <div class="task-list">${['Morning check-in reading', 'Drink water before your afternoon scan', '10 minutes of calm movement'].map((task) =>
    `<button class="task-row ${completedTasks.has(task) ? 'done' : ''}" data-task="${task}"><span class="task-check">${completedTasks.has(task) ? '✓' : ''}</span><span>${task}</span></button>`).join('')}</div>
    </section>
    <section class="card reminder-card"><span class="reminder-icon">✦</span><div><h3>Today’s gentle reminder</h3><p>Take a few slow breaths before your next reading.<br>A relaxed body gives the clearest signal.</p></div></section>
    <section class="card doctor-spotlight">
      <div class="doctor-spotlight-top"><span class="doctor-spotlight-label">YOUR CARE TEAM</span><span class="doctor-availability"><i></i> Here for you</span></div>
      <div class="doctor-portrait" aria-hidden="true"><span class="portrait-sparkle">✦</span><span class="portrait-face">👨🏽‍⚕️</span><span class="portrait-heart">+</span></div>
      <div class="doctor-spotlight-copy"><strong>Dr. Arun Mehta</strong><span>Neurology · Your care partner</span></div>
      <div class="doctor-spotlight-actions"><button class="button secondary small" data-action="message" data-doctor="Dr. Arun Mehta">Say hello</button><a class="button small" href="#care" data-page="care">Meet the team</a></div>
    </section>
  </div>`;
}

function renderMonitoring() {
  const latest = latestReading();
  const chartReadings = readings.slice(-120);
  return `${pageHeading('LIVE TELEMETRY', 'Live Monitoring', 'A clear, live view of your frequency signal, connection quality, and the readings your care team can review.', sourceBadge())}
    <div class="content-grid">
      <section class="card monitor-chart">
        <div class="card-heading"><div><h2>Frequency signal <span class="live-badge">Streaming</span></h2><p>Signal range shown from 30 to 80 Hz</p></div><span class="tiny-label">SAMPLE ━━━━━ 250 Hz ━━━━━ 500 Hz</span></div>
        ${drawChart(chartReadings, 285, true)}
        <div class="chart-labels"><span>${chartReadings.length ? formatTime(chartReadings[0].recorded_at) : '09:00'}</span><span>${formatTime(latest.recorded_at)} · updates every 2.5 sec</span></div>
      </section>
      <aside class="reading-panel">
        <section class="card current-card"><h3>Current reading</h3>
          <div class="current-reading">${latest.frequency_hz.toFixed(1)}<span> Hz</span></div>
          <div class="range-tag">Severity ${latest.severity} · ${severityLabel(latest.severity)} range</div>
          <div class="toggle-row"><div class="toggle-copy"><strong>Simulate high-risk reading</strong><span>Preview 74.6 Hz &amp; specialist support</span></div><button class="switch" data-action="high-risk" aria-label="Simulate high-risk reading"></button></div>
        </section>
        <section class="card details-card"><h3>Signal details</h3>
          <div class="detail-row"><span>Amplitude</span><strong>${latest.amplitude_mv.toFixed(2)} mV</strong></div>
          <div class="detail-row"><span>Impedance</span><strong>4.2 kΩ</strong></div>
          <div class="detail-row"><span>Signal quality</span><strong>96%</strong></div>
        </section>
      </aside>
    </div>
    <div class="info-banner"><span class="reminder-icon">✦</span><div><h3>What this means</h3><p>Your baseline is the range we compare each reading against. The signal is for awareness and care-team conversations, not a diagnosis.</p></div><a class="button secondary small" href="#risk" data-page="risk">View thresholds ›</a></div>
    <section class="card table-card"><div class="table-head"><h2>Recent sensor readings</h2><button class="button secondary small" data-action="export-csv">Export CSV ↓</button></div>
      <table><thead><tr><th>Timestamp</th><th>Frequency</th><th>Amplitude</th><th>Severity</th></tr></thead><tbody>${readingRows(6)}</tbody></table>
    </section>`;
}

function renderRisk() {
  const latest = latestReading();
  return `${pageHeading('UNDERSTAND YOUR READINGS', 'Risk Analysis', 'See exactly how the live signal compares with each threshold, plus the plain-language reason behind every level.', '<button class="button" data-action="high-risk">Simulate high risk ⚡</button>')}
    <div class="risk-grid">
      <section class="card threshold-card"><div class="card-heading"><div><h2>Threshold comparison</h2><p>Live reading compared with each frequency band</p></div><span class="mock-pill">LIVE · ${latest.frequency_hz.toFixed(1)} Hz</span></div>
        ${drawChart(readings.slice(-40), 175, true)}
        <div class="threshold-legend"><span><i class="legend-dot" style="background:#20ae61"></i>Normal · 30–45 Hz</span><span><i class="legend-dot" style="background:#efa900"></i>Mild · 45–65 Hz</span><span><i class="legend-dot" style="background:#e34977"></i>High risk · above 65 Hz</span></div>
      </section>
      <section class="interpretation-card"><div class="tiny-label">CURRENT INTERPRETATION</div>
        <h2>${severityLabel(latest.severity)} range</h2>
        <p class="big-reading">${latest.frequency_hz.toFixed(1)} Hz compared with 35–45 Hz baseline</p><div class="divider"></div>
        <p>${latest.severity === 3 ? 'This reading is above the demo threshold. Consider discussing repeated patterns with your care team.' : latest.severity === 2 ? 'This reading is mildly elevated. A single reading can vary with movement, stress, hydration, or sensor placement.' : 'Your current reading is comfortably inside your baseline. Keeping hydration and rest consistent can support a steady signal.'}</p>
        <a class="button secondary small" href="#care" data-page="care">See your care team ↗</a>
      </section>
    </div>
    <div class="info-banner"><span class="reminder-icon">✦</span><div><h3>Why the thresholds matter</h3><p>The ranges are a simple way to notice changes early. A single reading can move with stress, movement, hydration, or sensor placement, so your care team looks for patterns over time.</p></div></div>
    <section class="card table-card"><div class="table-head"><h2>Recent severity history</h2><a class="button secondary small" href="#reports" data-page="reports">View all reports ↗</a></div>
      <table><thead><tr><th>Timestamp</th><th>Frequency</th><th>Amplitude</th><th>Severity</th></tr></thead><tbody>${readingRows(8)}</tbody></table>
    </section>`;
}

function renderPredictions() {
  const forecast = predictionData;
  const latest = latestReading();
  const forecastPoints = readings.slice(-24);
  if (forecast) {
    forecastPoints.push({
      frequency_hz: forecast.forecast_frequency_hz,
      amplitude_mv: latest.amplitude_mv,
      severity: forecast.predicted_severity,
    });
  }
  const probabilities = forecast?.severity_probabilities || { 1: 0, 2: 0, 3: 0 };
  const severityName = forecast ? severityLabel(forecast.predicted_severity) : 'Waiting for model';
  const accuracy = forecast ? Math.round(forecast.validation_accuracy * 100) : 0;
  return `${pageHeading('EXPERIMENTAL · MOCK-TRAINED', 'Trend Predictions', 'A transparent, short-horizon estimate trained on recent telemetry patterns. These demo predictions are not clinically validated or medical advice.', predictionLoading ? '<button class="button" data-action="refresh-prediction" disabled>Updating…</button>' : '<button class="button" data-action="refresh-prediction">Refresh forecast ↻</button>')}
    <div class="prediction-notice"><span class="reminder-icon">✦</span><div><strong>Experimental model, not a diagnosis</strong><p>Training data may include mock or unvalidated FPGA readings. The model has no clinical validation; do not use estimates to make care decisions.</p></div><span class="mock-pill">${forecast?.source || status.source} DATA</span></div>
    ${predictionError ? `<div class="prediction-error" role="alert">${predictionError}</div>` : ''}
    <div class="prediction-grid">
      <section class="card forecast-main">
        <div class="card-heading"><div><div class="eyebrow">NEXT ${forecast?.horizon_minutes || 30} MINUTES · EXPERIMENTAL</div><h2>Estimated signal trend</h2><p>${forecast ? `${forecast.readings_analyzed.toLocaleString()} recent readings analyzed · model updated ${formatTime(forecast.generated_at)}` : predictionLoading ? 'Training against available history…' : 'Forecast is not available yet.'}</p></div><span class="forecast-spark">↗</span></div>
        ${drawChart(downsample(forecastPoints), 200, true)}
        <div class="forecast-band"><span>Recent variation band</span><strong>${forecast ? `${forecast.recent_variation_band_hz[0].toFixed(1)}–${forecast.recent_variation_band_hz[1].toFixed(1)} Hz` : '—'}</strong></div>
        <p class="metric-note">The shaded band reflects recent signal variability; it is not a calibrated clinical confidence interval.</p>
      </section>
      <div class="prediction-side">
        <section class="card prediction-result"><div class="tiny-label">MODEL OUTLOOK</div><div class="prediction-number">${forecast ? `${forecast.forecast_frequency_hz.toFixed(1)}<span> Hz</span>` : '—'}</div>
          <div class="predicted-tag ${forecast ? severityClass(forecast.predicted_severity) : ''}">${severityName} · predicted category</div>
          <div class="prediction-confidence"><span>Top-class model probability · uncalibrated</span><strong>${forecast ? `${Math.round(forecast.top_class_probability * 100)}%` : '—'}</strong></div>
        </section>
        <section class="card probability-card"><h2>Severity probabilities</h2>
          ${[1, 2, 3].map((severity) => `<div class="probability-row"><div><span>${severity} · ${severityLabel(severity)}</span><strong>${forecast ? `${Math.round(probabilities[severity] * 100)}%` : '—'}</strong></div><div class="probability-track"><span class="${severityClass(severity)}" style="width:${forecast ? Math.max(2, probabilities[severity] * 100) : 0}%"></span></div></div>`).join('')}
        </section>
      </div>
    </div>
    <div class="prediction-stats">
      <article class="card prediction-stat"><span class="tiny-label">TEMPORAL HOLDOUT ACCURACY</span><strong>${forecast ? `${accuracy}%` : '—'}</strong><span>Last ${forecast?.validation_samples.toLocaleString() || '—'} unseen samples</span></article>
      <article class="card prediction-stat"><span class="tiny-label">TRAINING WINDOW</span><strong>${forecast?.training_samples.toLocaleString() || '—'}</strong><span>Chronological training samples</span></article>
      <article class="card prediction-stat"><span class="tiny-label">CURRENT LIVE READING</span><strong>${latest.frequency_hz.toFixed(1)} Hz</strong><span>Severity ${latest.severity} · ${severityLabel(latest.severity)}</span></article>
    </div>
    <section class="card assistant-card">
      <div class="assistant-heading">
        <span class="assistant-mark" aria-hidden="true">✦</span>
        <div><div class="eyebrow">HERE TO HELP</div><h2>Ask Pulse</h2><p>A friendly guide to your readings and this demo.</p></div>
        <span class="assistant-status ${status.assistantAvailable ? 'ready' : ''}"><i></i>${status.assistantAvailable ? 'AI ready' : 'Not connected'}</span>
      </div>
      <div class="assistant-disclaimer">Educational support only—not medical advice or a diagnosis. If you have urgent symptoms, contact a clinician or local emergency services.</div>
      <div class="assistant-messages" id="assistant-messages" aria-live="polite" aria-label="Conversation with Pulse">
        ${assistantMessages.length ? assistantMessages.map(({ role, content }) => `<div class="assistant-message ${role === 'user' ? 'from-user' : 'from-assistant'}"><span>${role === 'user' ? 'You' : 'Pulse'}</span><p>${escapeHtml(content)}</p></div>`).join('') : '<div class="assistant-message from-assistant"><span>Pulse</span><p>Hi! I can explain how this dashboard works or help you prepare questions for your care team. What would you like to know?</p></div>'}
        ${assistantSending ? '<div class="assistant-message from-assistant assistant-thinking" role="status"><span>Pulse</span><p>Thinking…</p></div>' : ''}
      </div>
      <div class="assistant-prompts"><button type="button" class="assistant-prompt" data-chat-prompt="What does frequency mean on this dashboard?">What does frequency mean?</button><button type="button" class="assistant-prompt" data-chat-prompt="What are some questions I could ask my care team about repeated changes?">Questions for my care team</button></div>
      <form class="assistant-form" id="assistant-form">
        <label class="visually-hidden" for="assistant-input">Ask Pulse a question</label>
        <input id="assistant-input" name="message" maxlength="1000" autocomplete="off" placeholder="${status.assistantAvailable ? 'Ask a question about your dashboard…' : 'Connect the assistant to start chatting'}" ${status.assistantAvailable && !assistantSending ? '' : 'disabled'}>
        <button class="button" type="submit" ${status.assistantAvailable && !assistantSending ? '' : 'disabled'}>${assistantSending ? 'Sending…' : 'Send ↗'}</button>
      </form>
      <p class="assistant-privacy">${status.assistantAvailable ? 'Your message and recent chat are sent to OpenAI along with an aggregate of up to 12 sensor readings. The aggregate contains no patient name or ID; do not include identifying details in chat.' : 'Set OPENAI_API_KEY on the server to enable AI replies. No chat data is sent while the assistant is disconnected.'}</p>
    </section>
    <section class="card model-details"><div class="card-heading"><div><h2>How this estimate is made</h2><p>${forecast?.model || 'Multinomial logistic regression using rolling telemetry features'}</p></div><div class="model-actions"><span class="mock-pill">RESEARCH PREVIEW</span><button class="button secondary small" data-action="refresh-prediction" ${predictionLoading ? 'disabled' : ''}>Recalculate ↻</button></div></div>
      <div class="model-steps"><span><b>01</b> Rolling frequency &amp; amplitude features</span><span><b>02</b> Time-ordered holdout validation</span><span><b>03</b> 30-minute trend extrapolation</span></div>
      <p class="metric-note">${forecast?.disclaimer || 'Model output is an experimental estimate from mock data only, is not clinically validated, and is not a diagnosis.'} Validation accuracy is specific to this synthetic dataset and should not be interpreted as real-world performance.</p>
    </section>`;
}

function renderReports() {
  const selectedReadings = reportReadings();
  return `${pageHeading('YOUR HISTORY', 'Reports & Clinical Logs', 'Choose a date range, add a care-team note, and download a clinician-ready summary.', '<span class="button secondary small">PDF export ready</span>')}
    <div class="reports-layout">
      <section class="card report-form"><div class="card-heading"><div><h2>Clinical PDF export</h2><p>The generated report includes the telemetry summary, threshold comparison, and your note.</p></div><span class="mock-pill">TELEMETRY SOURCE · ${status.source}</span></div>
        <div class="form-group"><label for="start-date">Start date</label><input id="start-date" type="date" value="${reportStart}"></div>
        <div class="form-group"><label for="end-date">End date</label><input id="end-date" type="date" value="${reportEnd}"></div>
        <div class="form-group"><label for="care-note">Care-team notes</label><textarea id="care-note">Baseline looks steady. Continue regular hydration and bring the next report to your next check-in.</textarea></div>
        <div class="form-pills"><button class="form-pill" data-action="report-summary">Telemetry summary</button><button class="form-pill" data-page="risk">Threshold guide</button><button class="form-pill" data-action="report-notes">Care notes</button><button class="button secondary small" data-action="export-csv" style="margin-left:auto">Export selected history ↓</button><button class="button" data-action="print-report">Download clinical PDF ⇩</button></div>
      </section>
      <section class="card report-list"><div class="card-heading"><div><h2>Recent reports</h2><p>Shared with you and your care team</p></div><span class="tiny-label">▦</span></div>
        ${[
    [`${formatDate(new Date(), { month: 'long' })} monitoring summary`, `${readings.length.toLocaleString()} recent readings · updated ${formatTime(latestReading().recorded_at)}`],
    ['Previous 7-day care review', `${formatDate(shiftLocalDate(new Date(), -7), { month: 'short', day: 'numeric', year: 'numeric' })} · Rolling trend`],
    ['Sensor telemetry history', `${readings.length.toLocaleString()} latest records · ${formatDate(latestReading().recorded_at)}`],
  ].map(([name, date]) => `<div class="report-item"><span class="report-icon">▤</span><div><strong>${name}</strong><span>${date}</span></div><span class="chevron">›</span></div>`).join('')}
      </section>
    </div>
    <section class="card trend-card" id="report-trend-summary">${reportTrendMarkup(selectedReadings)}
    </section>
    <section class="card table-card"><div class="table-head"><h2>History records · <span id="report-history-count">${selectedReadings.length.toLocaleString()}</span> in selected range</h2><span class="tiny-label">Latest 12 shown · export to view all</span></div>
      <table><thead><tr><th>Timestamp</th><th>Frequency</th><th>Amplitude</th><th>Severity</th></tr></thead><tbody id="report-history-rows">${selectedReadings.length ? readingRows(12, selectedReadings) : '<tr><td colspan="4" class="empty-state">No readings in this date range.</td></tr>'}</tbody></table>
    </section>`;
}

function reportTrendMarkup(records) {
  const avg = records.length ? records.reduce((sum, reading) => sum + reading.frequency_hz, 0) / records.length : 0;
  return `<div class="card-heading"><div><h2>Telemetry trend</h2><p>${reportLoading ? 'Loading history…' : `${records.length.toLocaleString()} readings · average frequency`}</p></div><span class="metric-value">${avg.toFixed(1)}<span class="metric-unit"> Hz</span></span></div>
    ${drawChart(downsample(records), 125)}<div class="chart-labels"><span>${records.length ? formatDate(records[0].recorded_at, { month: 'short', day: 'numeric' }) : reportStart}</span><span>${records.length ? formatDate(records.at(-1).recorded_at, { month: 'short', day: 'numeric' }) : reportEnd}</span></div>`;
}

function refreshReportLiveWidgets() {
  const trend = document.querySelector('#report-trend-summary');
  const count = document.querySelector('#report-history-count');
  const rows = document.querySelector('#report-history-rows');
  if (!trend || !count || !rows) return;
  trend.innerHTML = reportTrendMarkup(reportRecords);
  count.textContent = reportRecords.length.toLocaleString();
  rows.innerHTML = reportRecords.length
    ? readingRows(12, reportRecords)
    : '<tr><td colspan="4" class="empty-state">No readings in this date range.</td></tr>';
}

function renderCare() {
  const doctors = [
    ['👩‍⚕️', 'Dr. Arun Mehta', 'Neurologist', 'Available today', '0.8 km away · CityCare', false],
    ['👩‍⚕️', 'Dr. Priya Rao', 'Cardiac Telemetry', `Next slot ${formatTime(new Date(Date.now() + 60 * 60 * 1000))}`, '1.4 km away · Heartline', true],
    ['👩‍⚕️', 'Dr. Elena Shah', 'Rehabilitation Expert', 'Available tomorrow', '2.1 km away · Restore Lab', true],
  ];
  return `${pageHeading('PEOPLE AROUND YOU', 'Care Team & Specialists', 'Your support network is here when you need reassurance, a second look, or a faster conversation.')}
    <div class="team-grid">${doctors.map(([emoji, name, specialty, availability, location, later]) => `<article class="card doctor-card">
      <div class="doctor-top"><span class="doctor-avatar">${emoji}</span><span class="availability ${later ? 'later' : ''}">${availability}</span></div>
      <h2>${name}</h2><div class="doctor-specialty">${specialty}</div><div class="doctor-location">⌖ ${location}</div>
      <div class="doctor-actions"><button class="button secondary small" data-action="message" data-doctor="${name}">Message</button><button class="button small" data-action="book" data-doctor="${name}">Book slot</button></div>
    </article>`).join('')}</div>
    <section class="card assigned-card"><span class="avatar avatar-small">♡</span><div><h3>Your assigned care team</h3><p>Dr. Arun Mehta · Neurology · Weekly review on Wednesdays</p></div><button class="button secondary small" data-action="calendar">View calendar ▣</button></section>`;
}

function renderHardware() {
  const latest = latestReading();
  return `${pageHeading('HARDWARE CONNECTION', 'USB Hardware Device', 'Connect the MPU6050 FPGA sensor through Web Serial. Incoming frames are labeled by source while the hardware schema is verified.', sourceBadge())}
    <div class="hardware-grid">
      <section class="hardware-main"><div style="display:flex;justify-content:space-between;align-items:center"><span class="device-icon">⚡</span>${sourceBadge()}</div>
        <h2>MPU6050 FPGA tremor sensor</h2><p>Web Serial · 115200 baud · JSONL</p><div class="device-meta">Device adapter · awaiting hardware verification</div>
        <div class="adapter-status"><span class="online-dot"></span><strong id="adapter-label">Adapter ready</strong><br><span style="margin-left:15px;color:#c6b4e4">MOCKED telemetry is active</span></div>
        <div class="hardware-controls"><button class="button secondary" data-action="connect-serial" id="serial-button">Connect USB sensor</button><button class="button secondary" data-action="pause">${demoPaused ? 'Resume demo feed' : 'Pause demo feed'}</button></div>
      </section>
      <div class="hardware-side">
        <section class="card health-card"><div class="card-heading"><h2>Adapter health</h2><span class="tiny-label">⌁</span></div>
          <div class="health-values"><div class="health-value"><span>Battery</span><strong>92%</strong></div><div class="health-value green"><span>Frame quality</span><strong>96%</strong></div></div>
          <button class="button secondary small full" data-action="diagnostic" style="margin-top:11px">Run adapter diagnostic ⌘</button>
        </section>
        <section class="card calibration-card" style="background:var(--purple-soft);border-color:#e7dbff"><div class="card-heading"><div><h2>Sensor calibration</h2><p>FPGA calibration remains MOCKED until frame units are verified</p></div></div>
          <button class="button secondary small full" data-action="calibrate" style="margin-top:14px">Start calibration ⟳</button>
        </section>
      </div>
    </div>
    <section class="card frame-card"><div class="card-heading"><div><h2>Live adapter frame</h2><p>Incoming frames are parsed conservatively; units and schema are awaiting hardware verification.</p></div>${sourceBadge()}</div>
      <div class="frame-metrics"><div class="frame-metric"><span>Frequency</span><strong>${latest.frequency_hz.toFixed(1)} Hz</strong></div><div class="frame-metric"><span>Amplitude</span><strong>${latest.amplitude_mv.toFixed(2)} mV</strong></div><div class="frame-metric"><span>Severity</span><strong>${latest.severity} · ${severityLabel(latest.severity)}</strong></div></div>
      <div class="terminal">transport: Web Serial / 115200<br>schema: pending hardware verification<br>source: ${status.source}<br>severity: ${latest.severity} (${severityLabel(latest.severity)})</div>
    </section>`;
}

function renderProfile() {
  return `${pageHeading('YOUR INFORMATION', 'Patient Profile', 'Keep your care details close at hand and make sure your support preferences stay up to date.', '<button class="button secondary small" data-action="edit-profile">Edit profile ↗</button>')}
    <div class="profile-grid">
      <section class="card profile-summary"><div class="profile-identity"><span class="avatar">S</span><div><h2>Samruddhi</h2><p>Patient ID · PC-20481</p></div></div>
        <div class="profile-info"><div class="tiny-label">PRIMARY CAREGIVER</div><strong>Aarav Kulkarni</strong><div class="metric-note">+91 98765 43210 · Brother</div></div>
        <div class="profile-info"><div class="tiny-label">ASSIGNED DEVICE</div><strong>Pulse sensor v2.4</strong><div class="metric-note">USB-COM3 · MOCKED demo unit</div></div>
      </section>
      <section class="card personal-card"><h2>Personal details</h2>
        <div class="personal-details"><div><span>Date of birth</span><strong>18 June 1998</strong></div><div><span>Preferred language</span><strong>English</strong></div><div><span>Emergency contact</span><strong>Aarav Kulkarni</strong></div><div><span>Care location</span><strong>Pune, Maharashtra</strong></div></div>
        <div class="notify-row"><div><strong>Reading notifications</strong><span>Get a gentle reminder when it’s time to check in.</span></div><button class="switch on" data-action="notifications" aria-label="Toggle reading notifications"></button></div>
      </section>
    </div>`;
}

const renderers = {
  overview: renderOverview,
  monitoring: renderMonitoring,
  risk: renderRisk,
  predictions: renderPredictions,
  reports: renderReports,
  care: renderCare,
  hardware: renderHardware,
  profile: renderProfile,
};

function render() {
  const chatInput = appContent.querySelector('#assistant-input');
  if (chatInput) assistantDraft = chatInput.value;
  currentPage = location.hash.slice(1) in renderers ? location.hash.slice(1) : 'overview';
  breadcrumb.textContent = pageNames[currentPage];
  document.title = `${pageNames[currentPage]} — Pulse`;
  document.querySelectorAll('[data-page]').forEach((link) => {
    const active = link.dataset.page === currentPage;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  appContent.innerHTML = renderers[currentPage]();
  const refreshedChatInput = appContent.querySelector('#assistant-input');
  if (refreshedChatInput && !refreshedChatInput.disabled) refreshedChatInput.value = assistantDraft;
  if (currentPage === 'monitoring' || currentPage === 'risk') {
    appContent.querySelectorAll('.chart-svg').forEach((chart) => {
      chart.setAttribute('aria-label', `Frequency signal history for ${readings.length} readings`);
    });
  }
  if (currentPage === 'reports') loadReportHistory();
  if (currentPage === 'predictions') loadPredictions();
}

function updateLocalClock() {
  const now = new Date();
  const today = localDateInput(now);
  const clock = document.querySelector('#live-clock');
  const date = document.querySelector('#live-date');
  const welcomeDate = document.querySelector('#welcome-date');
  if (clock) {
    clock.textContent = formatTime(now, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    clock.dateTime = now.toISOString();
  }
  if (date) date.textContent = formatDate(now, { weekday: 'short', month: 'short', day: 'numeric' });
  if (welcomeDate) {
    welcomeDate.textContent = formatDate(now, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  if (today !== currentLocalDay) {
    currentLocalDay = today;
    if (!reportRangeCustomized) {
      reportEnd = today;
      reportStart = localDateInput(shiftLocalDate(now, -30));
      loadedReportRange = null;
      requestedReportRange = null;
    }
    if (currentPage === 'reports') render();
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

async function loadData() {
  const [statusResponse, readingResponse] = await Promise.all([fetch('/api/status'), fetch('/api/readings?limit=1000')]);
  if (!statusResponse.ok || !readingResponse.ok) throw new Error('Could not load telemetry from the server.');
  status = await statusResponse.json();
  readings = await readingResponse.json();
  syncLabel.textContent = status.database === 'mysql' ? 'MySQL synced' : 'Device synced';
  render();
}

let reportLoading = false;

async function loadReportHistory() {
  const rangeKey = `${reportStart}:${reportEnd}`;
  if (requestedReportRange === rangeKey || loadedReportRange === rangeKey) return;
  const requestId = ++reportRequestId;
  requestedReportRange = rangeKey;
  reportLoading = true;
  if (reportStart > reportEnd) {
    reportRecords = [];
    loadedReportRange = rangeKey;
    reportLoading = false;
    render();
    return;
  }
  try {
    const pageSize = 5000;
    let cursor = null;
    let records = [];
    while (true) {
      const params = new URLSearchParams({
        from: reportStart,
        to: reportEnd,
        limit: String(pageSize),
        timezoneOffset: String(new Date().getTimezoneOffset()),
      });
      if (cursor) params.set('before', cursor);
      const response = await fetch(`/api/readings?${params}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load the selected history.');
      if (requestId !== reportRequestId) return;
      records = body.concat(records);
      if (body.length < pageSize) break;
      cursor = body[0].recorded_at;
    }
    reportRecords = records;
    loadedReportRange = rangeKey;
    reportLoading = false;
    render();
  } catch (error) {
    if (requestId !== reportRequestId) return;
    requestedReportRange = null;
    reportLoading = false;
    showToast(error.message);
  }
}

async function loadPredictions(force = false) {
  if (predictionLoading || (!force && Date.now() - predictionUpdatedAt < 30_000)) return;
  predictionLoading = true;
  predictionError = null;
  const refreshButton = appContent.querySelector('[data-action="refresh-prediction"]');
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Updating…';
  }
  try {
    const response = await fetch('/api/predictions');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not load the experimental forecast.');
    predictionData = body;
    predictionUpdatedAt = Date.now();
  } catch (error) {
    predictionError = error.message;
    predictionUpdatedAt = Date.now();
  } finally {
    predictionLoading = false;
    if (currentPage === 'predictions') render();
  }
}

async function sendAssistantMessage(event) {
  event.preventDefault();
  const input = appContent.querySelector('#assistant-input');
  const message = input?.value.trim();
  if (!message || assistantSending || !status.assistantAvailable) return;

  assistantMessages.push({ role: 'user', content: message });
  assistantMessages = assistantMessages.slice(-20);
  assistantDraft = '';
  assistantSending = true;
  render();
  try {
    const history = assistantMessages.slice(0, -1).slice(-6);
    const response = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The assistant could not reply. Please try again.');
    assistantMessages.push({ role: 'assistant', content: body.answer });
  } catch (error) {
    assistantMessages.push({ role: 'assistant', content: error.message });
  } finally {
    assistantMessages = assistantMessages.slice(-20);
    assistantSending = false;
    if (currentPage === 'predictions') render();
  }
}

async function requestReading(path) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not create the demo reading.');
  return body;
}

function downloadCsv(records = readings) {
  const rows = [['recorded_at', 'frequency_hz', 'amplitude_mv', 'severity', 'payload']];
  records.forEach((reading) => rows.push([
    reading.recorded_at,
    reading.frequency_hz,
    reading.amplitude_mv,
    reading.severity,
    JSON.stringify(reading.payload),
  ]));
  const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = currentPage === 'reports' ? `pulse-telemetry-${reportStart}-to-${reportEnd}.csv` : 'pulse-telemetry-history.csv';
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('Telemetry history exported as CSV.');
}

async function connectSerial() {
  if (!('serial' in navigator)) {
    showToast('Web Serial is unavailable here. Try a Chromium-based browser over HTTPS or localhost.');
    return;
  }
  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 115200 });
    demoPaused = true;
    await fetch('/api/demo/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    document.querySelector('#adapter-label').textContent = 'FPGA connected · awaiting JSONL';
    document.querySelector('#serial-button').textContent = 'USB sensor connected';
    showToast('USB sensor connected. Waiting for newline-delimited JSON frames.');
    const decoder = new TextDecoderStream();
    serialPort.readable.pipeTo(decoder.writable).catch((error) => {
      if (error.name !== 'AbortError') showToast(`Serial stream stopped: ${error.message}`);
    });
    const reader = decoder.readable.getReader();
    let buffer = '';
    while (serialPort.readable && reader) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split(/\r?\n/);
      buffer = frames.pop() || '';
      for (const line of frames) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          const response = await fetch('/api/readings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(frame),
          });
          if (!response.ok) {
            const result = await response.json();
            showToast(result.error || 'FPGA frame was rejected.');
          }
        } catch (error) {
          showToast(`Invalid sensor frame: ${error.message}`);
        }
      }
    }
    reader.releaseLock();
  } catch (error) {
    showToast(`Could not connect to the USB sensor: ${error.message}`);
  }
}

document.addEventListener('click', async (event) => {
  const chatPrompt = event.target.closest('[data-chat-prompt]');
  if (chatPrompt) {
    const input = appContent.querySelector('#assistant-input');
    if (input && !input.disabled) {
      input.value = chatPrompt.dataset.chatPrompt;
      assistantDraft = input.value;
      input.focus();
    }
    return;
  }

  const task = event.target.closest('[data-task]');
  if (task) {
    const taskName = task.dataset.task;
    if (completedTasks.has(taskName)) completedTasks.delete(taskName);
    else completedTasks.add(taskName);
    render();
    return;
  }

  const pageLink = event.target.closest('[data-page]');
  if (pageLink) {
    event.preventDefault();
    location.hash = pageLink.dataset.page;
    return;
  }

  const action = event.target.closest('[data-action]');
  if (!action) return;
  try {
    switch (action.dataset.action) {
      case 'high-risk':
        await requestReading('/api/demo/high-risk');
        showToast('Demo high-risk reading saved to telemetry history.');
        break;
      case 'refresh-prediction':
        predictionUpdatedAt = 0;
        await loadPredictions(true);
        break;
      case 'pause': {
        demoPaused = !demoPaused;
        await fetch('/api/demo/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: demoPaused }) });
        showToast(demoPaused ? 'Mock telemetry paused.' : 'Mock telemetry resumed.');
        render();
        break;
      }
      case 'connect-serial':
        await connectSerial();
        break;
      case 'export-csv':
        downloadCsv(currentPage === 'reports' ? reportReadings() : readings);
        break;
      case 'print-report':
        window.print();
        break;
      case 'report-summary':
      case 'report-notes':
      case 'calendar':
      case 'diagnostic':
      case 'calibrate':
      case 'edit-profile':
      case 'notifications':
        if (action.classList.contains('switch')) action.classList.toggle('on');
        showToast('This preview action is ready for your care-team workflow.');
        break;
      case 'message':
        showToast(`Opening a secure care-team message to ${action.dataset.doctor}.`);
        break;
      case 'book':
        showToast(`Appointment request started for ${action.dataset.doctor}.`);
        break;
      default:
        break;
    }
  } catch (error) {
    showToast(error.message);
  }
});

appContent.addEventListener('input', (event) => {
  if (event.target.id === 'assistant-input') assistantDraft = event.target.value;
});

appContent.addEventListener('submit', (event) => {
  if (event.target.id === 'assistant-form') sendAssistantMessage(event);
});

appContent.addEventListener('change', (event) => {
  if (event.target.id === 'start-date') reportStart = event.target.value;
  if (event.target.id === 'end-date') reportEnd = event.target.value;
  if (event.target.id === 'start-date' || event.target.id === 'end-date') {
    reportRangeCustomized = true;
    loadedReportRange = null;
    requestedReportRange = null;
    render();
  }
});

socket.on('reading', (reading) => {
  readings.push(reading);
  if (readings.length > 30_000) readings.shift();
  status.source = reading.payload?.source || status.source;
  const readingDate = reading.recorded_at.slice(0, 10);
  if (readingDate >= reportStart && readingDate <= reportEnd) {
    reportRecords.push(reading);
    if (currentPage === 'reports') refreshReportLiveWidgets();
  }
  if (currentPage !== 'care' && currentPage !== 'profile' && currentPage !== 'reports') {
    render();
  }
});

socket.on('telemetry-error', (message) => showToast(message));
socket.on('connect', () => {
  if (status.database === 'mysql') syncLabel.textContent = 'MySQL synced';
});
socket.on('disconnect', () => {
  syncLabel.textContent = 'Reconnecting…';
});
window.addEventListener('hashchange', render);
window.addEventListener('focus', () => {
  updateLocalClock();
  loadData().catch((error) => showToast(error.message));
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    updateLocalClock();
    loadData().catch((error) => showToast(error.message));
  }
});

updateLocalClock();
setInterval(updateLocalClock, 1000);
loadData().catch((error) => {
  console.error(error);
  showToast(error.message);
  render();
});
