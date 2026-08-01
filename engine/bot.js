// engine/bot.js – TEST MODE (fires on any tick, respects global lock)
function evaluate(symbol, metrics, state, options = {}) {
  if (!state.active) {
    return null;
  }

  // Global lock – only one trade active at a time (across all symbols)
  if (options.tradeInProgress) {
    return null;
  }

  // Cooldown after last trade closes (5 seconds)
  const now = Date.now();
  if (options.lastCloseTime && (now - options.lastCloseTime < 5000)) {
    return null;
  }

  // Minimum ticks
  if (!metrics || metrics.lastPrices.length < 20) {
    return null;
  }

  // Fire test trade
  return {
    symbol: symbol,
    contractType: 'CALL',
    duration: 7,
    durationUnit: 't',
    stake: state.currentStake || 0.35       // dynamic stake from server
  };
}

function hasConsecutiveTicks(d, dir, c) { return false; }
module.exports = { evaluate };
