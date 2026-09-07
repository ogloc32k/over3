// ============================================================
// app.js – Orchestrator + Mobile Nav Drawer + Tab Switching + Sync
// ============================================================

// ---- Mobile Nav Drawer ----
function openNavDrawer() {
  const drawer = document.getElementById('navDrawer');
  const overlay = document.getElementById('navDrawerOverlay');
  if (drawer) drawer.classList.add('open');
  if (overlay) overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeNavDrawer() {
  const drawer = document.getElementById('navDrawer');
  const overlay = document.getElementById('navDrawerOverlay');
  if (drawer) drawer.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
}

// ---- Unified Tab Switching (desktop header + mobile drawer) ----
function switchTab(tabId) {
  if (!tabId) return;

  const isMobile = window.innerWidth <= 768;

  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.drawer-nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.header-tabs .nav-tab').forEach(b => b.classList.remove('active'));

  const page = document.getElementById(tabId);
  if (page) page.classList.add('active');

  const drawerBtn = document.querySelector(`.drawer-nav-item[data-tab="${tabId}"]`);
  if (drawerBtn) drawerBtn.classList.add('active');
  const headerBtn = document.querySelector(`.header-tabs .nav-tab[data-tab="${tabId}"]`);
  if (headerBtn) headerBtn.classList.add('active');

  // ---- Per-tab logic ----
  if (tabId === 'tab-analytics') {
    if (window.Analytics && typeof window.Analytics.renderCharts === 'function') {
      window.Analytics.renderCharts();
    }
    if (typeof window.timeframePreset === 'function') {
      const sessionBtn = document.getElementById('p-session');
      if (sessionBtn) window.timeframePreset(sessionBtn, 'session');
    }
  }
  if (tabId === 'tab-logs') {
    if (typeof window.scrollLogsToBottom === 'function') window.scrollLogsToBottom();
  }
  if (tabId === 'tab-bots') {
    if (typeof loadBotDailyPnl === 'function') loadBotDailyPnl();
    if (typeof window.loadBotConfig === 'function') window.loadBotConfig();
  }

  // Lazy-render tabs
  if (isMobile && tabId === 'tab-markets' && typeof renderMobileMarkets === 'function') renderMobileMarkets();
  if (tabId === 'tab-manual' && typeof initManualTrade === 'function') initManualTrade();

  // ---- Focus bar visibility ----
  const focusBar = document.getElementById('focusBar');
  if (focusBar) {
    focusBar.style.display = (tabId === 'tab-analytics') ? 'none' : '';
  }

  // ---- Sidebar collapse / restore ----
  const sidebar = document.getElementById('appSidebar');
  const toggle = document.getElementById('sidebarToggleFixed');
  const body = document.body;
  body.classList.remove('analytics-active', 'dashboard-active');

  if (tabId === 'tab-analytics') {
    body.classList.add('analytics-active');
    if (sidebar) sidebar.classList.add('collapsed');
    if (toggle) toggle.textContent = '▶';
  } else {
    if (sidebar) sidebar.classList.remove('collapsed');
    if (toggle) toggle.textContent = '◀';
    if (tabId === 'tab-home' || tabId === 'tab-dashboard') {
      body.classList.add('dashboard-active');
    }
  }

  // ---- Mobile home chart ----
  if (tabId === 'tab-home' && typeof loadMobileHomeData === 'function') {
    loadMobileHomeData();
  }
}

// Expose globally
window.switchTab = switchTab;

// ---- DOM Ready ----
document.addEventListener('DOMContentLoaded', function () {
  console.log('DOMContentLoaded fired');

  // Wire desktop header tabs
  document.querySelectorAll('.header-tabs .nav-tab').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      const tabId = this.dataset.tab;
      if (tabId) switchTab(tabId);
    });
  });

  // ---- Theme toggle ----
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    const currentTheme = localStorage.getItem('theme') || 'dark';
    document.body.classList.toggle('light', currentTheme === 'light');
    themeToggle.textContent = currentTheme === 'light' ? '☀️' : '🌙';
    themeToggle.addEventListener('click', function () {
      const isLight = document.body.classList.toggle('light');
      localStorage.setItem('theme', isLight ? 'light' : 'dark');
      themeToggle.textContent = isLight ? '☀️' : '🌙';
    });
  }

  // ---- Sidebar toggle ----
  const sidebar = document.getElementById('appSidebar');
  const toggleFixed = document.getElementById('sidebarToggleFixed');
  if (toggleFixed) {
    toggleFixed.addEventListener('click', function () {
      if (sidebar) sidebar.classList.toggle('collapsed');
      toggleFixed.textContent = sidebar?.classList.contains('collapsed') ? '▶' : '◀';
    });
  }

  // ---- Clock ----
  function updateClock() {
    try {
      const now = new Date();
      const options = { timeZone: 'Africa/Nairobi' };
      const timeStr = now.toLocaleTimeString('en-US', { ...options, hour12: false });
      const dateStr = now.toLocaleDateString('en-US', { ...options, month: 'short', day: '2-digit' });
      const clockEl = document.getElementById('clock-display');
      const dateEl = document.getElementById('clock-date');
      if (clockEl) clockEl.textContent = timeStr;
      if (dateEl) dateEl.textContent = dateStr;
    } catch (e) { /* ignore */ }
  }
  setInterval(updateClock, 1000);
  updateClock();

  // ---- Initialize core (SSE connection) ----
  if (window.QuantCore && typeof window.QuantCore.connectSSE === 'function') {
    QuantCore.connectSSE();
  }
  if (window.QuantCore && typeof window.QuantCore.renderUI === 'function') {
    QuantCore.renderUI({});
  }

  // Load mobile home data if on mobile and home tab is active
  if (window.innerWidth <= 768 && typeof loadMobileHomeData === 'function') {
    loadMobileHomeData();
  }

  console.log('🚀 QUANTCORE Terminal v6.0 loaded');
});

