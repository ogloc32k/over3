// engine/bot.js – TEST MODE (returns symbol, fires on any tick when active)
function evaluate(symbol, metrics, state, options = {}) {
  if (!state.active) {
    console.log(`⛔ Bot inactive – ${symbol} skipped`);
    return null;
  }
  if (options.tradeInProgress) {
    console.log(`🔒 Symbol ${symbol} locked`);
    return null;
  }
  const now = Date.now();
  if (options.lastCloseTime && (now - options.lastCloseTime < 30000)) {
    console.log(`⏳ Cooldown for ${symbol}`);
    return null;
  }
  if (!metrics || metrics.lastPrices.length < 20) {
    console.log(`⏳ Not enough ticks for ${symbol}`);
    return null;
  }

  console.log(`✅ All guards passed for ${symbol} – firing test trade`);
  return {
    symbol: symbol,            // ← REQUIRED
    contractType: 'CALL',
    duration: 7,
    durationUnit: 't',
    stake: 0.35
  };
}

function hasConsecutiveTicks(d, dir, c) { return false; }
module.exports = { evaluate };
