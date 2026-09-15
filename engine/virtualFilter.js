// engine/virtualFilter.js
// ============================================================
// Paper-trade gate for the Sniper bot.
//
// Purpose:
//   Observe the strategy without risking money until it produces
//   a configured consecutive-loss pattern. Only then allow one
//   real trade at a time. After the configured real-trade result,
//   return to paper mode so losses cannot be chased automatically.
// ============================================================

function isEnabled(config = {}) {
  return config.BOT_VIRTUAL_FILTER_ENABLED !== false &&
    String(config.BOT_VIRTUAL_FILTER_ENABLED).toLowerCase() !== 'false' &&
    String(config.BOT_VIRTUAL_FILTER_ENABLED) !== '0';
}

function createState(config = {}) {
  return {
    executionMode: isEnabled(config) ? 'virtual' : 'real',
    virtualTrade: null,
    virtualLossStreak: 0,
    virtualWinCount: 0,
    virtualLossCount: 0,
    virtualTradeCount: 0
  };
}

function createTrade(signal, entryPrice) {
  return {
    symbol: signal.symbol,
    contractType: signal.contractType,
    duration: Math.max(1, parseInt(signal.duration) || 1),
    entryPrice: Number(entryPrice),
    elapsedTicks: 0,
    openedAt: Date.now()
  };
}

function advanceTrade(trade, currentPrice) {
  const next = { ...trade, elapsedTicks: trade.elapsedTicks + 1 };
  if (next.elapsedTicks < next.duration) {
    return { complete: false, trade: next };
  }

  const entry = Number(next.entryPrice);
  const exit = Number(currentPrice);
  const isCall = next.contractType === 'CALL';
  const win = isCall ? exit > entry : exit < entry;

  return {
    complete: true,
    trade: next,
    result: win ? 'WIN' : 'LOSS',
    entryPrice: entry,
    exitPrice: exit
  };
}

function lossThreshold(config = {}) {
  return Math.max(1, parseInt(config.BOT_VIRTUAL_LOSS_THRESHOLD) || 4);
}

function returnMode(config = {}) {
  const mode = String(config.BOT_VIRTUAL_RETURN_MODE || 'any').toLowerCase();
  return ['win', 'loss', 'any'].includes(mode) ? mode : 'any';
}

function shouldReturnToVirtual(result, config = {}) {
  const mode = returnMode(config);
  return mode === 'any' || mode === result.toLowerCase();
}


// ------------------------------------------------------------
// PER-ASSET ARMING (paper-loss streaks are banked per market).
// Only the asset that produced the streak may fire the earned
// real trade, and the arming expires so stale evidence never
// risks money (BOT_VIRTUAL_ARMED_TTL minutes, default 60).
// ------------------------------------------------------------
function armedTtlMs(config = {}) {
  const minutes = Math.max(1, parseInt(config.BOT_VIRTUAL_ARMED_TTL) || 60);
  return minutes * 60 * 1000;
}

// Drop expired entries: { symbol: armed-until epoch ms }
function pruneArmed(armed, now = Date.now()) {
  const out = {};
  for (const [symbol, expiresAt] of Object.entries(armed || {})) {
    if (Number(expiresAt) > now) out[symbol] = Number(expiresAt);
  }
  return out;
}

// May a signal on `symbol` fire a real trade right now?
function isArmed(armed, symbol, config = {}, now = Date.now()) {
  if (!isEnabled(config)) return true; // filter off → all entries real
  const expiresAt = (armed || {})[symbol];
  return Number(expiresAt) > now;
}

// Banks a settled paper trade and decides whether the hunt arms for a
// real trade. Pure and unit-tested — the server handler only logs and
// applies the result. Global mode banks under '*' (shared streak);
// per-asset mode under the symbol.
// Regression note: the inline server code armed when streaks[symbol]
// crossed the threshold — in global mode the streak lives under '*',
// so the hunt NEVER armed. All keying goes through streakKey() here.
function bankPaperResult({ symbol, isWin, streaks = {}, armed = {}, config = {}, now = Date.now() }) {
  const bankSym   = streakKey(symbol, config);
  const next      = { ...streaks };
  next[bankSym]   = isWin ? 0 : (next[bankSym] || 0) + 1;
  const threshold = lossThreshold(config);
  const armedHit  = !isWin && next[bankSym] >= threshold;

  let bank = pruneArmed(armed, now);
  if (armedHit) {
    // Arming consumes the evidence: fresh streak.
    next[bankSym] = 0;
    bank = armAsset(bank, bankSym, config, now);
  }
  return { streaks: next, armed: bank, armedHit, threshold, streak: next[bankSym] };
}

function armAsset(armed, symbol, config = {}, now = Date.now()) {
  // Global mode (per-market off): arming lasts until the real trade
  // settles — no expiry wait, the original behaviour. Per-asset mode:
  // the armed window expires after the TTL so stale evidence never
  // risks money.
  const ttl = perAssetEnabled(config) ? armedTtlMs(config) : 365 * 24 * 60 * 60 * 1000;
  return { ...pruneArmed(armed, now), [symbol]: now + ttl };
}

function disarmAsset(armed, symbol) {
  const out = { ...(armed || {}) };
  delete out[symbol];
  return out;
}

// ------------------------------------------------------------
// GLOBAL vs PER-ASSET MODE (BOT_VIRTUAL_PER_ASSET, default OFF).
// Global mode banks every market on the '*' key: one shared
// streak, and any market may fire the earned real trade — the
// original behaviour. Per-asset mode banks each market separately
// and only that market can fire real.
// ------------------------------------------------------------
function perAssetEnabled(config = {}) {
  return config.BOT_VIRTUAL_PER_ASSET === true;
}

function streakKey(symbol, config = {}) {
  return perAssetEnabled(config) ? symbol : '*';
}

module.exports = {
  isEnabled,
  createState,
  createTrade,
  advanceTrade,
  bankPaperResult,
  lossThreshold,
  returnMode,
  shouldReturnToVirtual,
  armedTtlMs, pruneArmed, isArmed, armAsset, disarmAsset,
  perAssetEnabled, streakKey
};