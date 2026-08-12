// ============================================================
// settings.js – Bot config load / save / reset  (v2)
//
// Handles the full settings panel:
//   • Numeric inputs (risk, execution, martingale, condition ranges)
//   • Boolean checkboxes (condition enable/disable)
//   • Direction radio buttons (CALL / PUT)
//   • Tick-pattern text input
//   • Market-selector toggle buttons (SELECTED_MARKETS array)
// ============================================================
(function () {

  // ── Numeric fields ────────────────────────────────────────────────────────
  // id → config key mapping. All values are stored as numbers (or null).
  const NUMERIC = {
    // Risk controls
    'cfg-tp':              'BOT_TAKE_PROFIT',
    'cfg-sl':              'BOT_STOP_LOSS',
    'cfg-max-runs':        'BOT_MAX_RUNS',
    // Trade execution
    'cfg-duration':        'BOT_DURATION',
    'cfg-stake':           'BOT_BASE_STAKE',
    'cfg-cooldown':        'BOT_COOLDOWN',
    // Martingale
    'cfg-martingale-mult': 'MARTINGALE_MULTIPLIER',
    'cfg-martingale-max':  'MARTINGALE_MAX_STAKE',
    // Condition ranges
    'cfg-support-min':     'COND_SUPPORT_PCT_MIN',
    'cfg-support-max':     'COND_SUPPORT_PCT_MAX',
    'cfg-resistance-min':  'COND_RESISTANCE_PCT_MIN',
    'cfg-resistance-max':  'COND_RESISTANCE_PCT_MAX',
    'cfg-rise-min':        'COND_RISE_PCT_MIN',
    'cfg-rise-max':        'COND_RISE_PCT_MAX',
    'cfg-fall-min':        'COND_FALL_PCT_MIN',
    'cfg-fall-max':        'COND_FALL_PCT_MAX',
    'cfg-rsi-min':         'COND_RSI_MIN',
    'cfg-rsi-max':         'COND_RSI_MAX',
    'cfg-bb-min':          'COND_BB_SQUEEZE_MIN',
    'cfg-bb-max':          'COND_BB_SQUEEZE_MAX',
  };

  // ── Boolean fields (checkboxes) ───────────────────────────────────────────
  const BOOLEAN = {
    'cfg-cond-price-under-support':     'COND_PRICE_UNDER_SUPPORT_ENABLED',
    'cfg-cond-price-over-resistance':   'COND_PRICE_OVER_RESISTANCE_ENABLED',
    'cfg-cond-support':                 'COND_SUPPORT_PCT_ENABLED',
    'cfg-cond-resistance':              'COND_RESISTANCE_PCT_ENABLED',
    'cfg-cond-rise':                    'COND_RISE_PCT_ENABLED',
    'cfg-cond-fall':                    'COND_FALL_PCT_ENABLED',
    'cfg-cond-rsi':                     'COND_RSI_ENABLED',
    'cfg-cond-bb':                      'COND_BB_SQUEEZE_ENABLED',
    'cfg-cond-tick-seq':                'COND_TICK_SEQ_ENABLED',
  };
  // Special: TRADE_DIRECTION → radio buttons (cfg-dir-call / cfg-dir-put)
  //          COND_TICK_SEQ_PATTERN → text input (cfg-tick-pattern)
  //          SELECTED_MARKETS → .market-btn[data-sym] toggle buttons

  // ── LOAD ──────────────────────────────────────────────────────────────────
  window.loadBotConfig = async function () {
    try {
      const resp   = await fetch('/api/config');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const config = await resp.json();

      // Numeric fields
      for (const [id, key] of Object.entries(NUMERIC)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const v = config[key];
        el.value = (v !== null && v !== undefined) ? v : '';
      }

      // Boolean checkboxes
      for (const [id, key] of Object.entries(BOOLEAN)) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.checked = (config[key] === true || config[key] === 'true');
        // Reflect enabled state on the row
        const row = el.closest('.cond-row');
        if (row) row.classList.toggle('disabled', !el.checked);
      }

      // Direction radio buttons
      const dir       = config.TRADE_DIRECTION || 'CALL';
      const callRadio = document.getElementById('cfg-dir-call');
      const putRadio  = document.getElementById('cfg-dir-put');
      if (callRadio) callRadio.checked = (dir === 'CALL');
      if (putRadio)  putRadio.checked  = (dir === 'PUT');

      // Tick sequence pattern
      const tickPatEl = document.getElementById('cfg-tick-pattern');
      if (tickPatEl) tickPatEl.value = config.COND_TICK_SEQ_PATTERN || 'RR';

      // Market selector buttons
      const selectedMarkets = Array.isArray(config.SELECTED_MARKETS)
        ? config.SELECTED_MARKETS
        : [];
      document.querySelectorAll('.market-btn').forEach(btn => {
        const sym = btn.dataset.sym;
        btn.classList.toggle('active', selectedMarkets.includes(sym));
      });

      // Cache max_runs so the runs counter works even without a re-fetch
      window._cachedMaxRuns = parseInt(config.BOT_MAX_RUNS) || 0;

      _validateRequired(config);
    } catch(err) {
      console.error('loadBotConfig error:', err);
    }
  };

  // ── SAVE (debounced 600 ms) ───────────────────────────────────────────────
  let _saveTimer = null;

  window.saveBotConfig = function () {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_doSave, 600);
  };

  async function _doSave() {
    const config = {};

    // Numeric fields
    for (const [id, key] of Object.entries(NUMERIC)) {
      const el  = document.getElementById(id);
      if (!el) continue;
      const raw = el.value.trim();
      if (raw === '') {
        config[key] = null;
      } else {
        const v = parseFloat(raw);
        config[key] = isNaN(v) ? null : v;
      }
    }

    // Boolean checkboxes
    for (const [id, key] of Object.entries(BOOLEAN)) {
      const el = document.getElementById(id);
      if (!el) continue;
      config[key] = el.checked;
    }

    // Trade direction (radio)
    const putRadio = document.getElementById('cfg-dir-put');
    config.TRADE_DIRECTION = (putRadio && putRadio.checked) ? 'PUT' : 'CALL';

    // Tick sequence pattern (strip non R/F chars, uppercase)
    const tickPatEl = document.getElementById('cfg-tick-pattern');
    if (tickPatEl) {
      config.COND_TICK_SEQ_PATTERN = tickPatEl.value
        .toUpperCase()
        .replace(/[^RF]/g, '');
    }

    // Selected markets (array of active button data-sym values)
    const activeMarkets = [];
    document.querySelectorAll('.market-btn.active').forEach(btn => {
      if (btn.dataset.sym) activeMarkets.push(btn.dataset.sym);
    });
    config.SELECTED_MARKETS = activeMarkets;

    try {
      const resp   = await fetch('/api/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(config)
      });
      const result = await resp.json();
      const statusEl = document.getElementById('bot-save-status');
      if (result.success) {
        if (statusEl) {
          statusEl.textContent = '✓ Saved';
          statusEl.style.color = 'var(--green-profit)';
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
        }
        window._cachedMaxRuns = parseInt(config.BOT_MAX_RUNS) || 0;
        _validateRequired(config);
      } else {
        if (statusEl) {
          statusEl.textContent = '✗ ' + (result.error || 'Save failed');
          statusEl.style.color = 'var(--red-loss)';
        }
      }
    } catch(err) {
      const statusEl = document.getElementById('bot-save-status');
      if (statusEl) {
        statusEl.textContent = '✗ Network error';
        statusEl.style.color = 'var(--red-loss)';
      }
    }
  }

  // ── RESET (preserves TP / SL / Max Runs / Selected Markets) ──────────────
  window.resetBotDefaults = async function () {
    try {
      const resp   = await fetch('/api/config/reset', { method: 'POST' });
      const result = await resp.json();
      if (result.success) {
        await window.loadBotConfig();
        const statusEl = document.getElementById('bot-save-status');
        if (statusEl) {
          statusEl.textContent = '↩ Defaults restored';
          statusEl.style.color = 'var(--text-secondary)';
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
        }
      }
    } catch(err) { console.error('resetBotDefaults error:', err); }
  };

  // ── MARKET SELECTOR HELPERS ───────────────────────────────────────────────
  window.toggleMarket = function (btn) {
    btn.classList.toggle('active');
    window.saveBotConfig();
  };

  window.selectAllMarkets = function () {
    document.querySelectorAll('.market-btn').forEach(b => b.classList.add('active'));
    window.saveBotConfig();
  };

  window.selectNoMarkets = function () {
    document.querySelectorAll('.market-btn').forEach(b => b.classList.remove('active'));
    window.saveBotConfig();
  };

  // ── CONDITION ROW ENABLE / DISABLE ────────────────────────────────────────
  // Called by each condition checkbox onchange. Greys out range inputs when off.
  window.onCondToggle = function (rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb) row.classList.toggle('disabled', !cb.checked);
  };

  // ── VALIDATION ────────────────────────────────────────────────────────────
  function _validateRequired(config) {
    const tp      = parseFloat(config.BOT_TAKE_PROFIT);
    const sl      = parseFloat(config.BOT_STOP_LOSS);
    const maxRuns = parseInt(config.BOT_MAX_RUNS);

    const missingTp   = !tp      || tp      <= 0;
    const missingSl   = !sl      || sl      <= 0;
    const missingRuns = !maxRuns || maxRuns <= 0;
    const anyMissing  = missingTp || missingSl || missingRuns;

    const warn = document.getElementById('bot-required-warn');
    if (warn) warn.style.display = anyMissing ? 'flex' : 'none';

    _highlightField('cfg-tp',       missingTp);
    _highlightField('cfg-sl',       missingSl);
    _highlightField('cfg-max-runs', missingRuns);

    const startBtn = document.getElementById('bot-start-btn');
    if (startBtn && !startBtn.classList.contains('armed')) {
      startBtn.disabled = anyMissing;
      startBtn.title    = anyMissing
        ? 'Set Take Profit, Stop Loss and Max Runs before starting'
        : '';
    }
  }

  function _highlightField(id, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('field-required', isError);
  }

  // ── BOOT ──────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    window.loadBotConfig();
  });

  // Legacy stubs (some parts of the app still call these names)
  window.loadConfig   = window.loadBotConfig;
  window.saveSettings = window.saveBotConfig;
  // syncSlider kept for any lingering old references (no-op now)
  window.syncSlider   = function () {};

  console.log('⚙️ settings.js v2 loaded');

})();
