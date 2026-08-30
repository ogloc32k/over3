// engine/indicators.js
// ============================================================
// All indicator computations for the Sniper strategy
// Fixes applied:
//   P1 – Swing-pivot S/R with cluster validation (not rolling min/max)
//   P2 – Autocorrelation regime filter (mean-reversion confirmation)
//   P3 – BB band position exposed for independent signal check in bot.js
//   P4 – Wilder's smoothed RSI (not simple-sum approximation)
// ============================================================

function computeMetrics(symbol, prices, config = {}, bandwidthHistory = []) {
  if (!prices || prices.length < 2) return null;

  const lastPrice = prices[prices.length - 1];

  // ── Support / Resistance via swing pivots (Problem 1 fix) ──────────────
  const { support, resistance, supportTouches, resistanceTouches } =
    findSwingLevels(prices, config);

  // Channel position: supportPct is 0 at support; resistancePct is 0 at
  // resistance. The two values always sum to 100%.
  let supportPct = null, resistancePct = null;
  const range = resistance - support;
  if (range > 0) {
    supportPct    = ((lastPrice  - support)    / range) * 100;
    resistancePct = ((resistance - lastPrice) / range) * 100;
  } else {
    supportPct = resistancePct = 50;
  }

  // ── Bollinger Bands ────────────────────────────────────────────────────
  const {
    upper: bbUpper,
    middle: bbMiddle,
    lower: bbLower,
    bandwidth
  } = computeBollinger(prices, config.BOLLINGER_PERIOD || 20, config.BOLLINGER_STD || 2);

  // BB Squeeze percentile (historical compression rank)
  let squeezePercentile = null;
  if (bandwidth !== null && bandwidthHistory.length >= 20) {
    const higherCount = bandwidthHistory.filter(bw => bw >= bandwidth).length;
    squeezePercentile = (higherCount / bandwidthHistory.length) * 100;
  }

  // ── RSI (Wilder's smoothed — Problem 4 fix) ────────────────────────────
  const rsi = computeRSI(prices, config.RSI_PERIOD || 14);

  // ── Autocorrelation regime filter (Problem 2 fix) ─────────────────────
  const autocorrelation = computeAutocorrelation(prices, 1, config.AC_WINDOW || 60);

  // ── Volatility ─────────────────────────────────────────────────────────
  const volatility = computeVolatility(prices);

  // ── Tick direction ratios (still useful for display, not for signal) ───
  const tickDirections = prices.slice(1).map((p, i) => p > prices[i] ? 1 : (p < prices[i] ? -1 : 0));
  const upCount    = tickDirections.filter(d => d === 1).length;
  const downCount  = tickDirections.filter(d => d === -1).length;
  const total      = tickDirections.length;
  const risePct    = total > 0 ? (upCount   / total) * 100 : 0;
  const fallPct    = total > 0 ? (downCount / total) * 100 : 0;

  const isBreakout  = lastPrice > resistance;
  const isBreakdown = lastPrice < support;

  const score = computeScore(rsi, isBreakout, isBreakdown, volatility, risePct, fallPct);

  return {
    price:             lastPrice,
    step:              isBreakout || isBreakdown ? 3 : (resistancePct < 5 ? 2 : 1),
    support,
    resistance,
    supportTouches,
    resistanceTouches,
    isBreakout,
    isBreakdown,
    rsi,
    autocorrelation,
    volatility,
    score,
    bandwidth,
    squeezePercentile,
    bbUpper,
    bbMiddle,
    bbLower,
    tickDirections:    tickDirections.slice(-20),
    supportPct,
    resistancePct,
    risePct,
    fallPct,
    lastPrices:        prices.slice(-20),
  };
}

