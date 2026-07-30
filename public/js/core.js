// ============================================================
// core.js – Shared state, SSE, rendering engine, utilities
// ============================================================
(function () {
  // ---------- Constants ----------
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

  // ---------- Event bus ----------
  const eventBus = {
    _handlers: {},
    on(evt, fn) { (this._handlers[evt] = this._handlers[evt] || []).push(fn); },
    emit(evt, data) { (this._handlers[evt] || []).forEach(fn => fn(data)); }
  };

  // ---------- Private state ----------
  let currentFocus = 'R_75';
  let globalState = null;
  let serverMode = 'demo';
  let currentMarketPrices = {};
  let sse = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;

  // ---------- Utility functions ----------
  function formatPrice(symbol, raw) {
    if (raw === undefined || raw === null) return '—';
    const dec = MARKET_DECIMALS[symbol] || 2;
    return Number(raw).toFixed(dec);
  }

  function getAssetLabel(name, isMobile) {
    if (!isMobile) return name;
    const shortMap = {
      'Volatility 10 Index': 'V10',
      'Volatility 25 Index': 'V25',
      'Volatility 50 Index': 'V50',
      'Volatility 75 Index': 'V75',
      'Volatility 100 Index': 'V100',
      'Volatility 10 (1s) Index': 'V10 (1s)',
      'Volatility 25 (1s) Index': 'V25 (1s)',
      'Volatility 50 (1s) Index': 'V50 (1s)',
      'Volatility 75 (1s) Index': 'V75 (1s)',
      'Volatility 100 (1s) Index': 'V100 (1s)'
    };
    return shortMap[name] || name;
  }

  // ---------- Render engine ----------
  let lastRenderTime = 0;
  function renderUI(state) {
    const now = Date.now();
    if (now - lastRenderTime < 250) return;
    lastRenderTime = now;

    try {
      const safeState = state || {};
      const tradingMode = safeState.tradingMode || 'demo';
      const balance = safeState.balance ?? null;
      const sessionPnl = safeState.sessionPnl || 0;
      const dailyPnl = safeState.dailyPnl || 0;
      const currentStake = safeState.currentStake || 0.35;
      const locked = safeState.locked || false;
      const active = safeState.active || false;
      const lastTriggerTime = safeState.lastTriggerTime || 0;
      const tradeInProgress = safeState.tradeInProgress || false;
      const marketMetrics = safeState.marketMetrics || {};

      serverMode = tradingMode;

      // ---- Header status ----
      const header = document.getElementById('header-status');
      if (header) {
        const nowTime = Date.now();
        if (locked) {
          if (active) { header.textContent = '● PAUSED'; header.className = 'header-status paused'; }
          else { header.textContent = '● LOCKED'; header.className = 'header-status off'; }
        } else if (active) {
          const remaining = Math.max(0, Math.ceil((lastTriggerTime + 30000 - nowTime) / 1000));
          let cooldownText = remaining > 0 ? `⏳${remaining}s` : '';
          let lockText = tradeInProgress ? '🔒' : '';
          header.innerHTML = `● ARMED ${cooldownText ? `<span class="cooldown">${cooldownText}</span>` : ''} ${lockText ? `<span class="lock">${lockText}</span>` : ''}`;
          header.className = 'header-status on';
        } else {
          header.textContent = '● IDLE';
          header.className = 'header-status';
        }
      }

      // ---- Sidebar profile ----
      const profileEl = document.getElementById('m-profile');
      if (profileEl) profileEl.textContent = tradingMode.toUpperCase();
      const spModeEl = document.getElementById('sp-mode');
      if (spModeEl) spModeEl.textContent = tradingMode.toUpperCase();
      // Desktop balance
      const balanceEl = document.getElementById('m-balance');
      if (balanceEl) {
        balanceEl.textContent = balance !== null ? `$${Number(balance).toFixed(2)}` : '---';
      }

      // ---- Focus bar ----
      const focusMetric = marketMetrics[currentFocus] || null;
      document.getElementById('f-name').textContent = MARKETS_CFG[currentFocus] || 'Volatility 75 Index';
      const priceDisplay = focusMetric?.formattedPrice || formatPrice(currentFocus, focusMetric?.price) || '—';
      document.getElementById('f-price').textContent = priceDisplay;
      const srEl = document.getElementById('f-sr');
      if (focusMetric) {
        const s = focusMetric.support ? Number(focusMetric.support).toFixed(2) : '—';
        const r = focusMetric.resistance ? Number(focusMetric.resistance).toFixed(2) : '—';
        srEl.innerHTML = `<span class="s">S: ${s}</span> <span class="r">R: ${r}</span>`;
        document.getElementById('f-rsi').textContent = `RSI: ${focusMetric.rsi !== undefined ? Number(focusMetric.rsi).toFixed(1) : '—'}`;
        document.getElementById('f-vol').textContent = `Vol: ${focusMetric.volatility !== undefined ? Number(focusMetric.volatility).toFixed(2) + '%' : '—'}`;
      } else {
        srEl.innerHTML = '<span class="s">S: —</span> <span class="r">R: —</span>';
        document.getElementById('f-rsi').textContent = 'RSI: —';
        document.getElementById('f-vol').textContent = 'Vol: —';
      }

      // ---- Desktop table ----
      const tbody = document.getElementById('tableBody');
      if (!tbody) return;
      tbody.innerHTML = '';
      for (const sym in MARKETS_CFG) {
        const metric = marketMetrics[sym] || null;
        const isActive = sym === currentFocus;
        let priceDisplay = '—', step = 0, stepLabel = 'SCAN', stepClass = 'step-0';
        let support = '—', resistance = '—';
        let rsiVal = '—', rsiClass = '';
        let squeezeDisplay = '—';
        let squeezeClass = '';
        let trendHtml = '';
        let supportPct = null, resistancePct = null, risePct = null, fallPct = null;

        if (metric) {
          priceDisplay = metric.formattedPrice || formatPrice(sym, metric.price) || '—';
          step = metric.step || 0;
          if (step === 3) { stepLabel = 'ENTRY'; stepClass = 'step-3'; }
          else if (step === 2) { stepLabel = 'NEAR'; stepClass = 'step-2'; }
          else if (step === 1) { stepLabel = 'LEVEL'; stepClass = 'step-1'; }
          else { stepLabel = 'SCAN'; stepClass = 'step-0'; }
          support = metric.support ? Number(metric.support).toFixed(2) : '—';
          resistance = metric.resistance ? Number(metric.resistance).toFixed(2) : '—';
          rsiVal = metric.rsi !== undefined ? Number(metric.rsi).toFixed(1) : '—';
          if (metric.rsi !== undefined && metric.rsi > 70) rsiClass = 'overbought';
          else if (metric.rsi !== undefined && metric.rsi < 30) rsiClass = 'oversold';
          if (metric.bandwidth !== null && metric.bandwidth !== undefined) {
            squeezeDisplay = metric.bandwidth.toFixed(2) + '%';
            if (metric.bandwidth < 2.0) squeezeClass = 'badge-squeeze';
          }
          if (metric.tickDirections && metric.tickDirections.length > 0) {
            const dirs = metric.tickDirections.slice(-5);
            trendHtml = dirs.map(d => {
              if (d > 0) return '<span class="tick-up">▲</span>';
              else if (d < 0) return '<span class="tick-down">▼</span>';
              else return '<span class="tick-flat">—</span>';
            }).join('');
          } else {
            trendHtml = '—';
          }
          supportPct = metric.supportPct !== undefined ? Math.round(metric.supportPct) : null;
          resistancePct = metric.resistancePct !== undefined ? Math.round(metric.resistancePct) : null;
          risePct = metric.risePct !== undefined ? Math.round(metric.risePct) : null;
          fallPct = metric.fallPct !== undefined ? Math.round(metric.fallPct) : null;
        }

        const srPctDisplay = (supportPct !== null && resistancePct !== null)
          ? `<span style="color:#10b981;">${supportPct}%</span> / <span style="color:#ef4444;">${resistancePct}%</span>`
          : '—';
        const rfPctDisplay = (risePct !== null && fallPct !== null)
          ? `<span style="color:#10b981;">${risePct}%</span> / <span style="color:#ef4444;">${fallPct}%</span>`
          : '—';

        const tr = document.createElement('tr');
        tr.className = `${isActive ? 'active' : ''} ${stepClass}`;
        tr.onclick = () => window.setFocusMarket(sym);
        tr.innerHTML = `
          <td class="col-asset">${MARKETS_CFG[sym]}</td>
          <td class="col-price">${priceDisplay}</td>
          <td class="col-sr"><span class="s">${support}</span> / <span class="r">${resistance}</span></td>
          <td class="col-sr-pct">${srPctDisplay}</td>
          <td class="col-rf-pct">${rfPctDisplay}</td>
          <td class="col-rsi ${rsiClass}">${rsiVal}</td>
          <td class="col-bb-squeeze"><span class="${squeezeClass}">${squeezeDisplay}</span></td>
          <td class="col-trend">${trendHtml}</td>
        `;
        tbody.appendChild(tr);
      }

      // ---- Mobile view (legacy — silently no-ops if elements missing) ----
      try { renderMobileView(state); } catch(e) {}

    } catch (err) {
      console.error('❌ Error in renderUI:', err);
    }
  }

  function renderMobileView(state) {
    const safeState = state || {};
    const marketMetrics = safeState.marketMetrics || {};
    const carousel = document.getElementById('assetCarousel');
    if (carousel) {
      carousel.innerHTML = '';
      Object.keys(MARKETS_CFG).forEach(sym => {
        const chip = document.createElement('div');
        chip.className = 'asset-chip' + (sym === currentFocus ? ' active' : '');
        chip.dataset.symbol = sym;
        chip.textContent = getAssetLabel(MARKETS_CFG[sym], true);
        chip.onclick = () => window.setFocusMarket(sym);
        carousel.appendChild(chip);
      });
    }
  }

  // ---------- SSE ----------
  function connectSSE() {
    if (sse) { sse.close(); sse = null; }
    sse = new EventSource('/stream');
    sse.onopen = function () { console.log('✅ SSE connected'); reconnectAttempts = 0; };
    sse.onerror = function (err) {
      console.warn('⚠️ SSE error:', err);
      if (sse) sse.close();
      const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 10000);
      setTimeout(() => {
        reconnectAttempts++;
        if (reconnectAttempts <= maxReconnectAttempts) connectSSE();
        else console.error('❌ SSE max retries reached.');
      }, delay);
    };
    sse.onmessage = function (e) {
      try {
        const data = JSON.parse(e.data);
        if (data.event === 'analytics_delta') {
          eventBus.emit('analytics_delta', data.data);
          return;
        }
        if (data.state) {
          globalState = data.state;
          if (data.state.marketMetrics) {
            for (const sym in data.state.marketMetrics) {
              const metric = data.state.marketMetrics[sym];
              if (metric && metric.price !== undefined) {
                currentMarketPrices[sym] = metric.price;
              }
            }
          }
          renderUI(data.state);
          // Sync mobile UI elements (drawer, home screen, bot card, etc.)
          if (typeof syncMobileUI === 'function') syncMobileUI(data.state);
        }
        if (data.logs && data.logs.length > 0) {
          eventBus.emit('new-logs', data.logs);
        }
      } catch (err) {
        console.error('❌ Error parsing SSE:', err);
      }
    };
  }

  // ---------- Set focus market ----------
  function setFocusMarket(sym) {
    if (!sym) return;
    currentFocus = sym;
    if (globalState && typeof renderUI === 'function') renderUI(globalState);
    document.querySelectorAll('.asset-chip').forEach(el => el.classList.remove('active'));
    const chip = document.querySelector(`.asset-chip[data-symbol="${sym}"]`);
    if (chip) chip.classList.add('active');
  }

  // ---------- Public API ----------
  window.QuantCore = {
    getCurrentFocus: () => currentFocus,
    getGlobalState: () => globalState,
    getCurrentMarketPrices: () => currentMarketPrices,
    setFocusMarket,
    renderUI,
    connectSSE,
    MARKETS_CFG,
    MARKET_DECIMALS,
    formatPrice,
    getAssetLabel,
    eventBus
  };

  window.setFocusMarket = setFocusMarket;

  console.log('🧠 core.js loaded');
})();
