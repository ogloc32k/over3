 // engine/bot.js – Configurable Multi-Condition Strategy (v2)
//
// All entry conditions are toggled and ranged by the user via the settings
// panel. ALL enabled conditions must pass together (AND logic) before a trade
// fires. If no conditions are enabled the bot stays silent.

/**
 * Evaluate a single symbol for a trading signal.
 *
 * @param {string}  symbol   - Deriv symbol e.g. "R_75"
 * @param {object}  metrics  - computeMetrics() result for that symbol
 * @param {object}  state    - global store.state
 * @param {object}  options  - { tradeInProgress, lastCloseTime, config }
 * @returns {object|null}    - trade params or null (no signal)
 */
function evaluate(symbol, metrics, state, options = {}) {

  // ── Basic guards ─────────────────────────────────────────────────────────
  if (!state.active)           return null;
  if (options.tradeInProgress) return null;

  const config = options.config || {};

  // ── Cooldown guard ────────────────────────────────────────────────────────
  const cooldownSec = parseInt(config.BOT_COOLDOWN) || 5;
  if (options.lastCloseTime &&
      (Date.now() - options.lastCloseTime < cooldownSec * 1000)) {
    return null;
  }

  // Require at least 20 ticks before evaluating
  if (!metrics || metrics.lastPrices.length < 20) return null;

  // ── Max runs guard ────────────────────────────────────────────────────────
  const maxRuns = parseInt(config.BOT_MAX_RUNS);
  if (maxRuns > 0 && (state.sessionTradeCount || 0) >= maxRuns) return null;

  // ── At least one condition must be enabled ────────────────────────────────
  const condKeys = [
    'COND_PRICE_UNDER_SUPPORT_ENABLED',
    'COND_PRICE_OVER_RESISTANCE_ENABLED',
    'COND_SUPPORT_PCT_ENABLED',
    'COND_RESISTANCE_PCT_ENABLED',
    'COND_RISE_PCT_ENABLED',
    'COND_FALL_PCT_ENABLED',
    'COND_RSI_ENABLED',
    'COND_BB_SQUEEZE_ENABLED',
    'COND_TICK_SEQ_ENABLED',
  ];
  const anyEnabled = condKeys.some(k => config[k] === true || config[k] === 'true');
  if (!anyEnabled) return null;

  // ── Destructure market metrics ────────────────────────────────────────────
  const {
    price,
    support,
    resistance,
    supportPct,       // 100 = price at support,    0 = price at resistance
    resistancePct,    // 100 = price at resistance,  0 = price at support
    risePct,          // % of ticks that were up in the analysis window
    fallPct,          // % of ticks that were down
    rsi,
    squeezePercentile, // BB squeeze percentile (lower = tighter squeeze)
    tickDirections,   // last 20 tick directions (+1 rise, -1 fall, 0 flat)
  } = metrics;

  // Helper: parse a numeric config value, return fallback if invalid
  const num = (key, fallback) => {
    const v = parseFloat(config[key]);
    return isNaN(v) ? fallback : v;
  };
  const on = (key) => config[key] === true || config[key] === 'true';

  // ══════════════════════════════════════════════════════════════════════════
  //  CONDITION 1 – Price breaks below Support
  // ══════════════════════════════════════════════════════════════════════════
  if (on('COND_PRICE_UNDER_SUPPORT_ENABLED')) {
    if (support == null || price >= support) return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONDITION 2 – Price breaks above Resistance
  // ══════════════════════════════════════════════════════════════════════════
  if (on('COND_PRICE_OVER_RESISTANCE_ENABLED')) {
    if (resistance == null || price <= resistance) return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONDITION 3 – Support % in range
  //  supportPct: 100 = at support, 0 = at resistance
  // ══════════════════════════════════════════════════════════════════════════
  if (on('COND_SUPPORT_PCT_ENABLED')) {
    if (supportPct == null) return null;
    const min = num('COND_SUPPORT_PCT_MIN', 0);
    const max = num('COND_SUPPORT_PCT_MAX', 100);
    if (supportPct < min || supportPct > max) return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONDITION 4 – Resistance % in range
  //  resistancePct: 100 = at resistance, 0 = at support
  // ══════════════════════════════════════════════════════════════════════════
  if (on('COND_RESISTANCE_PCT_ENABLED')) {
    if (resistancePct == null) return null;
    const min = num('COND_RESISTANCE_PCT_MIN', 0);
    const max = num('COND_RESISTANCE_PCT_MAX', 100);
    if (resistancePct < min || resistancePct > max) return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONDITION 5 – Rise % in range
  // ══════════════════════════════════════════════════════════════════════════
  if (on('COND_RISE_PCT_ENABLED')) {
    const min = num('COND_RISE_PCT_MIN', 0);
    const max = num('COND_RISE_PCT_MAX', 100);
    if (risePct < min || risePct > max) return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONDITION 6 – Fall % in range
  // ══════════════════════════════════════════════════════════════════════════
  if (on('COND_FALL_PCT_ENABLED')) {
    const min = num('COND_FALL_PCT_MIN', 0);
    const max = num('COND_FALL_PCT_MAX', 100);
    if (fallPct < min || fallPct > max) return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONDITION 7 – RSI in range
  // ══════════════════════════════════════════════════════════════════════════
  if (on('COND_RSI_ENABLED')) {
    if (rsi == null) return null;
    const min = num('COND_RSI_MIN', 0);
    const max = num('COND_RSI_MAX', 100);
    if (rsi < min || rsi > max) return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONDITION 8 – BB Squeeze percentile in range
  //  Lower squeeze percentile = bands are tighter = potential breakout coming
  // ══════════════════════════════════════════════════════════════════════════
  if (on('COND_BB_SQUEEZE_ENABLED')) {
    if (squeezePercentile == null) return null;
    const min = num('COND_BB_SQUEEZE_MIN', 0);
    const max = num('COND_BB_SQUEEZE_MAX', 100);
    if (squeezePercentile < min || squeezePercentile > max) return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONDITION 9 – Last-N ticks sequence (R = rise, F = fall)
  //  Pattern examples: "RR" = last 2 both rising, "RF" = rise then fall
  //  Flat ticks (0) never satisfy either R or F.
  // ══════════════════════════════════════════════════════════════════════════
  if (on('COND_TICK_SEQ_ENABLED')) {
    const raw     = String(config.COND_TICK_SEQ_PATTERN || '').toUpperCase();
    const pattern = raw.replace(/[^RF]/g, '');      // strip anything that isn't R or F
    if (pattern.length > 0) {
      if (!_matchesTickPattern(tickDirections || [], pattern)) return null;
    }
  }

  // ── All enabled conditions passed – build trade signal ───────────────────
  const direction = (config.TRADE_DIRECTION === 'PUT') ? 'PUT' : 'CALL';
  const duration  = parseInt(config.BOT_DURATION) || 70;
  const stake     = state.currentStake || (parseFloat(config.BOT_BASE_STAKE) || 0.35);

  return { symbol, contractType: direction, duration, durationUnit: 't', stake };
}

/**
 * Returns true if the LAST pattern.length tick-directions match the pattern.
 * 'R' expects direction === 1, 'F' expects direction === -1.
 * A flat tick (0) never matches either letter.
 */
function _matchesTickPattern(directions, pattern) {
  if (!directions || directions.length < pattern.length) return false;
  const slice = directions.slice(-pattern.length);
  for (let i = 0; i < pattern.length; i++) {
    const ch  = pattern[i];
    const dir = slice[i];
    if (ch === 'R' && dir !== 1)  return false;
    if (ch === 'F' && dir !== -1) return false;
  }
  return true;
}

module.exports = { evaluate };
