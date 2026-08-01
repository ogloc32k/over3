// engine/bot.js – TEST MODE (short cooldown, stake comes from state)
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
  // Cooldown reduced to 5 seconds for fast testing
  if (options.lastCloseTime && (now - options.lastCloseTime < 5000)) {
    console.log(`⏳ Cooldown for ${symbol}`);
    return null;
  }
  if (!metrics || metrics.lastPrices.length < 20) {
    console.log(`⏳ Not enough ticks for ${symbol}`);
    return null;
  }

  console.log(`✅ All guards passed for ${symbol} – firing test trade`);
  return {
    symbol: symbol,
    contractType: 'CALL',
    duration: 7,
    durationUnit: 't',
    stake: state.currentStake || 0.35        // ← uses the dynamic stake
  };
}

function hasConsecutiveTicks(d, dir, c) { return false; }
module.exports = { evaluate };