// ============================================================
// HOME + DRAWER SYNC
// Called from core.js SSE handler after renderUI()
// ============================================================

let _lastTradingMode = null;

function syncMobileUI(state) {
  if (!state) return;

  const mode    = state.tradingMode || 'demo';
  const balance = state.balance ?? null;
  const session = state.sessionPnl ?? 0;
  const balStr  = balance !== null ? '$' + Number(balance).toFixed(2) : '$—';

  // Drawer header
  _setText('drawer-mode',    mode.toUpperCase());
  _setText('drawer-balance', balStr);

  // Header profile button
  _setText('header-profile-mode', mode.toUpperCase());
  _setText('sp-mode', mode.toUpperCase());

  // Home screen strip
  _setText('home-mode',    mode.toUpperCase());
  _setText('home-balance', balStr);
  const sessEl = document.getElementById('home-session');
  if (sessEl) {
    sessEl.textContent = '$' + Number(session).toFixed(2);
    sessEl.className   = 'hstat-val ' + (session >= 0 ? 'green' : 'red');
  }
  _setText('home-status', (state.lifecycleStatus || (!state.active ? 'idle' : state.executionMode || 'virtual')).toUpperCase());

  // Sync bot card
  _syncBotCard(state);

  // Refresh whichever tab is open
  const activeTab = document.querySelector('.tab-page.active');
  if (activeTab) {
    if (activeTab.id === 'tab-markets' && typeof renderMobileMarkets === 'function') renderMobileMarkets();
    if (activeTab.id === 'tab-manual'  && typeof updateManualInfo === 'function')  updateManualInfo();
  }

  // Refresh analytics on account switch
  if (mode !== _lastTradingMode) {
    _lastTradingMode = mode;
    if (typeof window.refreshAnalytics === 'function') {
      window.refreshAnalytics();
    }
  }
}

