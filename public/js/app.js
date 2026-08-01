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
  if (tabId === 'tab-settings') {
    if (typeof window.loadConfig === 'function') window.loadConfig();
  }
  if (tabId === 'tab-logs') {
    if (typeof window.scrollLogsToBottom === 'function') window.scrollLogsToBottom();
  }
  if (tabId === 'tab-bots' && typeof loadBotDailyPnl === 'function') {
    loadBotDailyPnl();
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
      const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'Africa/Nairobi', hour12: false });
      const clockEl = document.getElementById('clock-display');
      if (clockEl) clockEl.textContent = timeStr;
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
  _setText('home-status', state.active ? 'ARMED' : 'IDLE');

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

  if (state.tradeInProgress) {
    badge.textContent = 'TRADING';
    badge.className   = 'bot-status-badge armed';
  } else if (state.active) {
    badge.textContent = 'ARMED';
    badge.className   = 'bot-status-badge armed';
  } else {
    badge.textContent = 'IDLE';
    badge.className   = 'bot-status-badge idle';
  }

  const sp  = document.getElementById('bot-session-pnl');
  const dp  = document.getElementById('bot-daily-pnl');
  const rk  = document.getElementById('bot-risk');
  const pnl = v => '$' + Number(v || 0).toFixed(2);

  if (sp) { sp.textContent = pnl(state.sessionPnl); sp.style.color = (state.sessionPnl || 0) >= 0 ? 'var(--green-profit)' : 'var(--red-loss)'; }
  // Daily P&L is now fetched from Supabase via loadBotDailyPnl() – don't override it here
  if (rk) rk.textContent = pnl(state.currentStake);
}

// ============================================================
// MOBILE HOME EQUITY CHART (default to 1W, hides empty state when no data)
// ============================================================
let mobileEquityChart = null;

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

      // Equity curve
      const ctx = document.getElementById('mobile-equity-chart');
      if (!ctx) return;
      if (mobileEquityChart) mobileEquityChart.destroy();

      const hasData = (data.equityData && data.equityData.length >= 2);

      if (hasData) {
        const firstEquity = data.equityData[0].equity;
        const lastEquity = data.equityData[data.equityData.length - 1].equity;
        const isUp = lastEquity >= firstEquity;
        const lineColor = isUp ? '#10b981' : '#ef4444';
        const fillColor = isUp ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';

        mobileEquityChart = new Chart(ctx, {
          type: 'line',
          data: {
            datasets: [{
              label: 'Equity',
              data: data.equityData.map(p => ({
                x: new Date(p.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                y: p.equity
              })),
              borderColor: lineColor,
              backgroundColor: fillColor,
              fill: true,
              tension: 0.3,
              pointRadius: 0
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } }
          }
        });
      }

      // Show/hide empty state
      const emptyEl = document.getElementById('perf-empty');
      if (emptyEl) emptyEl.style.display = hasData ? 'none' : 'flex';

      // Asset performance bar chart
      const assetCtx = document.getElementById('mobile-asset-perf-chart');
      if (assetCtx) {
        Chart.getChart(assetCtx)?.destroy();
        const hasAssets = (data.assetContributions && data.assetContributions.length > 0);
        if (hasAssets) {
          new Chart(assetCtx, {
            type: 'bar',
            data: {
              labels: data.assetContributions.map(a => a.name),
              datasets: [{
                data: data.assetContributions.map(a => a.pnl),
                backgroundColor: data.assetContributions.map(a => a.pnl >= 0 ? '#10b981' : '#ef4444'),
                borderColor: data.assetContributions.map(a => a.pnl >= 0 ? '#10b981' : '#ef4444'),
                borderWidth: 0,
                borderRadius: 4
              }]
            },
            options: {
              indexAxis: 'y',
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { callback: val => (val >= 0 ? '+' : '') + '$' + val.toFixed(2) } }
              }
            }
          });
        }
        const assetEmpty = document.getElementById('asset-perf-empty');
        if (assetEmpty) assetEmpty.style.display = hasAssets ? 'none' : 'flex';
      }
    })
    .catch(err => console.error('Failed to load mobile home data:', err));
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
      _setText('home-pnl', (data.totalProfit||0) >= 0 ? '+$' + (data.totalProfit||0).toFixed(2) : '-$' + Math.abs(data.totalProfit||0).toFixed(2));
      _setText('home-wr', (data.strikeRate||0).toFixed(1) + '%');
      _setText('home-trades', data.tradeCount || 0);

      if (mobileEquityChart) { mobileEquityChart.destroy(); mobileEquityChart = null; }
      const ctx = document.getElementById('mobile-equity-chart');
      if (ctx) {
        const hasData = (data.equityData && data.equityData.length >= 2);
        if (hasData) {
          const firstEquity = data.equityData[0].equity;
          const lastEquity = data.equityData[data.equityData.length - 1].equity;
          const isUp = lastEquity >= firstEquity;
          const lineColor = isUp ? '#10b981' : '#ef4444';
          const fillColor = isUp ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';

          mobileEquityChart = new Chart(ctx, {
            type: 'line',
            data: {
              datasets: [{
                label: 'Equity',
                data: data.equityData.map(p => ({
                  x: new Date(p.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                  y: p.equity
                })),
                borderColor: lineColor,
                backgroundColor: fillColor,
                fill: true,
                tension: 0.3,
                pointRadius: 0
              }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
          });
        }
        const emptyEl = document.getElementById('perf-empty');
        if (emptyEl) emptyEl.style.display = hasData ? 'none' : 'flex';
      }

      const assetCtx = document.getElementById('mobile-asset-perf-chart');
      if (assetCtx) {
        Chart.getChart(assetCtx)?.destroy();
        const hasAssets = (data.assetContributions && data.assetContributions.length > 0);
        if (hasAssets) {
          new Chart(assetCtx, {
            type: 'bar',
            data: {
              labels: data.assetContributions.map(a => a.name),
              datasets: [{
                data: data.assetContributions.map(a => a.pnl),
                backgroundColor: data.assetContributions.map(a => a.pnl >= 0 ? '#10b981' : '#ef4444')
              }]
            },
            options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
          });
        }
        const assetEmpty = document.getElementById('asset-perf-empty');
        if (assetEmpty) assetEmpty.style.display = hasAssets ? 'none' : 'flex';
      }
    });
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
