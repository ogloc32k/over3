// engine/bot.js – Sniper Confluence Strategy (Production)
// Config is read from options.config (passed from server.js)

/**
 * Evaluate a single symbol for a trading signal.
 *
 * @param {string}  symbol   - Deriv symbol (e.g. "R_75")
 * @param {object}  metrics  - computed marketMetrics for that symbol
 * @param {object}  state    - global store.state (balance, active, etc.)
 * @param {object}  options  - { tradeInProgress, lastCloseTime, config }
 * @returns {object|null}    - { symbol, contractType, duration, durationUnit, stake } or null
 */
function evaluate(symbol, metrics, state, options = {}) {
  // ---- Guards ----
  if (!state.active) return null;
  if (options.tradeInProgress) return null;

  // Config comes from options (not state — state has no config property)
  const config = options.config || {};

  const cooldownSec = parseInt(config.BOT_COOLDOWN) || 5;
  const now = Date.now();
  if (options.lastCloseTime && (now - options.lastCloseTime < cooldownSec * 1000)) {
    return null; // post-trade cooldown
  }

  if (!metrics || metrics.lastPrices.length < 20) return null; // not enough ticks yet

  // ---- Max runs guard ----
  const maxRuns = parseInt(config.BOT_MAX_RUNS);
  if (maxRuns && maxRuns > 0 && (state.sessionTradeCount || 0) >= maxRuns) {
    return null; // session run limit reached
  }

  // ---- Extract indicators ----
  const price          = metrics.price;
  const supportPct     = metrics.supportPct;
  const rsi            = metrics.rsi;
  const risePct        = metrics.risePct;
  const fallPct        = metrics.fallPct;
  const tickDirections = metrics.tickDirections || [];

  // ---- RSI thresholds ----
  const rsiOversold   = parseInt(config.BOT_RSI_OVERSOLD)   || 30;
  const rsiOverbought = parseInt(config.BOT_RSI_OVERBOUGHT) || 70;

  // ---- Duration & stake ----
  const duration = parseInt(config.BOT_DURATION) || 70;
  const stake    = state.currentStake || (parseFloat(config.BOT_BASE_STAKE) || 0.35);

  // ---- Dynamic sniper variables ----
  const zoneThreshold   = parseFloat(config.SNIPER_ZONE_PCT)          || 20;   // zone % from edge
  const tickCount       = parseInt(config.SNIPER_TICKS)               || 2;    // consecutive ticks required
  const dominanceLimit  = parseFloat(config.SNIPER_DOMINANCE)         || 50;   // momentum dominance %
  const breakoutPct     = (parseFloat(config.SNIPER_BREAKOUT_BUFFER)  || 0.5) / 100;
  const bottomBreaker   = 1 - breakoutPct;  // e.g. 0.995
  const topBreaker      = 1 + breakoutPct;  // e.g. 1.005

  // ────────────────────────────────────────────────────────────
  //  CALL conditions (Sniper Bounce at support)
  // ────────────────────────────────────────────────────────────
  if (
    supportPct !== null && supportPct <= zoneThreshold &&
    rsi < rsiOversold &&
    hasConsecutiveTicks(tickDirections, 'down', tickCount) &&
    fallPct >= dominanceLimit
  ) {
    // Circuit breaker: price has broken below support too far
    if (metrics.support !== null && price < metrics.support * bottomBreaker) {
      return null;
    }
    return { symbol, contractType: 'CALL', duration, durationUnit: 't', stake };
  }

  // ────────────────────────────────────────────────────────────
  //  PUT conditions (Sniper Rejection at resistance)
  // ────────────────────────────────────────────────────────────
  if (
    supportPct !== null && supportPct >= (100 - zoneThreshold) &&
    rsi > rsiOverbought &&
    hasConsecutiveTicks(tickDirections, 'up', tickCount) &&
    risePct >= dominanceLimit
  ) {
    // Circuit breaker: price has broken above resistance too far
    if (metrics.resistance !== null && price > metrics.resistance * topBreaker) {
      return null;
    }
    return { symbol, contractType: 'PUT', duration, durationUnit: 't', stake };
  }

  return null; // No confluence
}

/**
 * Check if the last `count` tick directions are all the given direction.
 */
function hasConsecutiveTicks(directions, dir, count) {
  if (directions.length < count) return false;
  const slice  = directions.slice(-count);
  const target = dir === 'up' ? 1 : -1;
  return slice.every(d => d === target);
}

module.exports = { evaluate };