function _setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ============================================================
// MARKETS — vertical card list (mobile only)
// ============================================================
function renderMobileMarkets() {
  if (window.innerWidth > 768) return;
  const state   = window.QuantCore?.getGlobalState() || {};
  const metrics = state.marketMetrics || {};
  const MARKETS = window.QuantCore?.MARKETS_CFG || {};
  const container = document.getElementById('mobileMarketsList');
  if (!container) return;

  container.innerHTML = '';

  for (const sym in MARKETS) {
    const m = metrics[sym] || null;

    const price   = m ? (m.formattedPrice || Number(m.price || 0).toFixed(2)) : '—';
    const sup     = m?.support    ? Number(m.support).toFixed(2)    : '—';
    const res     = m?.resistance ? Number(m.resistance).toFixed(2) : '—';
    const risePct = m?.risePct !== undefined ? Number(m.risePct).toFixed(1) + '%' : '—';
    const fallPct = m?.fallPct !== undefined ? Number(m.fallPct).toFixed(1) + '%' : '—';

    let badgeClass = '', badgeText = 'RANGE';
    if (m?.isBreakout)  { badgeClass = 'up';   badgeText = '▲ UP';   }
    if (m?.isBreakdown) { badgeClass = 'down'; badgeText = '▼ DOWN'; }

    const trendHtml = (m?.tickDirections || []).slice(-5).map(d =>
      d > 0 ? '<span class="tick-up">▲</span>'
            : d < 0 ? '<span class="tick-down">▼</span>'
                    : '<span class="tick-flat">—</span>'
    ).join('') || '—';

    const card = document.createElement('div');
    card.className = 'market-card' + (sym === window.QuantCore?.getCurrentFocus() ? ' active' : '');
    card.onclick = () => {
      document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      window.QuantCore?.setFocusMarket(sym);
    };
    card.innerHTML = `
      <div class="mc-top">
        <span class="mc-name">${MARKETS[sym]}</span>
        <span class="mc-price">${price}</span>
        <span class="mc-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="mc-metrics">
        <div class="mc-metric"><span class="lbl">Support</span><span class="val green">${sup}</span></div>
        <div class="mc-metric"><span class="lbl">Resist</span><span class="val red">${res}</span></div>
        <div class="mc-metric"><span class="lbl">Rise%</span><span class="val green">${risePct}</span></div>
        <div class="mc-metric"><span class="lbl">Fall%</span><span class="val red">${fallPct}</span></div>
      </div>
      <div class="mc-trend">${trendHtml}</div>`;
    container.appendChild(card);
  }
}

// ============================================================
// MANUAL TRADE (works on both desktop & mobile)
// ============================================================
const MANUAL_SHORT = {
  'R_10':'V10','R_25':'V25','R_50':'V50','R_75':'V75','R_100':'V100',
  '1HZ10V':'V10(1s)','1HZ25V':'V25(1s)','1HZ50V':'V50(1s)',
  '1HZ75V':'V75(1s)','1HZ100V':'V100(1s)'
};
let _manualMarket   = 'R_75';
let _manualChart    = null;
let _manualChipsInit = false;

function initManualTrade() {
  const MARKETS = window.QuantCore?.MARKETS_CFG || {};
  const chips   = document.getElementById('manualChips');
  if (!chips) return;

  if (!_manualChipsInit) {
    _manualChipsInit = true;
    for (const sym in MARKETS) {
      const chip = document.createElement('div');
      chip.className = 'asset-chip' + (sym === _manualMarket ? ' active' : '');
      chip.textContent = MANUAL_SHORT[sym] || sym;
      chip.onclick = () => {
        _manualMarket = sym;
        chips.querySelectorAll('.asset-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        updateManualInfo();
      };
      chips.appendChild(chip);
    }
  }

  const canvas = document.getElementById('manual-tick-chart');
  if (canvas && !_manualChart) {
    _manualChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: '#3b82f6',
          borderWidth: 1.5,
          fill: true,
          backgroundColor: 'rgba(59,130,246,0.08)',
          pointRadius: 0,
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { display: false, grace: '5%' }
        }
      }
    });
  }

  updateManualInfo();
}

function updateManualInfo() {
  const state   = window.QuantCore?.getGlobalState() || {};
  const m       = state.marketMetrics?.[_manualMarket] || null;
  const MARKETS = window.QuantCore?.MARKETS_CFG || {};

  _setText('manual-asset-name', MARKETS[_manualMarket] || _manualMarket);
  _setText('manual-price',  m ? (m.formattedPrice || Number(m.price || 0).toFixed(4)) : '—');
  _setText('mm-support',    m?.support    ? Number(m.support).toFixed(2)    : '—');
  _setText('mm-resistance', m?.resistance ? Number(m.resistance).toFixed(2) : '—');
  _setText('mm-rise',       m?.risePct !== undefined ? Number(m.risePct).toFixed(1) + '%' : '—');
  _setText('mm-fall',       m?.fallPct !== undefined ? Number(m.fallPct).toFixed(1) + '%' : '—');
  _setText('mm-rsi',        m?.rsi        !== undefined ? Number(m.rsi).toFixed(1)     : '—');
  _setText('mm-vol',        m?.volatility !== undefined ? Number(m.volatility).toFixed(2) + '%' : '—');

  const rsiEl = document.getElementById('mm-rsi');
  if (rsiEl && m?.rsi !== undefined) {
    rsiEl.className = 'mm-val' + (m.rsi > 70 ? ' red' : m.rsi < 30 ? ' green' : '');
  }

  if (_manualChart && m?.lastPrices?.length) {
    const prices = m.lastPrices.slice(-40);
    _manualChart.data.labels          = prices.map((_, i) => i);
    _manualChart.data.datasets[0].data = prices;
    _manualChart.update('none');
  }
}

