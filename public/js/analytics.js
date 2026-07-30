// ============================================================
// analytics.js – Charts, metrics, timeframe presets
// ============================================================
(function () {
  let assetBarChart = null;
  let equityChartInstance = null;
  let currentAnalyticsData = null;

  // ---------- Bar value label plugin ----------
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

  // ---------- Chart rendering ----------
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
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (context) {
            const value = context.parsed.x;
            return (value >= 0 ? '+' : '') + '$' + value.toFixed(2);
          } } } },
          scales: {
            x: { grid: { display: isMobile ? false : true }, ticks: { display: isMobile ? false : true, callback: function (value) {
              return (value >= 0 ? '+' : '') + '$' + value.toFixed(2);
            } } },
            y: { grid: { display: false }, ticks: { font: { size: isMobile ? 8 : 9 }, color: '#d1d5db' }, afterFit: function (scale) {
              if (window.innerWidth < 768) scale.width = 70;
              else scale.width = 120;
            } }
          }
        },
        plugins: [barValueLabelPlugin]
      });

      if (equityChartInstance) { equityChartInstance.destroy(); equityChartInstance = null; }
      equityChartInstance = new Chart(ctxLine, {
        type: 'line',
        data: { datasets: [{ label: 'Equity', data: [], borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 10, borderWidth: 2, pointBackgroundColor: '#10b981' }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (context) {
            const value = context.parsed.y;
            return 'Balance: ' + (value >= 0 ? '+$' : '-$') + Math.abs(value).toFixed(2);
          } } } },
          scales: {
            x: { type: 'category', grid: { display: false }, ticks: { font: { size: 7 }, maxTicksLimit: window.innerWidth < 768 ? 5 : 20, maxRotation: 0, autoSkip: true, color: '#9ca3af' } },
            y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 7 }, color: '#9ca3af', callback: function (value) {
              return (value >= 0 ? '+' : '-') + '$' + Math.abs(value).toFixed(2);
            } } }
          }
        }
      });
    } catch (e) { console.error('renderCharts error:', e); }
  }

  function renderAssetBarChart(contributions) {
    if (!assetBarChart) return;
    try {
      const isMobile = window.innerWidth < 768;
      const labels = contributions.map(a => QuantCore.getAssetLabel(a.name, isMobile));
      const values = contributions.map(a => a.pnl);
      const colors = values.map(v => v >= 0 ? '#10b981' : '#ef4444');
      const maxAbs = values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
      const buffer = maxAbs * 0.15;
      const suggestedMax = maxAbs + buffer;
      const suggestedMin = -suggestedMax;

      assetBarChart.data.labels = labels;
      assetBarChart.data.datasets[0].data = values;
      assetBarChart.data.datasets[0].backgroundColor = colors;
      assetBarChart.data.datasets[0].borderColor = colors;
      assetBarChart.options.scales.x = {
        grid: { display: isMobile ? false : true, color: 'rgba(0,0,0,0.05)' },
        ticks: { display: isMobile ? false : true, callback: function (value) {
          return (value >= 0 ? '+' : '') + '$' + value.toFixed(2);
        } },
        suggestedMin: suggestedMin,
        suggestedMax: suggestedMax
      };
      assetBarChart.update('none');
    } catch (e) { console.error('renderAssetBarChart error:', e); }
  }

  function formatEquityLabel(timestamp, timeframe) {
    const date = new Date(timestamp);
    if (timeframe === '24h' || timeframe === 'hour' || timeframe === 'session') {
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return hours + ':' + minutes;
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  }

  function showChartEmptyState(containerId, message) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let empty = container.parentElement?.querySelector('.chart-empty-state');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'chart-empty-state';
      empty.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:13px;text-align:center;padding:20px;';
      container.parentElement.style.position = 'relative';
      container.parentElement.appendChild(empty);
    }
    empty.textContent = message || 'No trade history recorded for this period';
    container.style.display = 'none';
  }

  function hideChartEmptyState(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.style.display = 'block';
    const parent = container.parentElement;
    if (parent) {
      const empty = parent.querySelector('.chart-empty-state');
      if (empty) empty.remove();
    }
  }

  function renderEquityCurve(equityData, startingBalance, timeframe) {
    if (!equityChartInstance) return;
    try {
      if (!equityData || equityData.length < 2) {
        showChartEmptyState('chart-line', 'No trade history recorded for this period');
        equityChartInstance.data.labels = [];
        equityChartInstance.data.datasets[0].data = [];
        equityChartInstance.update('none');
        return;
      }
      hideChartEmptyState('chart-line');

      const labels = equityData.map(point => formatEquityLabel(point.timestamp, timeframe));
      const values = equityData.map(point => point.equity);
      const baseline = startingBalance || 0;
      const lastValue = values.length > 0 ? values[values.length - 1] : baseline;
      const isAbove = lastValue >= baseline;
      const lineColor = isAbove ? '#10b981' : '#ef4444';
      const fillColor = isAbove ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';

      equityChartInstance.data.labels = labels;
      equityChartInstance.data.datasets[0].data = values;
      equityChartInstance.data.datasets[0].borderColor = lineColor;
      equityChartInstance.data.datasets[0].backgroundColor = fillColor;
      equityChartInstance.data.datasets[0].pointBackgroundColor = lineColor;

      const baselineData = [baseline, baseline];
      equityChartInstance.data.datasets[1] = {
        label: 'Start',
        data: baselineData,
        borderColor: 'rgba(100,116,139,0.4)',
        borderDash: [5, 5],
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        tension: 0
      };

      while (equityChartInstance.data.datasets.length > 2) {
        equityChartInstance.data.datasets.pop();
      }
      equityChartInstance.update('none');
    } catch (e) { console.error('renderEquityCurve error:', e); }
  }

  // UPDATED: now reads real fields from backend
  function updateMetrics(data) {
    try {
      const totalProfit = data.totalProfit || 0;
      const tradeCount = data.tradeCount || 0;
      const winCount = data.winCount || 0;
      const lossCount = data.lossCount || 0;
      const strikeRate = data.strikeRate || 0;
      const profitFactor = data.profitFactor || 0;
      const maxDrawdown = data.maxDrawdown || 0;
      const avgWin = data.avgWin || 0;
      const avgLoss = data.avgLoss || 0;
      const maxWinStreak = data.maxWinStreak || 0;
      const maxLossStreak = Math.abs(data.maxLossStreak || 0);
      const avgDuration = data.totalDuration ? (data.totalDuration / (tradeCount || 1)) : 0;

      const profitEl = document.getElementById('meta-profit');
      if (profitEl) profitEl.textContent = (totalProfit >= 0 ? '+$' : '-$') + Math.abs(totalProfit).toFixed(2);

      const strikeEl = document.getElementById('meta-strike');
      if (strikeEl) strikeEl.innerHTML = `${strikeRate.toFixed(1)}% <small style="display:block;font-size:8px;color:#787b86;font-weight:400;">${tradeCount} trades total</small>`;

      const pfEl = document.getElementById('meta-pf');
      if (pfEl) pfEl.textContent = typeof profitFactor === 'number' ? profitFactor.toFixed(2) : profitFactor;

      const ddEl = document.getElementById('meta-dd');
      if (ddEl) ddEl.textContent = `-${maxDrawdown.toFixed(2)}%`;

      const avgEl = document.getElementById('meta-avg-win-loss');
      if (avgEl) avgEl.textContent = `$${avgWin.toFixed(2)} / $${avgLoss.toFixed(2)}`;

      const maxConsecEl = document.getElementById('meta-max-consec');
      if (maxConsecEl) maxConsecEl.textContent = `W:${maxWinStreak} / L:${maxLossStreak}`;

      const avgDurEl = document.getElementById('meta-avg-duration');
      if (avgDurEl) avgDurEl.textContent = `${avgDuration.toFixed(0)}s`;

      const wonLostEl = document.getElementById('meta-won-lost');
      if (wonLostEl) wonLostEl.textContent = `${winCount} / ${lossCount}`;
    } catch (e) { console.error('updateMetrics error:', e); }
  }

  // ---------- Delta handler (called on SSE event) ----------
  function handleAnalyticsDelta(delta) {
    if (!currentAnalyticsData) return;
    const asset = delta.asset || 'Unknown';
    const pnl = delta.pnl || 0;
    const assetMap = {};
    currentAnalyticsData.assetContributions.forEach(a => { assetMap[a.name] = a.pnl; });
    assetMap[asset] = (assetMap[asset] || 0) + pnl;
    currentAnalyticsData.assetContributions = Object.entries(assetMap)
      .map(([name, pnl]) => ({ name, pnl }))
      .sort((a, b) => b.pnl - a.pnl);

    if (currentAnalyticsData.equityData) {
      const lastEquity = currentAnalyticsData.equityData.length > 0 ?
        currentAnalyticsData.equityData[currentAnalyticsData.equityData.length - 1].equity : 0;
      const newEquity = lastEquity + pnl;
      currentAnalyticsData.equityData.push({
        timestamp: delta.timestamp || Date.now(),
        equity: newEquity
      });
      if (currentAnalyticsData.equityData.length > 200) {
        currentAnalyticsData.equityData = currentAnalyticsData.equityData.slice(-200);
      }
    }
    currentAnalyticsData.totalProfit += pnl;
    currentAnalyticsData.tradeCount += 1;
    if (pnl > 0) {
      currentAnalyticsData.winCount += 1;
      currentAnalyticsData.grossProfit += pnl;
    } else if (pnl < 0) {
      currentAnalyticsData.lossCount += 1;
      currentAnalyticsData.grossLoss += Math.abs(pnl);
    }

    renderAssetBarChart(currentAnalyticsData.assetContributions);
    renderEquityCurve(currentAnalyticsData.equityData, currentAnalyticsData.startingBalance || 0, currentAnalyticsData.timeframe || 'session');
    updateMetrics(currentAnalyticsData);
  }

  // ---------- Timeframe preset (global) ----------
  function updateDatePickersForPreset(mode) {
    const now = new Date();
    const startEl = document.getElementById('date-start');
    const endEl = document.getElementById('date-end');
    if (!startEl || !endEl) return;
    let startDate, endDate;
    switch (mode) {
      case '24h': startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); endDate = now; break;
      case '1w': startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); endDate = now; break;
      case '1m': startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); endDate = now; break;
      case '1y': startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); endDate = now; break;
      default: return;
    }
    const formatDate = (d) => d.toISOString().split('T')[0];
    startEl.value = formatDate(startDate);
    endEl.value = formatDate(endDate);
  }

  window.timeframePreset = async function (btn, mode) {
    if (btn) {
      document.querySelectorAll('.preset-strip .btn-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
    if (mode === 'clear') {
      renderAssetBarChart([]);
      renderEquityCurve([], 0);
      document.getElementById('meta-profit').textContent = '$0.00';
      document.getElementById('meta-strike').innerHTML = '0.0% <small style="display:block;font-size:8px;color:#787b86;">0 trades total</small>';
      document.getElementById('meta-pf').textContent = '0.00';
      document.getElementById('meta-dd').textContent = '0.0%';
      document.getElementById('meta-avg-win-loss').textContent = '$0.00 / $0.00';
      document.getElementById('meta-max-consec').textContent = 'W:0 / L:0';
      document.getElementById('meta-avg-duration').textContent = '0s';
      document.getElementById('meta-won-lost').textContent = '0 / 0';
      return;
    }
    updateDatePickersForPreset(mode);
    try {
      const resp = await fetch(`/api/ledger/aggregated?mode=${mode}`);
      const data = await resp.json();
      currentAnalyticsData = data;
      currentAnalyticsData.timeframe = mode;
      const startingBalance = data.equityData && data.equityData.length > 0 ? data.equityData[0].equity : 0;
      currentAnalyticsData.startingBalance = startingBalance;
      renderAssetBarChart(data.assetContributions || []);
      renderEquityCurve(data.equityData || [], startingBalance, mode);
      updateMetrics(data);
    } catch (err) {
      console.error('Analytics error:', err);
    }
  };

  window.toggleDatePicker = function () {
    const group = document.getElementById('datePickerGroup');
    if (group) group.style.display = group.style.display === 'none' ? 'flex' : 'none';
  };

  // Listen for live deltas from SSE
  QuantCore.eventBus.on('analytics_delta', handleAnalyticsDelta);

  // Expose for app.js to call on tab switch
  window.Analytics = {
    renderCharts,
    handleDelta: handleAnalyticsDelta,
    clearCharts: () => {
      if (assetBarChart) assetBarChart.destroy();
      if (equityChartInstance) equityChartInstance.destroy();
    }
  };

  console.log('📈 analytics.js loaded');
})();
