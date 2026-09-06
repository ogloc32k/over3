// ============================================================
// dashboard.js – Control buttons and manual trade
// ============================================================
(function () {

  // ---- Bot start with validation and button state feedback ----
  window.sendControl = function (action) {
    if (action === 'start') {
      _setBotButtonState('starting');
    }

    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          _setBotButtonState('idle');
          _showBotError(data.error);
        } else if (data.message) {
          console.log(data.message);
          // SSE will update actual state; button will sync via _syncBotCard
        }
      })
      .catch(err => {
        _setBotButtonState('idle');
        console.error('Control error:', err);
        _showBotError('Network error – check connection');
      });
  };

  window.swapEnvironment = function () {
    const targetMode = QuantCore.getGlobalState()?.tradingMode || 'demo';
    const newMode    = targetMode === 'demo' ? 'real' : 'demo';
    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_mode', mode: newMode })
    })
      .then(res => res.json())
      .then(data => { if (data.error) alert('Error: ' + data.error); })
      .catch(err => console.error('Swap error:', err));
  };

  // ---- Manual trade ----
  window.fireManual = function (type, overrides) {
    const duration = overrides?.duration     ?? (parseInt(document.getElementById('manual-duration')?.value) || 7);
    const unit     = overrides?.durationUnit ?? document.getElementById('manual-unit')?.value ?? 't';
    const focusSym = overrides?.symbol       ?? QuantCore.getCurrentFocus();
    const stake    = overrides?.stake;
    const prices   = QuantCore.getCurrentMarketPrices();
    const price    = prices ? prices[focusSym] : null;

    if (price === undefined || price === null) {
      alert('No price data for ' + (focusSym || '') + '. Wait for ticks.');
      return;
    }

    const body = { symbol: focusSym, contractType: type, duration, durationUnit: unit, price };
    if (stake !== undefined) body.stake = stake;

    fetch('/api/trade/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(async (response) => {
        const text = await response.text();
        if (!response.ok) {
          let errMsg;
          try { errMsg = JSON.parse(text).error || 'Server error'; }
          catch(e) { errMsg = `Server ${response.status}: ${text.slice(0, 100)}`; }
          throw new Error(errMsg);
        }
        const data = JSON.parse(text);
        if (data.error) alert('Manual trade failed: ' + data.error);
      })
      .catch(err => { alert('Network error: ' + err.message); });
  };

  // ---- Internal helpers ----
  function _setBotButtonState(state) {
    const startBtn = document.getElementById('bot-start-btn');
    const stopBtn  = document.getElementById('bot-stop-btn');
    if (!startBtn) return;

    if (state === 'starting') {
      startBtn.disabled   = true;
      startBtn.textContent = '⏳ Starting…';
      startBtn.className   = 'bot-btn start loading';
    } else if (state === 'armed') {
      startBtn.disabled   = true;
      startBtn.textContent = '● Armed';
      startBtn.className   = 'bot-btn start armed';
      if (stopBtn) { stopBtn.disabled = false; stopBtn.className = 'bot-btn stop'; }
    } else {
      const riskReady = window._botRiskReady !== false;
      startBtn.disabled   = !riskReady;
      startBtn.textContent = '▶ Start Bot';
      startBtn.className   = 'bot-btn start';
      startBtn.title       = riskReady ? '' : 'Set Take Profit, Stop Loss and Max Runs first';
      if (stopBtn) { stopBtn.disabled = false; stopBtn.className = 'bot-btn stop'; }
    }
  }

  // Expose for app.js to call when SSE state changes
  window._setBotButtonState = _setBotButtonState;

  function _showBotError(msg) {
    const el = document.getElementById('bot-error-msg');
    if (!el) return;
    el.textContent = '⚠ ' + msg;
    el.style.display = 'block';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 6000);
  }

  console.log('📊 dashboard.js loaded');
})();