function fireMobileManual(direction) {
  const stake    = parseFloat(document.getElementById('m-stake-input')?.value) || 0.35;
  const duration = parseInt(document.getElementById('m-dur-input')?.value)     || 7;
  const unit     = document.getElementById('m-unit-input')?.value              || 't';

  if (typeof fireManual === 'function') {
    fireManual(direction, { symbol: _manualMarket, stake, duration, durationUnit: unit });
  } else {
    const prices = window.QuantCore?.getCurrentMarketPrices();
    const price  = prices ? prices[_manualMarket] : null;
    fetch('/api/trade/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contractType: direction,
        symbol: _manualMarket,
        stake,
        duration,
        durationUnit: unit,
        ...(price !== null && { price })
      })
    });
  }
}

// ============================================================
// BOT CARD SYNC
// ============================================================
function _syncBotCard(state) {
  const badge = document.getElementById('bot-status-badge');
  if (!badge) return;

  const controlOverride = window._botControlOverride;
  if (controlOverride === 'stopped') {
    if (state.active) {
      // A delayed SSE packet from before a successful Stop must not visually
      // re-arm the controls. Keep the accepted server response authoritative
      // until the matching inactive snapshot arrives.
      state = {
        ...state,
        active: false,
        lifecycleStatus: 'stopped',
        lifecycleReason: 'Bot stopped by user; waiting for state stream confirmation.'
      };
    } else {
      window._botControlOverride = null;
    }
  }

  const isVirtual = state.executionMode === 'virtual';
  const lifecycle = state.lifecycleStatus || (!state.active ? 'idle' : 'armed');
  if (state.virtualTrade) {
    badge.textContent = 'VIRTUAL';
    badge.className   = 'bot-status-badge virtual';
  } else if (state.tradeInProgress) {
    badge.textContent = 'TRADING';
    badge.className   = 'bot-status-badge running';
  } else if (lifecycle === 'recovering' ||
             ['connecting', 'disconnected', 'recovering'].includes(state.connectionState)) {
    badge.textContent = 'RECOVERING';
    badge.className = 'bot-status-badge recovering';
  } else if (state.active) {
    badge.textContent = isVirtual ? 'VIRTUAL' : 'REAL ARMED';
    badge.className   = isVirtual ? 'bot-status-badge virtual' : 'bot-status-badge armed';
  } else {
    badge.textContent = lifecycle === 'completed' ? 'COMPLETE' : lifecycle === 'stopped' ? 'STOPPED' : 'IDLE';
    badge.className   = `bot-status-badge ${lifecycle === 'completed' ? 'complete' : 'idle'}`;
  }

  // Sync start/stop button visual state via dashboard.js helper
  if (typeof window._setBotButtonState === 'function') {
    const nonRunningLifecycle = ['idle', 'stopped', 'paused', 'completed'];
    if (!state.active || nonRunningLifecycle.includes(lifecycle)) {
      window._setBotButtonState('idle');
    } else if (lifecycle === 'recovering' || ['connecting', 'disconnected', 'recovering'].includes(state.connectionState)) {
      window._setBotButtonState('recovering');
    } else {
      window._setBotButtonState('armed');
    }
  }

  _setText('bot-lifecycle-status', lifecycle.toUpperCase());
  _setText('bot-lifecycle-reason', state.lifecycleReason || 'No lifecycle reason available.');
  const connection = state.connectionState || 'disconnected';
  _setText('bot-connection-status', connection.toUpperCase());
  const heartbeat = state.lastHeartbeatAt ? new Date(state.lastHeartbeatAt).toLocaleTimeString() : 'No heartbeat yet';
  _setText('bot-heartbeat', connection === 'connected' ? `Last heartbeat ${heartbeat}` : `${state.connectionReason || 'Connection unavailable'}`);

  const pnl = v => '$' + Number(v || 0).toFixed(2);

  const sp = document.getElementById('bot-session-pnl');
  if (sp) {
    sp.textContent = pnl(state.sessionPnl);
    sp.style.color = (state.sessionPnl || 0) >= 0 ? 'var(--green-profit)' : 'var(--red-loss)';
  }

  const dp = document.getElementById('bot-daily-pnl');
  if (dp) {
    dp.textContent = pnl(state.dailyPnl);
    dp.style.color = (state.dailyPnl || 0) >= 0 ? 'var(--green-profit)' : 'var(--red-loss)';
  }

  // Runs counter (e.g. "3 / 20") — use cached max_runs
  const runsEl = document.getElementById('bot-runs');
  if (runsEl) {
    const count = state.sessionTradeCount || 0;
    const mr    = window._cachedMaxRuns   || 0;
    runsEl.textContent = count + ' / ' + (mr > 0 ? mr : '—');
    runsEl.style.color = (mr > 0 && count >= mr) ? 'var(--orange-warn)' : '';
  }

  const modeEl = document.getElementById('bot-execution-mode');
  if (modeEl) {
    modeEl.textContent = state.active ? (isVirtual ? 'VIRTUAL' : 'REAL') : 'IDLE';
    modeEl.className = state.active && isVirtual ? 'virtual-mode' : (state.active ? 'real-mode' : '');
  }
  const streakEl = document.getElementById('bot-virtual-streak');
  if (streakEl) {
    const threshold = window._cachedVirtualLossThreshold || 4;
    streakEl.textContent = (state.virtualLossStreak || 0) + ' / ' + threshold;
    streakEl.style.color = (state.virtualLossStreak || 0) >= threshold
      ? 'var(--green-profit)' : '';
  }
  const virtualCountEl = document.getElementById('bot-virtual-count');
  if (virtualCountEl) virtualCountEl.textContent = state.virtualTradeCount || 0;
}

