// engine/bot.js

/**
 * Sniper Confluence Strategy
 * Evaluates one symbol at a time.
 * Returns a trade signal or null.
 *
 * @param {string} symbol       - Deriv symbol, e.g. 'R_75'
 * @param {object} metrics      - computed marketMetrics for that symbol
 * @param {object} state        - global store state (balance, active, etc.)
 * @param {object} options      - { tradeInProgress: boolean, lastTradeTime: number, lastCloseTime: number }
 * @returns {object|null}       - { contractType, duration, durationUnit, stake }
 */
function evaluate(symbol, metrics, state, options = {}) {
  // Guard: only run if the bot is activated
  if (!state.active) return null;

  // Hard filters -------------------------------------------------
  // 1. Only one trade per symbol at a time
  if (options.tradeInProgress) return null;

  // 2. Cooldown: 30 seconds after any trade closes (per symbol)
  const now = Date.now();
  if (options.lastCloseTime && (now - options.lastCloseTime < 30000)) return null;

  // 3. Minimum ticks needed (safety)
  if (!metrics || metrics.lastPrices.length < 20) return null;

  const price = metrics.price;
  const supportPct = metrics.supportPct;    // position from support (0 = at support, 100 = at resistance)
  const rsi = metrics.rsi;
  const risePct = metrics.risePct;          // % up ticks
  const fallPct = metrics.fallPct;          // % down ticks
  const squeeze = metrics.squeezePercentile; // BB squeeze percentile (higher = tighter)
  const tickDirections = metrics.tickDirections || [];

  // --- CALL conditions ---
  // S/R zone: extreme bottom (supportPct <= 10) → close to support
  // RSI: < 30
  // Micro trend: last 4-5 ticks all down
  // Rise/Fall: fallPct >= 60
  // BB squeeze > 60 (high percentile = tight bands)
  if (
    supportPct !== null && supportPct <= 10 &&
    rsi < 30 &&
    hasConsecutiveTicks(tickDirections, 'down', 4) &&
    fallPct >= 60 &&
    squeeze !== null && squeeze > 60
  ) {
    // Runaway trend circuit breaker: if price has broken support by more than 0.5% (i.e. price < support * 0.995), it's a breakdown, cancel CALL.
    if (metrics.support !== null && price < metrics.support * 0.995) {
      return null;   // breakout regime
    }
    return {
      contractType: 'CALL',
      duration: 70,
      durationUnit: 's',
      stake: state.currentStake || 0.35
    };
  }

  // --- PUT conditions ---
  // S/R zone: extreme top (supportPct >= 90) → close to resistance
  // RSI: > 70
  // Micro trend: last 4-5 ticks all up
  // Rise/Fall: risePct >= 60
  // BB squeeze > 60
  if (
    supportPct !== null && supportPct >= 90 &&
    rsi > 70 &&
    hasConsecutiveTicks(tickDirections, 'up', 4) &&
    risePct >= 60 &&
    squeeze !== null && squeeze > 60
  ) {
    // Runaway trend circuit breaker: if price has broken resistance by more than 0.5% (price > resistance * 1.005)
    if (metrics.resistance !== null && price > metrics.resistance * 1.005) {
      return null;   // breakout regime
    }
    return {
      contractType: 'PUT',
      duration: 70,
      durationUnit: 's',
      stake: state.currentStake || 0.35
    };
  }

  return null;
}

/**
 * Check if the last `count` directions are all the given direction.
 * @param {number[]} directions - array of 1 (up), -1 (down), 0 (flat)
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
