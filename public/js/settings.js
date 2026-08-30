// ============================================================
// settings.js – Bot config load / save / reset
// ============================================================
(function () {

  // Map of HTML input ID → config key
  const BOT_FIELDS = {
    'cfg-bot-duration':     'BOT_DURATION',
    'cfg-bot-stake':        'BOT_BASE_STAKE',
    'cfg-bot-tp':           'BOT_TAKE_PROFIT',
    'cfg-bot-sl':           'BOT_STOP_LOSS',
    'cfg-bot-max-runs':     'BOT_MAX_RUNS',
    'cfg-bot-cooldown':     'BOT_COOLDOWN',
    'cfg-bot-rsi-low':      'BOT_RSI_OVERSOLD',
    'cfg-bot-rsi-high':     'BOT_RSI_OVERBOUGHT',
    'cfg-bot-zone':         'SNIPER_ZONE_PCT',
    'cfg-bot-ticks':        'SNIPER_TICKS',
    'cfg-bot-dominance':    'SNIPER_DOMINANCE',
    'cfg-bot-breakout':     'SNIPER_BREAKOUT_BUFFER',
    'cfg-bot-autocorrelation': 'SNIPER_MAX_AUTOCORRELATION',
    'cfg-bot-virtual-loss-threshold': 'BOT_VIRTUAL_LOSS_THRESHOLD'
  };
  const CHECKBOX_FIELDS = {
    'cfg-bot-virtual-enabled': 'BOT_VIRTUAL_FILTER_ENABLED'
  };
  const STRING_FIELDS = {
    'cfg-bot-virtual-return-mode': 'BOT_VIRTUAL_RETURN_MODE'
  };

  window.loadBotConfig = async function () {
    try {
      const resp   = await fetch('/api/config');
      const config = await resp.json();

      for (const [id, key] of Object.entries(BOT_FIELDS)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const val = config[key];
        if (val !== null && val !== undefined) {
          el.value = val;
          // Sync range display if sibling exists
          const display = document.getElementById(id + '-val');
          if (display) display.textContent = val;
        } else {
          el.value = '';
        }
      }
      for (const [id, key] of Object.entries(CHECKBOX_FIELDS)) {
        const el = document.getElementById(id);
        if (el) el.checked = config[key] !== false && String(config[key]).toLowerCase() !== 'false' && String(config[key]) !== '0';
      }
      for (const [id, key] of Object.entries(STRING_FIELDS)) {
        const el = document.getElementById(id);
        if (el && config[key] !== undefined && config[key] !== null) el.value = config[key];
      }

      // Cache max_runs for the runs counter in _syncBotCard
      window._cachedMaxRuns = parseInt(config.BOT_MAX_RUNS) || 0;
      window._cachedVirtualLossThreshold = parseInt(config.BOT_VIRTUAL_LOSS_THRESHOLD) || 4;

      _validateRequired(config);
    } catch(err) {
      console.error('loadBotConfig error:', err);
    }
  };

  let _saveTimer = null;

  window.saveBotConfig = function () {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_doSave, 600);
  };

  async function _doSave() {
    const config = {};
    for (const [id, key] of Object.entries(BOT_FIELDS)) {
      const el  = document.getElementById(id);
      if (!el) continue;
      const raw = el.value.trim();
      if (raw === '' || raw === null) {
        config[key] = null;
      } else {
        const val = parseFloat(raw);
        config[key] = isNaN(val) ? null : val;
      }
    }
    for (const [id, key] of Object.entries(CHECKBOX_FIELDS)) {
      const el = document.getElementById(id);
      if (el) config[key] = !!el.checked;
    }
    for (const [id, key] of Object.entries(STRING_FIELDS)) {
      const el = document.getElementById(id);
      if (el) config[key] = el.value;
    }

    try {
      const resp   = await fetch('/api/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(config)
      });
      const result = await resp.json();
      const statusEl = document.getElementById('bot-save-status');
      if (result.success) {
        if (statusEl) { statusEl.textContent = '✅ Saved'; setTimeout(() => { statusEl.textContent = ''; }, 3000); }
        window._cachedMaxRuns = parseInt(config.BOT_MAX_RUNS) || 0;
        window._cachedVirtualLossThreshold = parseInt(config.BOT_VIRTUAL_LOSS_THRESHOLD) || 4;
        _validateRequired(config);
      } else {
        if (statusEl) statusEl.textContent = '❌ ' + (result.error || 'Error');
      }
    } catch(err) {
      const statusEl = document.getElementById('bot-save-status');
      if (statusEl) statusEl.textContent = '❌ Network error';
    }
  };

  window.resetBotDefaults = async function () {
    try {
      const resp   = await fetch('/api/config/reset', { method: 'POST' });
      const result = await resp.json();
      if (result.success) {
        await window.loadBotConfig();
        const statusEl = document.getElementById('bot-save-status');
        if (statusEl) { statusEl.textContent = '↩ Defaults restored'; setTimeout(() => { statusEl.textContent = ''; }, 3000); }
      }
    } catch(err) { console.error('resetBotDefaults error:', err); }
  };

  function _validateRequired(config) {
    const tp      = parseFloat(config.BOT_TAKE_PROFIT);
    const sl      = parseFloat(config.BOT_STOP_LOSS);
    const maxRuns = parseInt(config.BOT_MAX_RUNS);

    const missingTp  = !tp  || tp  <= 0;
    const missingSl  = !sl  || sl  <= 0;
    const missingRuns = !maxRuns || maxRuns <= 0;
    const anyMissing = missingTp || missingSl || missingRuns;
    window._botRiskReady = !anyMissing;

    const warn = document.getElementById('bot-required-warn');
    if (warn) warn.style.display = anyMissing ? 'flex' : 'none';

    // Highlight missing fields
    _highlight('cfg-bot-tp',       missingTp);
    _highlight('cfg-bot-sl',       missingSl);
    _highlight('cfg-bot-max-runs', missingRuns);

    // Enable/disable start button
    const startBtn = document.getElementById('bot-start-btn');
    if (startBtn && !startBtn.classList.contains('armed')) {
      startBtn.disabled = anyMissing;
      startBtn.title    = anyMissing ? 'Set Take Profit, Stop Loss and Max Runs first' : '';
    }
  }

  function _highlight(id, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    if (isError) el.classList.add('field-required');
    else         el.classList.remove('field-required');
  }

  // Sync slider display values
  window.syncSlider = function (id) {
    const el      = document.getElementById(id);
    const display = document.getElementById(id + '-val');
    if (el && display) display.textContent = el.value;
  };

  // Load config when settings panel mounts
  window.addEventListener('DOMContentLoaded', () => {
    window.loadBotConfig();
  });

  // Legacy stub – keep settings tab working if it still calls loadConfig
  window.loadConfig  = window.loadBotConfig;
  window.saveSettings = window.saveBotConfig;

  console.log('⚙️ settings.js loaded');
})();
