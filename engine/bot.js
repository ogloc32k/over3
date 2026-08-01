// engine/bot.js – DEBUG VERSION (prints on every evaluation)
function evaluate(symbol, metrics, state, options = {}) {
  // --- UNCONDITIONAL LOG ---
  console.log(`🔍 bot.evaluate called for ${symbol}`);

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
    console.log(`⏳ Not enough ticks for ${symbol}: ${metrics ? metrics.lastPrices.length : 0}`);
    return null;
  }

  console.log(`✅ All guards passed for ${symbol} – firing test trade`);
  return {
    contractType: 'CALL',
    duration: 7,
    durationUnit: 't',
    stake: 0.35
  };
}

function hasConsecutiveTicks(d, dir, c) { return false; }
module.exports = { evaluate };