// ============================================================
// MOBILE HOME EQUITY CHART (default to 1W)
// ============================================================
let mobileEquityChart = null;
let mobileAssetChart = null;

function renderMobileHomeCharts(data) {
  const utils = window.QuantCoreChartUtils;
  const chartAvailable = typeof Chart === 'function';
  const model = utils
    ? utils.buildEquityModel(data?.equityData || [], { width: document.getElementById('mobile-equity-chart')?.clientWidth || 360, timeframe: window._homeTimeframe || '1w' })
    : { points: data?.equityData || [], labels: [], scale: { min: -1, max: 1 }, hasData: false, isSinglePoint: false };
  const ctx = document.getElementById('mobile-equity-chart');
  if (ctx) {
    if (mobileEquityChart) mobileEquityChart.destroy();
    if (model.hasData && chartAvailable) {
      const values = model.points.map(point => point.equity);
      const first = values[0];
      const last = values.at(-1);
      const lineColor = last >= first ? '#10b981' : '#ef4444';
      mobileEquityChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: model.points.map((_, index) => index),
          datasets: [
            {
              label: 'Equity',
              data: values,
              borderColor: lineColor,
              backgroundColor: last >= first ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
              fill: true, tension: 0.25, pointRadius: model.isSinglePoint ? 3 : 0,
              pointBackgroundColor: lineColor, borderWidth: 2
            },
            {
              label: 'Zero',
              data: model.points.map(() => 0),
              borderColor: 'rgba(148,163,184,0.55)',
              borderDash: [4, 4], borderWidth: 1, pointRadius: 0, fill: false
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: context => ` ${context.dataset.label}: ${context.parsed.y >= 0 ? '+' : '-'}$${Math.abs(context.parsed.y).toFixed(2)}` } }
          },
          scales: {
            x: {
              type: 'linear', min: 0, max: Math.max(1, model.points.length - 1),
              grid: { display: false }, ticks: {
                maxTicksLimit: 6, autoSkip: true, maxRotation: 0,
                callback: value => model.labels[Math.round(value)] || ''
              }
            },
            y: {
              min: model.scale.min, max: model.scale.max, beginAtZero: true,
              ticks: { callback: value => `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}` }
            }
          }
        }
      });
    }
  }

  const emptyEl = document.getElementById('perf-empty');
  if (emptyEl) {
    emptyEl.textContent = model.isSinglePoint ? 'One trade recorded — trend needs more points' : 'No trade history yet';
    emptyEl.style.display = model.hasData ? (model.isSinglePoint ? 'flex' : 'none') : 'flex';
  }

  const assetCtx = document.getElementById('mobile-asset-perf-chart');
  if (assetCtx) {
    if (mobileAssetChart) mobileAssetChart.destroy();
    const assets = Array.isArray(data?.assetContributions) ? data.assetContributions.filter(a => Number.isFinite(Number(a.pnl))) : [];
    const hasAssets = assets.length > 0;
    if (hasAssets && chartAvailable) {
      const labels = assets.map(a => window.QuantCore?.getAssetLabel(a.name, true) || a.name);
      const values = assets.map(a => Number(a.pnl));
      const maxAbs = Math.max(0.05, ...values.map(value => Math.abs(value)));
      mobileAssetChart = new Chart(assetCtx, {
        type: 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: values.map(v => v >= 0 ? '#10b981' : '#ef4444'), borderRadius: 3, barThickness: 12 }] },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { min: -maxAbs * 1.15, max: maxAbs * 1.15, ticks: { callback: value => `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}` } },
            y: { ticks: { autoSkip: false, font: { size: 9 } } }
          }
        }
      });
    }
    const assetEmpty = document.getElementById('asset-perf-empty');
    if (assetEmpty) assetEmpty.style.display = hasAssets ? 'none' : 'flex';
  }
}

