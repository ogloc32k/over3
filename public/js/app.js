// ============================================================
// GLOBAL STATE & HELPER FUNCTIONS
// ============================================================
let globalState = null;
let currentFocus = 'R_75';
let serverMode = 'demo';

// Market definitions
const MARKETS_CFG = {
  'R_10': 'Volatility 10 Index',
  'R_25': 'Volatility 25 Index',
  'R_50': 'Volatility 50 Index',
  'R_75': 'Volatility 75 Index',
  'R_100': 'Volatility 100 Index',
  '1HZ10V': 'Volatility 10 (1s) Index',
  '1HZ25V': 'Volatility 25 (1s) Index',
  '1HZ50V': 'Volatility 50 (1s) Index',
  '1HZ75V': 'Volatility 75 (1s) Index',
  '1HZ100V': 'Volatility 100 (1s) Index'
};

const MARKET_DECIMALS = {
  'R_10': 2, 'R_25': 3, 'R_50': 4, 'R_75': 4, 'R_100': 2,
  '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2
};

function formatPrice(symbol, raw) {
  if (raw === undefined || raw === null) return '—';
  const dec = MARKET_DECIMALS[symbol] || 2;
  return Number(raw).toFixed(dec);
}

// ============================================================
// TAB SWITCHING
// ============================================================
document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.addEventListener('click', function() {
    const tabId = this.dataset.tab;
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    if (tabId === 'analytics') {
      if (typeof renderCharts === 'function') renderCharts();
    }
  });
});

// ============================================================
// CLOCK
// ============================================================
function updateClock() {
  const now = new Date();
  document.getElementById('clock-display').textContent =
    now.toLocaleTimeString('en-US', { timeZone: 'Africa/Nairobi', hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

// ============================================================
// SSE CONNECTION
// ============================================================
let sse = null;
function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/api/logs');
  sse.onopen = () => console.log('✅ SSE connected');
  sse.onerror = (err) => {
    console.warn('⚠️ SSE error:', err);
    setTimeout(connectSSE, 5000);
  };
  sse.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.state) {
        globalState = data.state;
        renderUI(globalState);
      }
      if (data.logs && data.logs.length) {
        const box = document.getElementById('log-stream');
        data.logs.forEach(log => {
          const el = document.createElement('div');
          el.className = 'log-entry';
          el.innerHTML = `<span class="ts">[${new Date(log.time).toLocaleTimeString()}]</span><span class="msg">${log.message}</span>`;
          box.prepend(el);
        });
        while (box.children.length > 200) box.removeChild(box.lastChild);
      }
    } catch (err) { console.error('SSE parse error:', err); }
  };
}
connectSSE();

