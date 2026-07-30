// ============================================================
// dashboard.js – Control buttons and manual trade
// ============================================================
(function () {
  window.sendControl = function (action) {
    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) alert('Error: ' + data.error);
        else if (data.message) console.log(data.message);
      })
      .catch(err => console.error('Control error:', err));
  };

  window.swapEnvironment = function () {
    const targetMode = QuantCore.getGlobalState()?.tradingMode || 'demo';
    const newMode = targetMode === 'demo' ? 'real' : 'demo';
    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_mode', mode: newMode })
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) alert('Error: ' + data.error);
      })
      .catch(err => console.error('Swap error:', err));
  };

  // ✅ Updated fireManual – accepts optional overrides for mobile trade
  window.fireManual = function (type, overrides) {
    const duration  = overrides?.duration     ?? (parseInt(document.getElementById('manual-duration')?.value) || 7);
    const unit      = overrides?.durationUnit ?? document.getElementById('manual-unit')?.value ?? 't';
    const focusSym  = overrides?.symbol       ?? QuantCore.getCurrentFocus();
    const stake     = overrides?.stake;
    const prices    = QuantCore.getCurrentMarketPrices();
    const price     = prices ? prices[focusSym] : null;

    if (price === undefined || price === null) {
      alert('No price data available for ' + (focusSym || '') + '. Please wait for ticks.');
      return;
    }

    const body = {
      symbol: focusSym,
      contractType: type,
      duration: duration,
      durationUnit: unit,
      price: price
    };
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
          try {
            const errData = JSON.parse(text);
            errMsg = errData.error || 'Server error';
          } catch (e) {
            errMsg = `Server responded with ${response.status}: ${text.slice(0, 100)}`;
          }
          throw new Error(errMsg);
        }
        const data = JSON.parse(text);
        if (data.error) alert('Manual trade failed: ' + data.error);
        else console.log('Manual trade request sent:', data.message);
      })
      .catch(err => {
        alert('Network error: ' + err.message);
        console.error('Manual trade fetch error:', err);
      });
  };

  console.log('📊 dashboard.js loaded');
})();
