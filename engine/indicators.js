// engine/indicators.js

function computeMetrics(symbol, prices, config = {}, bandwidthHistory = []) {
  if (!prices || prices.length < 2) return null;

  const lastPrice = prices[prices.length - 1];

  // Use configured lookback for S/R (default 500)
  const lookback = config.ANALYSIS_WINDOW || 500;
  const recentPrices = prices.slice(-lookback);

  // Support = lowest low, Resistance = highest high in the lookback window
  const support = Math.min(...recentPrices);
  const resistance = Math.max(...recentPrices);

  // Normalised channel split (Support% + Resistance% = 100%)
  let supportPct = null;
  let resistancePct = null;
  const range = resistance - support;
  if (range > 0) {
    supportPct = ((resistance - lastPrice) / range) * 100;
    resistancePct = ((lastPrice - support) / range) * 100;
  } else {
    supportPct = 50;
    resistancePct = 50;
  }

  // Bollinger Bands
  const { upper, middle, lower, bandwidth } = computeBollinger(prices, config.BOLLINGER_PERIOD || 20, config.BOLLINGER_STD || 2);

  // RSI
  const rsi = computeRSI(prices, config.RSI_PERIOD || 20);

  // Volatility
  const volatility = computeVolatility(prices);

  // Tick direction ratios (Rise/Fall %)
  const tickDirections = prices.slice(1).map((p, i) => p > prices[i] ? 1 : (p < prices[i] ? -1 : 0));
  const totalTicks = tickDirections.length;
  const upCount = tickDirections.filter(d => d === 1).length;
  const downCount = tickDirections.filter(d => d === -1).length;
  const risePct = totalTicks > 0 ? (upCount / totalTicks) * 100 : 0;
  const fallPct = totalTicks > 0 ? (downCount / totalTicks) * 100 : 0;

  // Bollinger Squeeze percentile
  let squeezePercentile = null;
  if (bandwidth !== null && bandwidth !== undefined && bandwidthHistory.length >= 20) {
    const count = bandwidthHistory.reduce((sum, bw) => sum + (bw >= bandwidth ? 1 : 0), 0);
    squeezePercentile = (count / bandwidthHistory.length) * 100;
  }

  const isBreakout = lastPrice > resistance;
  const isBreakdown = lastPrice < support;

  const score = computeScore(rsi, isBreakout, isBreakdown, volatility, risePct, fallPct);

  return {
    price: lastPrice,
    step: isBreakout || isBreakdown ? 3 : (resistancePct < 5 ? 2 : 1),   // close to resistance edge
    support,
    resistance,
    isBreakout,
    isBreakdown,
    rsi,
    volatility,
    score,
    bandwidth,
    squeezePercentile,
    tickDirections: tickDirections.slice(-20),
    supportPct,
    resistancePct,
    risePct,
    fallPct,
    lastPrices: prices.slice(-20),
  };
}

// --- unchanged helper functions ---

function computeRSI(prices, period) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function computeBollinger(prices, period, stdDev) {
  if (prices.length < period) return { upper: null, middle: null, lower: null, bandwidth: null };
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mean + stdDev * std;
  const lower = mean - stdDev * std;
  const bandwidth = ((upper - lower) / mean) * 100;
  return { upper, middle: mean, lower, bandwidth };
}

function computeSupportResistance(prices) {
  // Not used externally, kept for backward compatibility if needed
  if (prices.length < 10) return { support: null, resistance: null };
  const recent = prices.slice(-50);
  return { support: Math.min(...recent), resistance: Math.max(...recent) };
}

function computeVolatility(prices) {
  if (prices.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

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
