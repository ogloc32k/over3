// ============================================================
// settings.js – Bot config load / save / reset
// ============================================================
(function () {

  // ---- Bot market selection (symbol allowlist) ----
  const SYMBOL_SHORT = {
    'R_10':'V10','R_25':'V25','R_50':'V50','R_75':'V75','R_100':'V100',
    '1HZ10V':'V10 (1s)','1HZ25V':'V25 (1s)','1HZ50V':'V50 (1s)',
    '1HZ75V':'V75 (1s)','1HZ100V':'V100 (1s)'
  };
  const TOTAL_MARKETS = Object.keys(SYMBOL_SHORT).length;
  let _botSymbolsInit = false;

  function normalizeSymbols(raw) {
    const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
    return arr.map(s => String(s).trim()).filter(Boolean);
  }

  window.getSelectedBotSymbols = function () {
    return [...document.querySelectorAll('#botSymbolChips .asset-chip.active')].map(c => c.dataset.symbol);
  };

  window.updateSymbolsSummary = function () {
    const summary = document.getElementById('bot-symbols-summary');
    if (!summary) return;
    const sel = window.getSelectedBotSymbols();
    if (!sel.length || sel.length === TOTAL_MARKETS) {
      summary.textContent = `ALL ${TOTAL_MARKETS}: The bot scans every volatility index and trades whichever produces a qualifying signal.`;
    } else {
      summary.textContent = `${sel.length}/${TOTAL_MARKETS} SELECTED: The bot only watches ${sel.map(s => SYMBOL_SHORT[s] || s).join(', ')}.`;
    }
  };

  function renderBotSymbolChips(selected) {
    const container = document.getElementById('botSymbolChips');
    if (!container) return;
    container.innerHTML = '';
    const selSet = new Set(selected);
    const allOn = !selected.length || selected.length === TOTAL_MARKETS;
    Object.keys(SYMBOL_SHORT).forEach(sym => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'asset-chip' + ((allOn || selSet.has(sym)) ? ' active' : '');
      chip.dataset.symbol = sym;
      chip.textContent = SYMBOL_SHORT[sym];
      chip.setAttribute('aria-pressed', (allOn || selSet.has(sym)) ? 'true' : 'false');
      chip.onclick = () => {
        chip.classList.toggle('active');
        chip.setAttribute('aria-pressed', chip.classList.contains('active') ? 'true' : 'false');
        window.updateSymbolsSummary();
        window.saveBotConfig();
      };
      container.appendChild(chip);
    });
    window.updateSymbolsSummary();
    _botSymbolsInit = true;
  }

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
    'cfg-bot-virtual-loss-threshold': 'BOT_VIRTUAL_LOSS_THRESHOLD',
    'cfg-bot-martingale-multiplier': 'BOT_MARTINGALE_MULTIPLIER',
    'cfg-bot-martingale-max-steps': 'BOT_MARTINGALE_MAX_STEPS'
  };
  const CHECKBOX_FIELDS = {
    'cfg-bot-virtual-enabled': 'BOT_VIRTUAL_FILTER_ENABLED',
    'cfg-bot-martingale-enabled': 'BOT_MARTINGALE_ENABLED'
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

      renderBotSymbolChips(normalizeSymbols(config.BOT_SYMBOLS));

      // Cache max_runs for the runs counter in _syncBotCard
      window._cachedMaxRuns = parseInt(config.BOT_MAX_RUNS) || 0;
      window._cachedVirtualLossThreshold = parseInt(config.BOT_VIRTUAL_LOSS_THRESHOLD) || 4;
      window._cachedMartingale = {
        enabled:   config.BOT_MARTINGALE_ENABLED === true,
        multiplier: parseFloat(config.BOT_MARTINGALE_MULTIPLIER) || 2,
        maxSteps:  parseInt(config.BOT_MARTINGALE_MAX_STEPS) || 4
      };

      _syncSliderDisplays();
      updateVirtualFilterSummary();
      updateMartingaleSummary();
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
    if (_botSymbolsInit) {
      // Empty selection = all markets (explicit empty array on purpose)
      config.BOT_SYMBOLS = window.getSelectedBotSymbols().filter(
        s => s !== '' && Object.keys(SYMBOL_SHORT).includes(s)
      );
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
        if (statusEl) {
          statusEl.textContent = '↩ ' + (result.message || 'Strategy defaults restored · risk & virtual safety preserved');
          setTimeout(() => { statusEl.textContent = ''; }, 4000);
        }
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

  function _syncSliderDisplays() {
    ['cfg-bot-zone', 'cfg-bot-dominance'].forEach(id => window.syncSlider(id));
  }

  window.updateVirtualFilterSummary = function () {
    const enabled = document.getElementById('cfg-bot-virtual-enabled')?.checked !== false;
    const threshold = Math.max(1, parseInt(document.getElementById('cfg-bot-virtual-loss-threshold')?.value, 10) || 4);
    const mode = document.getElementById('cfg-bot-virtual-return-mode')?.value || 'any';
    const summary = document.getElementById('bot-virtual-summary');
    const enabledHelp = document.getElementById('bot-virtual-enabled-help');
    const returnHelp = document.getElementById('bot-virtual-return-help');
    const toggleText = document.querySelector('#cfg-bot-virtual-enabled ~ .bsp-toggle-text');
    const policyLabel = {
      any: 'any real trade (safest)',
      win: 'real win only',
      loss: 'real loss only'
    };
    const modeCopy = {
      any: 'Any real trade returns to paper mode after a win or loss (safest).',
      win: 'Real win only returns to paper mode; after a loss, the bot stays in real mode and keeps risking money.',
      loss: 'Real loss only returns to paper mode; after a win, the bot stays in real mode for another real trade.'
    };

    if (summary) {
      summary.textContent = enabled
        ? `ON: Signals are paper-traded first; one real trade is allowed after ${threshold} consecutive virtual losses. Return policy: ${policyLabel[mode] || policyLabel.any}.`
        : `OFF: Every qualifying signal can place a real trade immediately; no virtual-loss guard applies. Return policy: ${policyLabel[mode] || policyLabel.any}.`;
    }
    if (enabledHelp) {
      enabledHelp.textContent = enabled
        ? `ON keeps qualifying signals in paper mode until ${threshold} consecutive losses.`
        : 'OFF lets every qualifying signal place a real trade immediately, without this guard.';
    }
    if (returnHelp) returnHelp.textContent = modeCopy[mode] || modeCopy.any;
    if (toggleText) toggleText.textContent = enabled ? 'ON' : 'OFF';
  };

  window.updateMartingaleSummary = function () {
    const toggle = document.getElementById('cfg-bot-martingale-enabled');
    const multEl = document.getElementById('cfg-bot-martingale-multiplier');
    const stepsEl = document.getElementById('cfg-bot-martingale-max-steps');
    const summary = document.getElementById('bot-martingale-summary');
    const toggleText = document.querySelector('#cfg-bot-martingale-enabled ~ .bsp-toggle-text');
    if (!toggle) return;
    const enabled = toggle.checked;
    const mult = parseFloat(multEl?.value) || 2;
    const steps = Math.max(1, parseInt(stepsEl?.value, 10) || 4);
    if (toggleText) toggleText.textContent = enabled ? 'ON' : 'OFF';
    if (summary) {
      summary.textContent = enabled
        ? `ON: After each losing bot trade the stake is multiplied by ${mult} (e.g. after ${steps} straight losses the cap is hit and the stake resets to base). A win resets to base immediately.`
        : 'OFF: Every bot trade uses the base stake.';
    }
  };

  // Load config when the bot-owned panel mounts
  window.addEventListener('DOMContentLoaded', () => {
    window.loadBotConfig();
    window.updateVirtualFilterSummary();
    window.updateMartingaleSummary();
  });

  console.log('⚙️ settings.js loaded');
})();
