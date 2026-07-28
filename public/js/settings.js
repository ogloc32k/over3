// ============================================================
// settings.js – Config loading and saving
// ============================================================
(function () {
  window.loadConfig = async function () {
    try {
      const resp = await fetch('/api/config');
      const config = await resp.json();
      const map = {
        'ANALYSIS_WINDOW': 'ANALYSIS_WINDOW',
        'BOLLINGER_PERIOD': 'BOLLINGER_PERIOD',
        'BOLLINGER_STD': 'BOLLINGER_STD',
        'RSI_PERIOD': 'RSI_PERIOD',
        'OVERSOLD_THRESHOLD': 'OVERSOLD_THRESHOLD',
        'OVERBOUGHT_THRESHOLD': 'OVERBOUGHT_THRESHOLD',
        'MIN_VOLATILITY_PERCENT': 'MIN_VOLATILITY_PERCENT',
        'DURATION_SECONDS': 'DURATION_SECONDS',
        'MAX_CONSECUTIVE_LOSSES': 'MAX_CONSECUTIVE_LOSSES',
        'RISK_PERCENT': 'RISK_PERCENT',
        'TP_PERCENT': 'TP_PERCENT',
        'SL_PERCENT': 'SL_PERCENT',
        'MIN_STAKE': 'MIN_STAKE',
        'COOLDOWN_TICKS': 'COOLDOWN_TICKS'
      };
      for (const [id, key] of Object.entries(map)) {
        const el = document.getElementById('config-' + id);
        if (el && config[key] !== undefined) el.value = config[key];
      }
      const msFields = {
        'MIN_TRIGGER_INTERVAL': 1000,
        'LOSS_COOLDOWN_MS': 60000,
        'SETTLEMENT_TIMEOUT_MS': 1000,
        'PNL_SYNC_INTERVAL_MS': 1000
      };
      for (const [id, divisor] of Object.entries(msFields)) {
        const secondsId = id.replace('_MS', '_SECONDS');
        const el = document.getElementById('config-' + secondsId);
        if (el && config[id] !== undefined) {
          el.value = config[id] / divisor;
        }
      }
      document.getElementById('settings-status').textContent = 'Config loaded.';
    } catch (err) {
      document.getElementById('settings-status').textContent = 'Error loading config.';
      console.error(err);
    }
  };

  window.saveSettings = async function () {
    try {
      const config = {};
      const direct = [
        'ANALYSIS_WINDOW', 'BOLLINGER_PERIOD', 'BOLLINGER_STD', 'RSI_PERIOD',
        'OVERSOLD_THRESHOLD', 'OVERBOUGHT_THRESHOLD', 'MIN_VOLATILITY_PERCENT',
        'DURATION_SECONDS', 'MAX_CONSECUTIVE_LOSSES',
        'RISK_PERCENT', 'TP_PERCENT', 'SL_PERCENT', 'MIN_STAKE',
        'COOLDOWN_TICKS'
      ];
      for (const id of direct) {
        const el = document.getElementById('config-' + id);
        if (el) {
          const val = parseFloat(el.value);
          if (!isNaN(val)) config[id] = val;
        }
      }
      const secondsToMs = {
        'MIN_TRIGGER_INTERVAL_SECONDS': 'MIN_TRIGGER_INTERVAL',
        'LOSS_COOLDOWN_MINUTES': 'LOSS_COOLDOWN_MS',
        'SETTLEMENT_TIMEOUT_SECONDS': 'SETTLEMENT_TIMEOUT_MS',
        'PNL_SYNC_INTERVAL_SECONDS': 'PNL_SYNC_INTERVAL_MS'
      };
      for (const [secondsId, msId] of Object.entries(secondsToMs)) {
        const el = document.getElementById('config-' + secondsId);
        if (el) {
          const val = parseFloat(el.value);
          if (!isNaN(val)) {
            let multiplier = 1000;
            if (secondsId === 'LOSS_COOLDOWN_MINUTES') multiplier = 60000;
            config[msId] = val * multiplier;
          }
        }
      }
      const resp = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      const result = await resp.json();
      if (result.success) {
        document.getElementById('settings-status').textContent = '✅ Settings applied!';
      } else {
        document.getElementById('settings-status').textContent = '❌ Error: ' + result.error;
      }
    } catch (err) {
      document.getElementById('settings-status').textContent = '❌ Network error.';
      console.error(err);
    }
  };

  console.log('⚙️ settings.js loaded');
})();
