// engine/bot.js
// Sniper Confluence Strategy – fires a 70‑second trade when 4 conditions align

function evaluate(symbol, metrics, state, options = {}) {
  // Guard: bot must be running
  if (!state.active) return null;
  // Only one trade per symbol at a time
  if (options.tradeInProgress) return null;
  // Cooldown after trade close (30 sec)
  const now = Date.now();
  if (options.lastCloseTime && (now - options.lastCloseTime < 30000)) return null;
  // Minimum ticks
  if (!metrics || metrics.lastPrices.length < 20) return null;

  const price = metrics.price;
  const supportPct = metrics.supportPct;      // 0 = at support, 100 = at resistance
  const rsi = metrics.rsi;
  const risePct = metrics.risePct;            // % up ticks
  const fallPct = metrics.fallPct;            // % down ticks
  const squeeze = metrics.squeezePercentile;  // BB squeeze percentile
  const tickDirections = metrics.tickDirections || [];

  // CALL conditions (bounce at support)
  if (
    supportPct !== null && supportPct <= 10 &&
    rsi < 30 &&
    hasConsecutiveTicks(tickDirections, 'down', 4) &&
    fallPct >= 60 &&
    squeeze !== null && squeeze > 60
  ) {
    // Breakout guard: price must not be below support by more than 0.5%
    if (metrics.support !== null && price < metrics.support * 0.995) return null;
    return {
      contractType: 'CALL',
      duration: 70,
      durationUnit: 's',
      stake: state.currentStake || 0.35
    };
  }

  // PUT conditions (rejection at resistance)
  if (
    supportPct !== null && supportPct >= 90 &&
    rsi > 70 &&
    hasConsecutiveTicks(tickDirections, 'up', 4) &&
    risePct >= 60 &&
    squeeze !== null && squeeze > 60
  ) {
    if (metrics.resistance !== null && price > metrics.resistance * 1.005) return null;
    return {
      contractType: 'PUT',
      duration: 70,
      durationUnit: 's',
      stake: state.currentStake || 0.35
    };
  }

  return null;
}

function hasConsecutiveTicks(directions, dir, count) {
  if (directions.length < count) return false;
  const slice = directions.slice(-count);
  const target = dir === 'up' ? 1 : -1;
  return slice.every(d => d === target);
}

module.exports = { evaluate };
