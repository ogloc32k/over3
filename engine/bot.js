// engine/bot.js  – TEST MODE (fires on any tick when active)

function evaluate(symbol, metrics, state, options = {}) {
  // Guard: bot must be activated
  if (!state.active) return null;

  // Only one trade per symbol at a time
  if (options.tradeInProgress) return null;

  // Cooldown: 30 seconds after last close
  const now = Date.now();
  if (options.lastCloseTime && (now - options.lastCloseTime < 30000)) return null;

  // Minimum ticks needed
  if (!metrics || metrics.lastPrices.length < 20) return null;

  // ----- IGNORE ALL CONDITIONS – just fire a CALL every time -----
  return {
    contractType: 'CALL',
    duration: 7,           // short trade so it settles quickly
    durationUnit: 't',
    stake: 0.35
  };
}

function hasConsecutiveTicks(directions, dir, count) {
  return false;   // not used in test mode
}

module.exports = { evaluate };
