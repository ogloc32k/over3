// engine/bot.js  – TEST MODE (fires on any tick when active)
function evaluate(symbol, metrics, state, options = {}) {
  // Guard: bot must be activated
  if (!state.active) {
    console.log(`⛔ Bot inactive – symbol ${symbol} skipped`);
    return null;
  }

  // Only one trade per symbol at a time
  if (options.tradeInProgress) {
    console.log(`🔒 Symbol ${symbol} locked (trade in progress)`);
    return null;
  }

  // Cooldown: 30 seconds after last close
  const now = Date.now();
  if (options.lastCloseTime && (now - options.lastCloseTime < 30000)) {
    const remaining = Math.ceil((30000 - (now - options.lastCloseTime)) / 1000);
    console.log(`⏳ Cooldown active for ${symbol}: ${remaining}s remaining`);
    return null;
  }

  // Minimum ticks needed
  if (!metrics || metrics.lastPrices.length < 20) {
    console.log(`⏳ Not enough ticks for ${symbol}: ${metrics ? metrics.lastPrices.length : 0}`);
    return null;
  }

  // ----- ALL GUARDS PASSED – fire test trade -----
  console.log(`✅ All guards passed for ${symbol} – firing test trade`);
  return {
    contractType: 'CALL',
    duration: 7,           // short trade so it settles quickly
    durationUnit: 't',
    stake: 0.35
  };
}

// Not used in test mode, but kept for compatibility
function hasConsecutiveTicks(directions, dir, count) {
  return false;
}

module.exports = { evaluate };
