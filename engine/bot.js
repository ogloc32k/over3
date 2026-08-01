// engine/bot.js – SNIPER CONFLUENCE with Take Profit, Stop Loss, Martingale
let sessionPnl = 0;           // accumulated P&L for the current bot session

function evaluate(symbol, metrics, state, options = {}) {
  if (!state.active) return null;

  // Global cooldown after last trade close (5 seconds)
  const now = Date.now();
  if (options.lastCloseTime && (now - options.lastCloseTime < 5000)) return null;

  // Only allow ONE trade at a time across all symbols
  if (options.tradeInProgress) return null;

  // Minimum ticks
  if (!metrics || metrics.lastPrices.length < 20) return null;

  const price = metrics.price;
  const supportPct = metrics.supportPct;     // 0 = at support, 100 = at resistance
  const rsi = metrics.rsi;
  const risePct = metrics.risePct;
  const fallPct = metrics.fallPct;
  const squeeze = metrics.squeezePercentile;
  const tickDirections = metrics.tickDirections || [];

  // Take Profit / Stop Loss check
  const dailyTp = state.config?.TP_PERCENT || 5;   // daily TP in % of balance
  const dailySl = state.config?.SL_PERCENT || 10;  // daily SL in % of balance
  const balance = state.balance || 0;
  const dailyPnl = state.dailyPnl || 0;
  if (dailyPnl >= balance * dailyTp / 100) {
    console.log('🛑 Daily Take Profit reached. Bot paused.');
    state.active = false;   // pause bot – you can restart manually
    return null;
  }
  if (dailyPnl <= -balance * dailySl / 100) {
    console.log('🛑 Daily Stop Loss reached. Bot paused.');
    state.active = false;
    return null;
  }

  // ---- CALL conditions ----
  if (supportPct !== null && supportPct <= 10 &&
      rsi < 30 &&
      hasConsecutiveTicks(tickDirections, 'down', 4) &&
      fallPct >= 60 &&
      squeeze !== null && squeeze > 60) {
    if (metrics.support !== null && price < metrics.support * 0.995) return null; // breakout
    const stake = getMartingaleStake(state);
    return {
      symbol: symbol,
      contractType: 'CALL',
      duration: 70,
      durationUnit: 's',
      stake: stake
    };
  }

  // ---- PUT conditions ----
  if (supportPct !== null && supportPct >= 90 &&
      rsi > 70 &&
      hasConsecutiveTicks(tickDirections, 'up', 4) &&
      risePct >= 60 &&
      squeeze !== null && squeeze > 60) {
    if (metrics.resistance !== null && price > metrics.resistance * 1.005) return null; // breakout
    const stake = getMartingaleStake(state);
    return {
      symbol: symbol,
      contractType: 'PUT',
      duration: 70,
      durationUnit: 's',
      stake: stake
    };
  }

  return null;
}

/**
 * Martingale stake logic:
 * - After a loss, double the stake (max 100).
 * - After a win, reset to base (0.35).
 * The state.currentStake is updated externally (in server.js) based on last trade outcome.
 */
function getMartingaleStake(state) {
  return Math.min(state.currentStake || 0.35, 100);
}

function hasConsecutiveTicks(directions, dir, count) {
  if (directions.length < count) return false;
  const slice = directions.slice(-count);
  const target = dir === 'up' ? 1 : -1;
  return slice.every(d => d === target);
}

module.exports = { evaluate };