function loadMobileHomeData() {
  if (window.innerWidth > 768) return; // only on mobile

  const account = window.QuantCore?.getGlobalState()?.tradingMode || 'demo';

  fetch(`/api/ledger/aggregated?mode=1w&account=${account}`)
    .then(r => r.json())
    .then(data => {
      // Update summary stats
      _setText('home-pnl', (data.totalProfit || 0) >= 0 ? '+$' + (data.totalProfit || 0).toFixed(2) : '-$' + Math.abs(data.totalProfit || 0).toFixed(2));
      _setText('home-wr', (data.strikeRate || 0).toFixed(1) + '%');
      _setText('home-trades', data.tradeCount || 0);

      window._homeTimeframe = '1w';
      renderMobileHomeCharts(data);
    })
    .catch(err => {
      console.error('Failed to load mobile home data:', err);
      renderMobileHomeCharts({ equityData: [], assetContributions: [] });
    });
}

// Mobile home timeframe buttons (1W / 1M)
function setHomeTf(btn, mode) {
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const map = { '1W': '1w', '1M': '1m' };
  const apiMode = map[mode] || 'session';
  const account = window.QuantCore?.getGlobalState()?.tradingMode || 'demo';

  fetch(`/api/ledger/aggregated?mode=${apiMode}&account=${account}`)
    .then(r => r.json())
    .then(data => {
      window._homeTimeframe = apiMode;
      _setText('home-pnl', (data.totalProfit||0) >= 0 ? '+$' + (data.totalProfit||0).toFixed(2) : '-$' + Math.abs(data.totalProfit||0).toFixed(2));
      _setText('home-wr', (data.strikeRate||0).toFixed(1) + '%');
      _setText('home-trades', data.tradeCount || 0);

      renderMobileHomeCharts(data);
    })
    .catch(err => console.error('Failed to load mobile timeframe:', err));
}
window.setHomeTf = setHomeTf;

// ============================================================
// BOT DAILY P&L – fetch from Supabase and display on bot card
// ============================================================
function loadBotDailyPnl() {
  const account = window.QuantCore?.getGlobalState()?.tradingMode || 'demo';
  fetch(`/api/ledger/aggregated?mode=24h&account=${account}`)
    .then(r => r.json())
    .then(data => {
      const dp = document.getElementById('bot-daily-pnl');
      if (dp) {
        const pnl = data.totalProfit || 0;
        dp.textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
        dp.style.color = pnl >= 0 ? 'var(--green-profit)' : 'var(--red-loss)';
      }
    })
    .catch(err => console.error('Failed to load bot daily P&L:', err));
}

// ============================================================
// BOT RESET COUNTDOWN
// ============================================================
setInterval(() => {
  const resetTime = window.QuantCore?.getGlobalState()?.botResetTime;
  const el = document.getElementById('bot-reset-countdown');
  if (!el) return;
  if (resetTime) {
    const remaining = Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
    const hours = Math.floor(remaining / 3600);
    const mins = Math.floor((remaining % 3600) / 60);
    const secs = remaining % 60;
    el.textContent = `${hours}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  } else {
    el.textContent = '--';
  }
}, 1000);
