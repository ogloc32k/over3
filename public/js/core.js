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

  const pageId = tabId;

  // Deactivate all tab pages, drawer items, and header tabs
  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.drawer-nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.header-tabs .nav-tab').forEach(b => b.classList.remove('active'));

  // Activate the resolved page
  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');

  // Highlight the originally-clicked button (not the resolved pageId)
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

  // Lazy-render tabs
  if (isMobile && tabId === 'tab-markets' && typeof renderMobileMarkets === 'function') renderMobileMarkets();
  if (tabId === 'tab-manual' && typeof initManualTrade === 'function') initManualTrade();

  // Focus bar: hide on analytics, visible on everything else
  const focusBar = document.getElementById('focusBar');
  if (focusBar) {
    focusBar.style.display = (tabId === 'tab-analytics') ? 'none' : '';
  }

  // Body classes for sidebar behaviour
  const body = document.body;
  body.classList.remove('analytics-active', 'dashboard-active');
  if (tabId === 'tab-analytics') {
    body.classList.add('analytics-active');
    const sidebar = document.getElementById('appSidebar');
    if (sidebar) sidebar.classList.add('collapsed');
    const toggle = document.getElementById('sidebarToggleFixed');
    if (toggle) toggle.textContent = '▶';
  } else if (tabId === 'tab-dashboard' || tabId === 'tab-home') {
    body.classList.add('dashboard-active');
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

  console.log('🚀 QUANTCORE Terminal v6.0 loaded');
});

// ============================================================
// HOME + DRAWER SYNC
// Called from core.js SSE handler after renderUI()
// ============================================================
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
    const risePct = m?.risePct    !== undefined ? Math.round(m.risePct) + '%'  : '—';
    const fallPct = m?.fallPct    !== undefined ? Math.round(m.fallPct) + '%'  : '—';

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
// MANUAL TRADE (mobile)
// ============================================================
const MANUAL_SHORT = {
  'R_10':'V10','R_25':'V25','R_50':'V50','R_75':'V75','R_100':'V100',
  '1HZ10V':'V10(1s)','1HZ25V':'V25(1s)','1HZ50V':'V50(1s)',
  '1HZ75V':'V75(1s)','1HZ100V':'V100(1s)'
};
let _manualMarket    = 'R_75';
let _manualChart     = null;
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
  _setText('mm-rise',       m?.risePct    !== undefined ? Math.round(m.risePct) + '%'  : '—');
  _setText('mm-fall',       m?.fallPct    !== undefined ? Math.round(m.fallPct) + '%'  : '—');
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
    // Fallback: direct fetch if fireManual is not available
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
  if (dp) { dp.textContent = pnl(state.dailyPnl);   dp.style.color = (state.dailyPnl   || 0) >= 0 ? 'var(--green-profit)' : 'var(--red-loss)'; }
  if (rk) rk.textContent = pnl(state.currentStake);
}
