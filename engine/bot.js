// engine/bot.js – Sniper Confluence Strategy (Production)
// Reads config from store.config (set via Settings page)

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
  if (!state.active) return null;                         // bot must be running
  if (options.tradeInProgress) return null;               // global lock (one trade at a time)

  const config = state.config || {};
  const cooldownSec = parseInt(config.BOT_COOLDOWN) || 5;
  const now = Date.now();
  if (options.lastCloseTime && (now - options.lastCloseTime < cooldownSec * 1000)) {
    return null;                                          // post‑trade cooldown
  }

  if (!metrics || metrics.lastPrices.length < 20) return null;   // not enough ticks yet

  // ---- Extract indicators ----
  const price           = metrics.price;
  const supportPct      = metrics.supportPct;      // 0 = at support, 100 = at resistance
  const rsi             = metrics.rsi;
  const risePct         = metrics.risePct;         // % of up‑ticks
  const fallPct         = metrics.fallPct;         // % of down‑ticks
  const squeeze         = metrics.squeezePercentile; // BB squeeze percentile (higher = tighter)
  const tickDirections  = metrics.tickDirections || [];

  // ---- Configurable thresholds ----
  const rsiOversold     = parseInt(config.BOT_RSI_OVERSOLD) || 30;
  const rsiOverbought   = parseInt(config.BOT_RSI_OVERBOUGHT) || 70;
  const squeezeThreshold = parseInt(config.BOT_SQUEEZE) || 60;
  const duration        = parseInt(config.BOT_DURATION) || 70;          // seconds
  const stake           = state.currentStake || (parseFloat(config.BOT_BASE_STAKE) || 0.35);

  // ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
  //  CALL conditions (sniper bounce at support)
  // ────────────────────────────────────────────────────────────
  if (
    supportPct !== null && supportPct <= 10 &&         // in extreme bottom zone
    rsi < rsiOversold &&                               // deeply oversold
    hasConsecutiveTicks(tickDirections, 'down', 4) &&   // panic selling into support
    fallPct >= 60 &&                                   // sellers dominating
    squeeze !== null && squeeze > squeezeThreshold      // bands are tight → coiled spring
  ) {
    // Runaway trend circuit breaker: price broke below support by more than 0.5 %
    if (metrics.support !== null && price < metrics.support * 0.995) {
      return null;   // breakout regime – cancel CALL
    }
    return {
      symbol: symbol,
      contractType: 'CALL',
      duration: duration,
      durationUnit: 's',
      stake: stake
    };
  }

  // ────────────────────────────────────────────────────────────
  //  PUT conditions (sniper rejection at resistance)
  // ────────────────────────────────────────────────────────────
  if (
    supportPct !== null && supportPct >= 90 &&         // in extreme top zone
    rsi > rsiOverbought &&                             // deeply overbought
    hasConsecutiveTicks(tickDirections, 'up', 4) &&     // hard drive into resistance
    risePct >= 60 &&                                   // buyers dominating
    squeeze !== null && squeeze > squeezeThreshold      // bands are tight → coiled spring
  ) {
    // Runaway trend circuit breaker: price broke above resistance by more than 0.5 %
    if (metrics.resistance !== null && price > metrics.resistance * 1.005) {
      return null;   // breakout regime – cancel PUT
    }
    return {
      symbol: symbol,
      contractType: 'PUT',
      duration: duration,
      durationUnit: 's',
      stake: stake
    };
  }

  return null;   // no confluence
}

/**
 * Check if the last `count` tick directions are all the given direction.
 * @param {number[]} directions – array of +1 (up), -1 (down), 0 (flat)
 * @param {'up'|'down'} dir
 * @param {number} count
 */
function hasConsecutiveTicks(directions, dir, count) {
  if (directions.length < count) return false;
  const slice = directions.slice(-count);
  const target = dir === 'up' ? 1 : -1;
  return slice.every(d => d === target);
}

module.exports = { evaluate }; 