// ============================================================
// RENDER UI
// ============================================================
function renderUI(state) {
  const safeState = state || {};
  const balance = safeState.balance || null;
  const sessionPnl = safeState.sessionPnl || 0;
  const dailyPnl = safeState.dailyPnl || 0;
  const currentStake = safeState.currentStake || 0.35;
  const marketMetrics = safeState.marketMetrics || {};

  // Sidebar
  document.getElementById('m-profile').textContent = (safeState.tradingMode || 'demo').toUpperCase();
  document.getElementById('m-balance').textContent = balance !== null ? `$${Number(balance).toFixed(2)}` : '—';
  document.getElementById('m-session').textContent = `$${Number(sessionPnl).toFixed(2)}`;
  document.getElementById('m-daily').textContent = `$${Number(dailyPnl).toFixed(2)}`;
  document.getElementById('m-stake').textContent = `$${Number(currentStake).toFixed(2)}`;

  // Focus bar (if you have one, we'll skip for now, but can add later)

  // Table
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';
  for (const sym in MARKETS_CFG) {
    const metric = marketMetrics[sym] || null;
    const price = metric?.price;
    const formattedPrice = metric?.formattedPrice || formatPrice(sym, price);
    const support = metric?.support ? Number(metric.support).toFixed(2) : '—';
    const resistance = metric?.resistance ? Number(metric.resistance).toFixed(2) : '—';
    const rsi = metric?.rsi !== undefined ? Number(metric.rsi).toFixed(1) : '—';
    const vol = metric?.volatility !== undefined ? Number(metric.volatility).toFixed(2) + '%' : '—';
    const breakout = metric?.isBreakout ? '🟢 UP' : (metric?.isBreakdown ? '🔴 DOWN' : '⚪ RANGE');
    const supportPct = metric?.supportPct !== undefined ? Math.round(metric.supportPct) : null;
    const resistancePct = metric?.resistancePct !== undefined ? Math.round(metric.resistancePct) : null;
    const risePct = metric?.risePct !== undefined ? Math.round(metric.risePct) : null;
    const fallPct = metric?.fallPct !== undefined ? Math.round(metric.fallPct) : null;
    const srPctDisplay = (supportPct !== null && resistancePct !== null) ? `${supportPct}% / ${resistancePct}%` : '—';
    const rfPctDisplay = (risePct !== null && fallPct !== null) ? `${risePct}% / ${fallPct}%` : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${MARKETS_CFG[sym]}</td>
      <td>${formattedPrice}</td>
      <td><span class="s">${support}</span> / <span class="r">${resistance}</span></td>
      <td>${srPctDisplay}</td>
      <td>${rfPctDisplay}</td>
      <td>${breakout}</td>
      <td>${rsi}</td>
      <td>${metric?.bandwidth !== undefined ? metric.bandwidth.toFixed(2) + '%' : '—'}</td>
      <td>—</td>
    `;
    tbody.appendChild(tr);
  }
}

// ============================================================
// CONTROLS
// ============================================================
window.sendControl = function(action) {
  fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
    .then(res => res.json())
    .then(data => { if (data.error) alert(data.error); })
    .catch(console.error);
};

window.swapEnvironment = function() {
  const newMode = serverMode === 'demo' ? 'real' : 'demo';
  fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set_mode', mode: newMode }) })
    .then(res => res.json())
    .then(data => { if (data.error) alert(data.error); })
    .catch(console.error);
};

window.fireManual = function(type) {
  const duration = parseInt(document.getElementById('manual-duration').value) || 7;
  const unit = document.getElementById('manual-unit').value;
  const price = globalState?.marketMetrics?.[currentFocus]?.price;
  if (!price) { alert('No price data available for ' + currentFocus); return; }
  fetch('/api/manual-trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: currentFocus, contractType: type, duration, durationUnit: unit, price })
  })
    .then(async res => {
      const text = await res.text();
      if (!res.ok) throw new Error(text);
      const data = JSON.parse(text);
      if (data.error) alert(data.error);
      else console.log('Trade sent:', data.message);
    })
    .catch(err => alert('Error: ' + err.message));
};

window.clearLogs = function() {
  document.getElementById('log-stream').innerHTML = '';
};

// ============================================================
// ANALYTICS CHARTS (simplified placeholders)
// ============================================================
let assetChart = null, equityChart = null;

function renderCharts() {
  // Placeholder – will be implemented once data flows
  console.log('Analytics charts placeholder');
}

window.timeframePreset = function(btn, mode) {
  document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // Fetch analytics data from /api/ledger/aggregated?mode=...
  fetch(`/api/ledger/aggregated?mode=${mode}`)
    .then(res => res.json())
    .then(data => {
      // update metrics
      document.getElementById('meta-profit').textContent = `$${data.totalProfit.toFixed(2)}`;
      // update charts (placeholder)
      console.log('Analytics data:', data);
    })
    .catch(console.error);
};

window.saveSettings = function() {
  const config = {
    ANALYSIS_WINDOW: parseInt(document.getElementById('config-ANALYSIS_WINDOW').value),
    BOLLINGER_PERIOD: parseInt(document.getElementById('config-BOLLINGER_PERIOD').value),
    BOLLINGER_STD: parseFloat(document.getElementById('config-BOLLINGER_STD').value),
    RSI_PERIOD: parseInt(document.getElementById('config-RSI_PERIOD').value),
    MIN_VOLATILITY_PERCENT: parseFloat(document.getElementById('config-MIN_VOLATILITY_PERCENT').value)
  };
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) alert('Settings applied');
      else alert('Error: ' + data.error);
    })
    .catch(console.error);
};

// ============================================================
// THEME TOGGLE
// ============================================================
document.getElementById('themeToggle').addEventListener('click', function() {
  document.body.classList.toggle('light');
  this.textContent = document.body.classList.contains('light') ? '☀️' : '🌙';
});

console.log('🚀 QUANTCORE Terminal loaded');