// ============================================================
// SWING-PIVOT SUPPORT / RESISTANCE  (Problem 1 fix)
// ============================================================
// A swing low/high is a price that is the lowest/highest point
// in a ±radius tick window. Nearby swings are clustered so that
// micro-noise doesn't create hundreds of spurious levels.
// Falls back to rolling min/max when not enough data exists.
// ============================================================
function findSwingLevels(prices, config = {}) {
  const radius       = parseInt(config.SWING_RADIUS)   || 8;     // ticks each side
  const lookback     = parseInt(config.SWING_LOOKBACK)  || 400;   // history window
  const clusterRange = parseFloat(config.SWING_CLUSTER) || 0.002; // 0.2 % tolerance

  const slice = prices.slice(-Math.min(lookback, prices.length));
  const currentPrice = slice[slice.length - 1];
  const swingLows = [], swingHighs = [];

  // Find swing pivots
  for (let i = radius; i < slice.length - radius; i++) {
    const center = slice[i];
    let isLow = true, isHigh = true;

    for (let j = i - radius; j <= i + radius; j++) {
      if (j === i) continue;
      if (slice[j] < center) isLow  = false;
      if (slice[j] > center) isHigh = false;
      if (!isLow && !isHigh) break;
    }

    if (isLow)  swingLows.push(center);
    if (isHigh) swingHighs.push(center);
  }

  // Cluster nearby swing levels and count touches
  function cluster(levels) {
    if (!levels.length) return [];
    const sorted = [...levels].sort((a, b) => a - b);
    const clusters = [];
    let group = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const refPrice = group[0];
      if (Math.abs(sorted[i] - refPrice) / refPrice <= clusterRange) {
        group.push(sorted[i]);
      } else {
        const avg = group.reduce((a, b) => a + b, 0) / group.length;
        clusters.push({ level: avg, touches: group.length });
        group = [sorted[i]];
      }
    }
    const avg = group.reduce((a, b) => a + b, 0) / group.length;
    clusters.push({ level: avg, touches: group.length });
    return clusters;
  }

  const supportClusters    = cluster(swingLows).filter(c  => c.level < currentPrice);
  const resistanceClusters = cluster(swingHighs).filter(c => c.level > currentPrice);

  // Nearest validated support below price, nearest resistance above
  supportClusters.sort((a, b)    => b.level - a.level);
  resistanceClusters.sort((a, b) => a.level - b.level);

  const fallbackMin = Math.min(...slice);
  const fallbackMax = Math.max(...slice);

  return {
    support:           supportClusters.length    > 0 ? supportClusters[0].level    : fallbackMin,
    resistance:        resistanceClusters.length > 0 ? resistanceClusters[0].level : fallbackMax,
    supportTouches:    supportClusters.length    > 0 ? supportClusters[0].touches  : 1,
    resistanceTouches: resistanceClusters.length > 0 ? resistanceClusters[0].touches : 1,
  };
}

// ============================================================
// AUTOCORRELATION REGIME FILTER  (Problem 2 fix)
// ============================================================
// Lag-1 autocorrelation of price returns over a rolling window.
// Negative value → returns alternate direction → mean-reverting.
// Near zero → random walk, no structure.
// Positive → returns persist direction → trending.
// Only enter on bounces when AC is meaningfully negative.
// ============================================================
function computeAutocorrelation(prices, lag, window) {
  lag    = lag    || 1;
  window = window || 60;

  const slice = prices.slice(-Math.min(window + 1, prices.length));
  if (slice.length < lag + 3) return 0;

  // First-difference returns
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push(slice[i] - slice[i - 1]);
  }

  const n    = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const dm   = returns.map(r => r - mean);

  let cov = 0, variance = 0;
  for (let i = lag; i < n; i++) cov      += dm[i] * dm[i - lag];
  for (let i = 0; i < n; i++)  variance  += dm[i] * dm[i];

  return variance === 0 ? 0 : cov / variance;
}

// ============================================================
// RSI — WILDER'S SMOOTHED  (Problem 4 fix)
// ============================================================
// Standard Wilder's method: seed with SMA of first `period`
// changes, then apply recursive smoothing for all remaining.
// This is the correct algorithm used in every trading platform.
// ============================================================
function computeRSI(prices, period) {
  period = period || 14;
  if (prices.length < period + 1) return 50;

  let avgGain = 0, avgLoss = 0;

  // Seed: simple average of first `period` up/down moves
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff;
    else          avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing over remaining candles
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ============================================================
// BOLLINGER BANDS
// ============================================================
function computeBollinger(prices, period, stdMult) {
  period  = period  || 20;
  stdMult = stdMult || 2;

  if (prices.length < period) {
    return { upper: null, middle: null, lower: null, bandwidth: null };
  }

  const slice    = prices.slice(-period);
  const mean     = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std      = Math.sqrt(variance);
  const upper    = mean + stdMult * std;
  const lower    = mean - stdMult * std;
  const bandwidth = mean > 0 ? ((upper - lower) / mean) * 100 : 0;

  return { upper, middle: mean, lower, bandwidth };
}

// ============================================================
// VOLATILITY
// ============================================================
function computeVolatility(prices) {
  if (prices.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const mean     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

// ============================================================
// SCORE (display only — not used for trade decisions)
// ============================================================
function computeScore(rsi, isBreakout, isBreakdown, volatility, risePct, fallPct) {
  let score = 50;
  if (rsi > 70) score += 20;
  else if (rsi < 30) score -= 20;
  if (risePct > 60) score += 10;
  else if (fallPct > 60) score -= 10;
  score += volatility * 2;
  return Math.min(100, Math.max(0, score));
}

module.exports = { computeMetrics };
