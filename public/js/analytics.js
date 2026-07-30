// ============================================================
// analytics.js – Charts, metrics, timeframe presets
// ============================================================
(function () {
  let assetBarChart = null;
  let equityChartInstance = null;
  let currentAnalyticsData = null;

  const barValueLabelPlugin = {
    id: 'barValueLabel',
    afterDraw: function (chart) {
      const ctx = chart.ctx;
      chart.data.datasets.forEach(function (dataset, i) {
        const meta = chart.getDatasetMeta(i);
        if (!meta || !meta.data) return;
        meta.data.forEach(function (element, index) {
          const value = dataset.data[index];
          if (value === undefined || value === null) return;
          const x = element.x;
          const y = element.y;
          const text = (value >= 0 ? '+' : '') + '$' + value.toFixed(2);
          ctx.save();
          ctx.font = '8px Inter, sans-serif';
          ctx.textAlign = value >= 0 ? 'left' : 'right';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = value >= 0 ? '#10b981' : '#ef4444';
          const offset = value >= 0 ? 6 : -6;
          ctx.fillText(text, x + offset, y);
          ctx.restore();
        });
      });
    }
  };

  function renderCharts() {
    try {
      const isMobile = window.innerWidth < 768;
      const ctxBar = document.getElementById('chart-donut')?.getContext('2d');
      const ctxLine = document.getElementById('chart-line')?.getContext('2d');
      if (!ctxBar || !ctxLine) return;

      if (assetBarChart) assetBarChart.destroy();
      assetBarChart = new Chart(ctxBar, {
        type: 'bar',
        data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: [], borderWidth: 0, borderRadius: 4 }] },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (context) { return (context.parsed.x >= 0 ? '+' : '') + '$' + context.parsed.x.toFixed(2); } } } },
          scales: {
            x: { grid: { display: isMobile ? false : true }, ticks: { display: isMobile ? false : true, callback: function (v) { return (v >= 0 ? '+' : '') + '$' + v.toFixed(2); } } },
            y: { grid: { display: false }, ticks: { font: { size: isMobile ? 8 : 9 }, color: '#d1d5db' }, afterFit: function (scale) { if (window.innerWidth < 768) scale.width = 70; else scale.width = 120; } }
          }
        },
        plugins: [barValueLabelPlugin]
      });

      if (equityChartInstance) { equityChartInstance.destroy(); equityChartInstance = null; }
      equityChartInstance = new Chart(ctxLine, {
        type: 'line',
        data: { datasets: [{ label: 'Equity', data: [], borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 10, borderWidth: 2, pointBackgroundColor: '#10b981' }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (context) { return 'Balance: ' + (context.parsed.y >= 0 ? '+$' : '-$') + Math.abs(context.parsed.y).toFixed(2); } } } },
          scales: {
            x: { type: 'category', grid: { display: false }, ticks: { font: { size: 7 }, maxTicksLimit: window.innerWidth < 768 ? 5 : 20, maxRotation: 0, autoSkip: true, color: '#9ca3af' } },
            y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 7 }, color: '#9ca3af', callback: function (v) { return (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2); } } }
          }
        }
      });
    } catch (e) { console.error('renderCharts error:', e); }
  }

  // Helper: hide all chart empty‑state overlays
  function hideAllEmptyStates() {
    document.querySelectorAll('.chart-empty-state').forEach(el => el.style.display = 'none');
  }

  function renderAssetBarChart(contributions) {
    if (!assetBarChart) return;
    try {
      hideAllEmptyStates();
      const isMobile = window.innerWidth < 768;
      const labels = contributions.map(a => QuantCore.getAssetLabel(a.name, isMobile));
      const values = contributions.map(a => a.pnl);
      const colors = values.map(v => v >= 0 ? '#10b981' : '#ef4444');
      const maxAbs = values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
      const buffer = maxAbs * 0.15;
      assetBarChart.data.labels = labels;
      assetBarChart.data.datasets[0].data = values;
      assetBarChart.data.datasets[0].backgroundColor = colors;
      assetBarChart.data.datasets[0].borderColor = colors;
      assetBarChart.options.scales.x.suggestedMin = -(maxAbs + buffer);
      assetBarChart.options.scales.x.suggestedMax = maxAbs + buffer;
      assetBarChart.update('none');
    } catch (e) { console.error('renderAssetBarChart error:', e); }
  }

  function formatEquityLabel(timestamp, timeframe) {
    const date = new Date(timestamp);
    if (timeframe === '24h' || timeframe === 'session' || timeframe === 'custom') {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function renderEquityCurve(equityData, startingBalance, timeframe) {
    if (!equityChartInstance) return;
    try {
      hideAllEmptyStates();
      if (!equityData || equityData.length < 2) {
        equityChartInstance.data.labels = [];
        equityChartInstance.data.datasets[0].data = [];
        equityChartInstance.update('none');
        return;
      }
      const labels = equityData.map(p => formatEquityLabel(p.timestamp, timeframe));
      const values = equityData.map(p => p.equity);
      equityChartInstance.data.labels = labels;
      equityChartInstance.data.datasets[0].data = values;
      equityChartInstance.update('none');
    } catch (e) { console.error('renderEquityCurve error:', e); }
  }

  function updateMetrics(data) {
    try {
      const profit = data.totalProfit || 0;
      const total = data.tradeCount || 0;
      const wins = data.winCount || 0;
      const losses = data.lossCount || 0;
      document.getElementById('meta-profit').textContent = (profit >= 0 ? '+$' : '-$') + Math.abs(profit).toFixed(2);
      document.getElementById('meta-strike').innerHTML = `${(data.strikeRate||0).toFixed(1)}% <small style="display:block;font-size:8px;color:#787b86;">${total} trades total</small>`;
      document.getElementById('meta-pf').textContent = typeof data.profitFactor === 'number' ? data.profitFactor.toFixed(2) : data.profitFactor;
      document.getElementById('meta-dd').textContent = `-${(data.maxDrawdown||0).toFixed(2)}%`;
      document.getElementById('meta-avg-win-loss').textContent = `$${(data.avgWin||0).toFixed(2)} / $${(data.avgLoss||0).toFixed(2)}`;
      document.getElementById('meta-max-consec').textContent = `W:${data.maxWinStreak||0} / L:${Math.abs(data.maxLossStreak||0)}`;
      document.getElementById('meta-avg-duration').textContent = `${((data.totalDuration||0)/(total||1)).toFixed(0)}s`;
      document.getElementById('meta-won-lost').textContent = `${wins} / ${losses}`;
    } catch (e) { console.error('updateMetrics error:', e); }
  }

  // ---------- Timeframe preset & custom date handling ----------
  function updateDatePickersForPreset(mode) {
    const now = new Date();
    const startEl = document.getElementById('date-start');
    const endEl = document.getElementById('date-end');
    if (!startEl || !endEl) return;

    const todayStr = now.toISOString().split('T')[0];
    // Restrict future dates
    startEl.setAttribute('max', todayStr);
    endEl.setAttribute('max', todayStr);

    let startDate, endDate;
    switch (mode) {
      case '24h':
        startDate = new Date(now.getTime() - 24*60*60*1000);
        endDate = now;
        break;
      case '1w':
        startDate = new Date(now.getTime() - 7*24*60*60*1000);
        endDate = now;
        break;
      case '1m':
        startDate = new Date(now.getTime() - 30*24*60*60*1000);
        endDate = now;
        break;
      case '1y':
        startDate = new Date(now.getTime() - 365*24*60*60*1000);
        endDate = now;
        break;
      case 'session':
      default:
        // session = today's trades (since midnight)
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endDate = now;
        break;
    }
    const formatDate = (d) => d.toISOString().split('T')[0];
    startEl.value = formatDate(startDate);
    endEl.value = formatDate(endDate);
  }

  // Validate and apply custom date range
  function applyDateFilter() {
    const startEl = document.getElementById('date-start');
    const endEl   = document.getElementById('date-end');
    if (!startEl || !endEl) return;

    const from = new Date(startEl.value);
    const to   = new Date(endEl.value);
    // Swap if reversed
    if (from > to) {
      const tmp = startEl.value;
      startEl.value = endEl.value;
      endEl.value = tmp;
    }
    // Disable preset buttons (no active preset)
    document.querySelectorAll('.preset-strip .btn-preset').forEach(b => b.classList.remove('active'));

    // Fetch with custom start/end
    const params = new URLSearchParams({
      mode: 'custom',
      start: new Date(startEl.value).toISOString(),
      end:   new Date(endEl.value).toISOString()
    });
    fetch(`/api/ledger/aggregated?${params.toString()}`)
      .then(r => r.json())
      .then(data => {
        currentAnalyticsData = data;
        renderAssetBarChart(data.assetContributions || []);
        renderEquityCurve(data.equityData || [], 0, 'custom');
        updateMetrics(data);
      })
      .catch(err => console.error('Custom date filter error:', err));
  }

  window.applyDateFilter = applyDateFilter;   // expose for inline onclick

  window.timeframePreset = async function (btn, mode) {
    // Map human‑friendly names to API mode values
    const modeMap = { 'year': '1y', 'week': '1w', 'month': '1m', '24h': '24h', 'session': 'session' };
    mode = modeMap[mode] || mode;

    // Update the date pickers to reflect the preset
    updateDatePickersForPreset(mode);

    if (btn) {
      document.querySelectorAll('.preset-strip .btn-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
    if (mode === 'clear') {
      renderAssetBarChart([]); renderEquityCurve([], 0);
      document.getElementById('meta-profit').textContent = '$0.00';
      document.getElementById('meta-strike').innerHTML = '0.0% <small>0 trades total</small>';
      document.getElementById('meta-pf').textContent = '0.00';
      document.getElementById('meta-dd').textContent = '0.0%';
      document.getElementById('meta-avg-win-loss').textContent = '$0.00 / $0.00';
      document.getElementById('meta-max-consec').textContent = 'W:0 / L:0';
      document.getElementById('meta-avg-duration').textContent = '0s';
      document.getElementById('meta-won-lost').textContent = '0 / 0';
      return;
    }
    if (!assetBarChart || !equityChartInstance) {
      if (window.Analytics && typeof window.Analytics.renderCharts === 'function') {
        window.Analytics.renderCharts();
      }
    }
    try {
      const resp = await fetch(`/api/ledger/aggregated?mode=${mode}`);
      const data = await resp.json();
      currentAnalyticsData = data;
      const startingBalance = data.equityData?.[0]?.equity || 0;
      renderAssetBarChart(data.assetContributions || []);
      renderEquityCurve(data.equityData || [], startingBalance, mode);
      updateMetrics(data);
    } catch (err) { console.error('Analytics error:', err); }
  };

  window.toggleDatePicker = function () {
    const group = document.getElementById('datePickerGroup');
    if (group) group.style.display = group.style.display === 'none' ? 'flex' : 'none';
  };

  // Initialise date pickers with default (session) and set max attributes
  window.addEventListener('DOMContentLoaded', () => {
    updateDatePickersForPreset('session');
  });

  window.Analytics = {
    renderCharts,
    clearCharts: () => {
      if (assetBarChart) assetBarChart.destroy();
      if (equityChartInstance) equityChartInstance.destroy();
    }
  };

  console.log('📈 analytics.js loaded');
})();
