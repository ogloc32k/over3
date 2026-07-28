// ============================================================
// app.js – Orchestrator: DOM ready, tab switching, theme, sidebar, clock
// ============================================================
document.addEventListener('DOMContentLoaded', function () {
  console.log('DOMContentLoaded fired');

  // ---- Tab switching ----
  window.switchTab = function (tabId) {
    console.log('[switchTab] called with:', tabId);
    if (!tabId) return;

    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    document.querySelectorAll('.tab-page').forEach(page => {
      page.classList.toggle('active', page.id === tabId);
    });

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

    const focusBar = document.getElementById('focusBar');
    if (focusBar) {
      focusBar.style.display = (tabId === 'tab-analytics') ? 'none' : 'flex';
    }

    const body = document.body;
    body.classList.remove('analytics-active', 'dashboard-active');
    if (tabId === 'tab-analytics') {
      body.classList.add('analytics-active');
      const sidebar = document.getElementById('appSidebar');
      if (sidebar) sidebar.classList.add('collapsed');
      const toggle = document.getElementById('sidebarToggleFixed');
      if (toggle) toggle.textContent = '▶';
    } else if (tabId === 'tab-dashboard') {
      body.classList.add('dashboard-active');
    }
  };

  // ---- Event listeners for tab buttons ----
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      const tabId = this.dataset.tab;
      if (tabId && typeof window.switchTab === 'function') {
        window.switchTab(tabId);
      } else {
        console.warn('Tab click failed: tabId=' + tabId);
      }
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
  QuantCore.connectSSE();

  // Initial empty UI render
  QuantCore.renderUI({});

  console.log('🚀 QUANTCORE Terminal v6.0 loaded');
});
