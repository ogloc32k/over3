require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const { supabase, saveTradeToCloud } = require('./database.js');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const STATE_FILE = '/var/data/deriv_multimarket_state.json';
const CONFIG_FILE = '/var/data/deriv_config.json';

// =====================================================================
//  DEFAULT CONFIG
// =====================================================================
const DEFAULT_CONFIG = {
    // ---------- Trade Execution ----------
    DURATION: 15,                     // seconds if >=15, ticks if <=10
    MAX_CONSECUTIVE_LOSSES: 3,
    LOSS_COOLDOWN_MS: 300000,
    COOLDOWN_TICKS: 5,

    // ---------- Strategy ----------
    ANALYSIS_WINDOW: 500,
    BOLLINGER_PERIOD: 20,
    BOLLINGER_STD: 2,
    RSI_PERIOD: 20,
    MIN_VOLATILITY_PERCENT: 0.3,

    // ---------- Risk ----------
    RISK_PERCENT: 1,
    TP_PERCENT: 5,
    SL_PERCENT: 10,
    MIN_STAKE: 0.35,

    // ---------- Timing ----------
    MIN_TRIGGER_INTERVAL: 30000,
    SETTLEMENT_TIMEOUT_MS: 15000,
    PNL_SYNC_INTERVAL_MS: 300000
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            return { ...DEFAULT_CONFIG, ...saved };
        }
    } catch(e) {}
    return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
    try {
        const dir = path.dirname(CONFIG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch(e) {}
}

let CONFIG = loadConfig();

// =====================================================================
//  SCHEDULED RESTART
// =====================================================================
function scheduleRestart() {
  const now = Date.now();
  const nextMidnightUTC = new Date(now);
  nextMidnightUTC.setUTCHours(0, 0, 0, 0);
  if (nextMidnightUTC.getTime() < now) {
    nextMidnightUTC.setUTCDate(nextMidnightUTC.getUTCDate() + 1);
  }
  const delay = nextMidnightUTC.getTime() - now;
  console.log(`⏰ Next restart scheduled at ${nextMidnightUTC.toISOString()} (03:00 EAT)`);
  setTimeout(() => {
    console.log('🔄 Scheduled restart at 03:00 EAT. Resetting daily state...');
    state.locked = false;
    state.lockReason = '';
    saveState();
    process.exit(0);
  }, delay);
}
scheduleRestart();

// --- DATABASE HEALTH CHECK ---
async function checkDatabaseConnection() {
  try {
    const { count, error } = await supabase
      .from('trading_ledger')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    console.log(`✅ Supabase Database Connected (Total Records: ${count})`);
    return true;
  } catch (err) {
    console.error(`❌ Database Connection Failed: ${err.message}`);
    return false;
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// =====================================================================
//  CONFIG API
// =====================================================================
app.get('/api/config', (req, res) => { res.json(CONFIG); });

app.post('/api/config', (req, res) => {
    try {
        const newConfig = req.body;
        if (typeof newConfig !== 'object') throw new Error('Invalid config');
        CONFIG = { ...CONFIG, ...newConfig };
        saveConfig(CONFIG);
        res.json({ success: true, config: CONFIG });
    } catch(err) {
        res.status(400).json({ error: err.message });
    }
});

// =====================================================================
//  ANALYTICS API
// =====================================================================
app.get('/api/ledger/analytics', async (req, res) => {
  const { start, end, mode } = req.query;

  if (mode === 'session') {
    const settlements = state.logs ? state.logs.filter(l => l.message.includes('Settlement')) : [];
    const wins = settlements.filter(l => l.message.includes('WIN')).length;
    const strikeRate = settlements.length > 0 ? ((wins / settlements.length) * 100).toFixed(1) : 0;
    return res.json({
      totalProfit: state.sessionPnl || 0,
      strikeRate: strikeRate,
      totalTrades: settlements.length,
      rawData: []
    });
  }

  let startDate = start, endDate = end;
  const now = new Date();
  if (mode === 'hour') {
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    startDate = oneHourAgo.toISOString();
    endDate = now.toISOString();
  } else if (mode === '24h') {
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    startDate = oneDayAgo.toISOString();
    endDate = now.toISOString();
  } else if (mode === 'month') {
    const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    startDate = oneMonthAgo.toISOString();
    endDate = now.toISOString();
  } else if (mode === '6months') {
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    startDate = sixMonthsAgo.toISOString();
    endDate = now.toISOString();
  } else if (mode === '1year') {
    const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    startDate = oneYearAgo.toISOString();
    endDate = now.toISOString();
  }

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Invalid date range. Please provide start and end dates.' });
  }

  try {
    const { data, error } = await supabase
      .from('trading_ledger')
      .select('*')
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    if (error) throw error;

    const totalProfit = data.reduce((acc, curr) => acc + (curr.profit_loss || 0), 0);
    const totalTrades = data.length;
    const wins = data.filter(t => t.is_win).length;
    const strikeRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;

    let grossProfit = 0, grossLoss = 0;
    data.forEach(t => {
      const pnl = t.profit_loss || 0;
      if (pnl > 0) grossProfit += pnl;
      else if (pnl < 0) grossLoss += Math.abs(pnl);
    });
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);

    const sorted = data.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    let peak = 0, maxDrawdown = 0, cum = 0;
    sorted.forEach(t => {
      cum += (t.profit_loss || 0);
      if (cum > peak) peak = cum;
      const drawdown = peak - cum;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    });
    const drawdownPercent = (peak > 0) ? (maxDrawdown / peak) * 100 : 0;

    res.json({
      totalProfit: totalProfit.toFixed(2),
      strikeRate,
      totalTrades,
      profitFactor: profitFactor.toFixed(2),
      drawdown: drawdownPercent.toFixed(2),
      rawData: data
    });
  } catch (err) {
    console.error('❌ Analytics Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch historical data' });
  }
});

// =====================================================================
//  SSE & LOGGING
// =====================================================================
const sseClients = new Set();
let logId = 1;

function addLog(msg) {
  const entry = { id: logId++, time: new Date().toISOString(), message: msg };
  state.logs.unshift(entry);
  if (state.logs.length > 250) state.logs.pop();
  broadcastSSE({ logs: [entry], state: getFullState() });
}

function getFullState() {
  const { logs, ...rest } = state;
  return { ...rest, marketMetrics: state.marketMetrics || {} };
}

function broadcastSSE(payload) {
  if (!payload.state) payload.state = getFullState();
  if (payload.state && !payload.state.marketMetrics) {
    payload.state.marketMetrics = state.marketMetrics || {};
  }
  sseClients.forEach(c => c.write(`data: ${JSON.stringify(payload)}\n\n`));
}

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const client = res;
  sseClients.add(client);
  client.write(`data: ${JSON.stringify({ state: getFullState(), logs: state.logs.slice(0, 50) })}\n\n`);
  req.on('close', () => {
    sseClients.delete(client);
    client.end();
  });
});

// =====================================================================
//  CONTROL API
// =====================================================================
app.post('/api/control', (req, res) => {
  const { action, mode } = req.body;
  if (action === 'start') {
    state.active = true;
    let msg = '🔓 Automation matrix ARMED by user.';
    if (state.locked) {
      msg = `🔓 Automation matrix ARMED (paused until midnight): ${state.lockReason}`;
      addLog(msg);
      return res.json({ success: true, message: msg });
    }
    addLog(msg);
    return res.json({ success: true });
  }
  if (action === 'stop') {
    state.active = false;
    addLog('🔒 Automation matrix DISARMED by user.');
    return res.json({ success: true });
  }
  if (action === 'set_mode') {
    if (!mode || !['demo', 'real'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Use "demo" or "real".' });
    }
    state.tradingMode = mode;
    state.active = false;
    addLog(`🔄 Switching to ${mode.toUpperCase()} account. Reconnecting...`);
    disconnectDeriv();
    setTimeout(connectDeriv, 1000);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Unknown action.' });
});

// =====================================================================
//  MARKETS & DECIMAL PLACES
// =====================================================================
const MARKETS = {
  'R_10':  { id: 'R_10',  name: 'Volatility 10 Index' },
  'R_25':  { id: 'R_25',  name: 'Volatility 25 Index' },
  'R_50':  { id: 'R_50',  name: 'Volatility 50 Index' },
  'R_75':  { id: 'R_75',  name: 'Volatility 75 Index' },
  'R_100': { id: 'R_100', name: 'Volatility 100 Index' }
};

// ---- Exact decimal places per market ----
const MARKET_DECIMALS = {
  'R_10':  2,
  'R_25':  3,
  'R_50':  4,
  'R_75':  4,
  'R_100': 2
};

function formatMarketPrice(symbol, rawPrice) {
  const decimals = MARKET_DECIMALS[symbol] || 2;
  return Number(rawPrice).toFixed(decimals);
}

const BUFFER_CAPACITY = 2000;
const BUFFER_CLEANUP_THRESHOLD = 2200;

// =====================================================================
//  PIPELINE – BUFFER OPTIMIZED
// =====================================================================
class MultiMarketPipeline {
  constructor() {
    this.buffers = {};
    this.lastPrices = {};
    for (const symbol in MARKETS) {
      this.buffers[symbol] = [];
      this.lastPrices[symbol] = null;
    }
  }

  _sma(arr, period) {
    if (arr.length < period) return null;
    const slice = arr.slice(-period);
    return slice.reduce((a,b) => a+b, 0) / period;
  }

  _stdDev(arr, period) {
    if (arr.length < period) return 0;
    const slice = arr.slice(-period);
    const mean = slice.reduce((a,b) => a+b, 0) / period;
    const squaredDiffs = slice.map(x => Math.pow(x - mean, 2));
    return Math.sqrt(squaredDiffs.reduce((a,b) => a+b, 0) / period);
  }

  _rsi(arr, period) {
    if (arr.length < period + 1) return 50;
    const slice = arr.slice(-period - 1);
    let gains = 0, losses = 0;
    for (let i = 1; i < slice.length; i++) {
      const diff = slice[i] - slice[i-1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  _bollinger(arr, period, stdDev) {
    const middle = this._sma(arr, period);
    if (middle === null) return { upper: null, lower: null, middle: null };
    const std = this._stdDev(arr, period);
    return {
      upper: middle + (stdDev * std),
      lower: middle - (stdDev * std),
      middle: middle
    };
  }

  _volatility(arr, period) {
    if (arr.length < period) return 0;
    const slice = arr.slice(-period);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    if (min === 0) return 0;
    return (max - min) / min * 100;
  }

  _findSupportResistance(window) {
    const lookback = Math.min(50, window.length);
    if (lookback < 10) {
      const price = window[window.length - 1];
      return { support: price * 0.98, resistance: price * 1.02 };
    }
    const recent = window.slice(-lookback);
    const min = Math.min(...recent);
    const max = Math.max(...recent);
    return { support: min, resistance: max };
  }

  feed(symbol, price) {
    const buf = this.buffers[symbol];
    buf.push(price);

    if (buf.length > BUFFER_CLEANUP_THRESHOLD) {
      this.buffers[symbol] = buf.slice(-BUFFER_CAPACITY);
    }

    this.lastPrices[symbol] = price;

    const analysisWindow = Math.min(CONFIG.ANALYSIS_WINDOW, buf.length);
    if (analysisWindow < 50) {
      const result = {
        symbol, price,
        formattedPrice: formatMarketPrice(symbol, price),
        risePct: 0, fallPct: 0,
        rsi: 50,
        bbUpper: null, bbLower: null, bbMiddle: null,
        support: null, resistance: null,
        fastMA: null, slowMA: null,
        isBreakout: false, isBreakdown: false,
        step: 0, score: 0,
        volatility: 0,
        lastPrices: buf.slice(-5),
        conditions: { breakout: false, rsi: false, bollinger: false, volatility: false, ma: false }
      };
      state.marketMetrics[symbol] = result;
      return result;
    }

    const window = buf.slice(-analysisWindow);
    let rises = 0, falls = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i] > window[i-1]) rises++;
      else if (window[i] < window[i-1]) falls++;
    }
    const risePct = (rises / window.length) * 100;
    const fallPct = (falls / window.length) * 100;

    const fastMA = this._sma(buf, 8);
    const slowMA = this._sma(buf, 21);
    const vol = this._volatility(buf, 20);
    const bb = this._bollinger(buf, CONFIG.BOLLINGER_PERIOD, CONFIG.BOLLINGER_STD);
    const rsi = this._rsi(buf, CONFIG.RSI_PERIOD);
    const sr = this._findSupportResistance(window);

    const isBreakout = sr.resistance ? price > sr.resistance * 1.001 : false;
    const isBreakdown = sr.support ? price < sr.support * 0.999 : false;

    const condBreakout = isBreakout;
    const condRSI = rsi >= 50 && rsi <= 85;
    const condBollinger = bb.upper !== null && price >= bb.upper * 0.999;
    const condVolatility = vol >= CONFIG.MIN_VOLATILITY_PERCENT;

    const condBreakdown = isBreakdown;
    const condRSIPut = rsi >= 15 && rsi <= 50;
    const condBollingerPut = bb.lower !== null && price <= bb.lower * 1.001;
    const condVolatilityPut = vol >= CONFIG.MIN_VOLATILITY_PERCENT;

    const callReady = condBreakout && condRSI && condBollinger && condVolatility;
    const putReady = condBreakdown && condRSIPut && condBollingerPut && condVolatilityPut;
    
    let step = 0, score = 0;
    if (callReady || putReady) {
      step = 3;
      score = vol;
    } else if ((condBreakout || condBreakdown) && (condRSI || condRSIPut) && (condBollinger || condBollingerPut)) {
      step = 2;
      score = vol * 0.5;
    } else if (sr.support || sr.resistance) {
      step = 1;
      score = vol * 0.3;
    }

    const result = {
      symbol, price,
      formattedPrice: formatMarketPrice(symbol, price),
      risePct, fallPct,
      rsi,
      bbUpper: bb.upper, bbLower: bb.lower, bbMiddle: bb.middle,
      fastMA, slowMA,
      support: sr.support, resistance: sr.resistance,
      isBreakout, isBreakdown,
      step, score,
      volatility: vol,
      lastPrices: buf.slice(-5),
      conditions: {
        breakout: condBreakout || condBreakdown,
        rsi: condRSI || condRSIPut,
        bollinger: condBollinger || condBollingerPut,
        volatility: condVolatility || condVolatilityPut,
        ma: true
      },
      condValues: {
        rsiValue: rsi,
        volValue: vol,
        maValue: fastMA !== null && slowMA !== null ? ((fastMA - slowMA) / price * 100) : 0
      },
      callReady, putReady
    };

    state.marketMetrics[symbol] = result;
    return result;
  }
}

const engine = new MultiMarketPipeline();

// =====================================================================
//  STATE
// =====================================================================
const state = {
  active: false,
  tradingMode: 'demo',
  balance: null,
  currency: 'USD',
  sessionPnl: 0,
  dailyPnl: 0,
  dailyStartBalance: null,
  locked: false,
  lockReason: '',
  tradeInProgress: false,
  activeRealTrade: null,
  currentStake: 0.35,
  cooldownTicksLeft: 0,
  marketMetrics: {},
  logs: [],
  lastTriggerTime: 0,
  lossCooldownUntil: 0,
  pendingSettlement: false
};

// =====================================================================
//  STRATEGY CHECK
// =====================================================================
function checkStrategy(symbol, metric) {
  if (!metric) return null;
  const { price, support, resistance, isBreakout, isBreakdown, rsi, bbUpper, bbLower, volatility } = metric;

  if (volatility < CONFIG.MIN_VOLATILITY_PERCENT) return null;

  if (isBreakout && bbUpper !== null && price >= bbUpper * 0.999 && rsi >= 50 && rsi <= 85) {
    return { direction: 'CALL', score: volatility };
  }

  if (isBreakdown && bbLower !== null && price <= bbLower * 1.001 && rsi >= 15 && rsi <= 50) {
    return { direction: 'PUT', score: volatility };
  }

  return null;
}

// =====================================================================
//  P&L SYNC & LIMITS
// =====================================================================
async function syncDailyPnlFromDB() {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const { data, error } = await supabase
      .from('trading_ledger')
      .select('profit_loss')
      .gte('created_at', todayStart.toISOString());
    if (error) throw error;
    const total = data.reduce((sum, row) => sum + (row.profit_loss || 0), 0);
    state.dailyPnl = total;
    if (state.balance !== null) state.dailyStartBalance = state.balance - state.dailyPnl;
    checkDailyLimits();
    broadcastSSE({ state: getFullState() });
    return total;
  } catch (err) { console.error('❌ Failed to sync daily P&L:', err.message); return 0; }
}

function checkDailyLimits() {
  if (state.dailyStartBalance === null || state.dailyStartBalance === 0) return false;
  const tpLimit = state.dailyStartBalance * (CONFIG.TP_PERCENT / 100);
  const slLimit = state.dailyStartBalance * (CONFIG.SL_PERCENT / 100);
  if (state.dailyPnl >= tpLimit) {
    state.locked = true;
    state.lockReason = `🎯 Daily Target Reached: +$${state.dailyPnl.toFixed(2)} (${CONFIG.TP_PERCENT}% of start). Trading paused. Will resume at midnight.`;
    addLog(state.lockReason);
    return true;
  }
  if (state.dailyPnl <= -slLimit) {
    state.locked = true;
    state.lockReason = `🛑 Daily Loss Limit Breached: -$${Math.abs(state.dailyPnl).toFixed(2)} (${CONFIG.SL_PERCENT}% of start). Trading paused. Will resume at midnight.`;
    addLog(state.lockReason);
    return true;
  }
  if (state.locked && state.dailyPnl < tpLimit && state.dailyPnl > -slLimit) {
    state.locked = false;
    state.lockReason = '';
    addLog('✅ Daily limits cleared. Trading resumed.');
  }
  return false;
}

// =====================================================================
//  STATE PERSISTENCE
// =====================================================================
function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      date: new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi" }),
      tradingMode: state.tradingMode,
      locked: state.locked,
      lockReason: state.lockReason,
      sessionActive: state.active,
      sessionPnl: state.sessionPnl
    }));
  } catch(e) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const today = new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi" });
      if (saved.date === today) {
        state.tradingMode = saved.tradingMode || 'demo';
        state.locked = saved.locked || false;
        state.lockReason = saved.lockReason || '';
        state.active = saved.sessionActive || false;
        state.sessionPnl = saved.sessionPnl || 0;
      } else {
        state.locked = false; state.lockReason = '';
        state.active = saved.sessionActive || false;
        state.sessionPnl = 0;
      }
    }
  } catch(e) {}
}

// =====================================================================
//  (REMOVED old settleRealTrade function - now handled by subscription)
// =====================================================================

let consecutiveLosses = 0;

// =====================================================================
//  PROCESS LIVE FEED
// =====================================================================
function processLiveFeed(symbol, price) {
  // Safety watchdog: if a trade is stuck for > 120s, reset
  if (state.tradeInProgress && state.activeRealTrade && state.activeRealTrade.executionTime) {
    const elapsedSeconds = (Date.now() - state.activeRealTrade.executionTime) / 1000;
    if (elapsedSeconds > 120) {
      addLog(`⚠️ WARNING: Trade stuck for ${elapsedSeconds.toFixed(1)}s. Force resetting.`);
      if (state.activeRealTrade.settlementTimeout) {
        clearTimeout(state.activeRealTrade.settlementTimeout);
      }
      state.tradeInProgress = false;
      state.activeRealTrade = null;
      state.pendingSettlement = false;
      send({ balance: 1, req_id: ++reqId });
      saveState();
      broadcastSSE({ state: getFullState() });
      return;
    }
  }

  if (state.pendingSettlement) {
    broadcastSSE({ state: getFullState() });
    return;
  }

  const metric = engine.feed(symbol, price);
  if (!metric) return;
  if (state.cooldownTicksLeft > 0) state.cooldownTicksLeft--;

  if (!state.active || state.locked || state.tradeInProgress || state.cooldownTicksLeft > 0) {
    broadcastSSE({ state: getFullState() });
    return;
  }

  const now = Date.now();
  if (now < state.lossCooldownUntil) {
    broadcastSSE({ state: getFullState() });
    return;
  }
  if (now - state.lastTriggerTime < CONFIG.MIN_TRIGGER_INTERVAL) {
    broadcastSSE({ state: getFullState() });
    return;
  }

  if (state.balance < CONFIG.MIN_STAKE) {
    state.locked = true;
    state.lockReason = '⚠️ Insufficient funds for minimum stake. Trading paused.';
    addLog(state.lockReason);
    broadcastSSE({ state: getFullState() });
    return;
  }

  let bestCandidate = null;
  let bestScore = -Infinity;

  for (const sym in MARKETS) {
    const m = state.marketMetrics[sym];
    if (!m) continue;
    const signal = checkStrategy(sym, m);
    if (signal && signal.score > bestScore) {
      bestScore = signal.score;
      bestCandidate = { symbol: sym, ...signal };
    }
  }

  if (bestCandidate) {
    const { symbol, direction } = bestCandidate;
    state.tradeInProgress = true;
    const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
    state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

    const metric = state.marketMetrics[symbol];
    addLog(`🔥 Signal: ${symbol} | ${direction} | RSI: ${metric.rsi.toFixed(1)} | Vol: ${metric.volatility.toFixed(2)}%`);

    let duration = CONFIG.DURATION;
    let unit = 's';
    if (duration <= 10) {
      unit = 't';
    } else {
      unit = 's';
    }

    state.activeRealTrade = {
      symbol,
      stake: state.currentStake,
      balanceBefore: state.balance,
      contractType: direction,
      barrier: null,
      direction: direction,
      entryPrice: null,
      executionTime: Date.now(),
      settlementTimeout: null,
      settled: false      // flag to prevent double settlement
    };

    state.lastTriggerTime = now;
    addLog(`📤 Requesting ${direction} proposal for ${symbol} (${duration} ${unit === 't' ? 'ticks' : 'seconds'})...`);
    send({
      proposal: 1,
      amount: state.currentStake,
      basis: 'stake',
      contract_type: direction,
      currency: state.currency || 'USD',
      duration: duration,
      duration_unit: unit,
      underlying_symbol: symbol,
      req_id: ++reqId
    });
  }
  broadcastSSE({ state: getFullState() });
}

// =====================================================================
//  WEBSOCKET CONNECTION
// =====================================================================
let derivWs = null;
let reqId = 0;
let keepAliveLoop = null;
let watchdogTimer = null;

function send(msg) { if (derivWs && derivWs.readyState === WebSocket.OPEN) derivWs.send(JSON.stringify(msg)); }

function disconnectDeriv() {
  clearInterval(keepAliveLoop);
  clearTimeout(watchdogTimer);
  if (derivWs) { derivWs.removeAllListeners(); try { derivWs.terminate(); } catch(e) {} derivWs = null; }
}

async function connectDeriv() {
  disconnectDeriv();
  const appId = (process.env.DERIV_APP_ID || '').trim();
  const token = (process.env.DERIV_PAT || '').trim();
  if (!appId || !token) { addLog('System Configuration Halt: Credentials missing.'); return; }

  try {
    const accRes = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' }
    });
    if (!accRes.ok) throw new Error('Authentication Denied.');

    const data = await accRes.json();
    const accList = Array.isArray(data.data) ? data.data : [data.data];
    const targetAccount = accList.find(a => a.account_type === state.tradingMode);
    if (!targetAccount) throw new Error(`Target profile missing: ${state.tradingMode}`);

    state.balance = parseFloat(targetAccount.balance);
    state.currency = targetAccount.currency || 'USD';

    await syncDailyPnlFromDB();
    broadcastSSE({ state: getFullState() });

    const otpRes = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${targetAccount.account_id}/otp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!otpRes.ok) throw new Error('Security allocation failure.');

    const otpData = await otpRes.json();
    derivWs = new WebSocket(otpData.data.url);

    derivWs.on('open', () => {
      addLog(`🌐 Connected. Balance: $${state.balance.toFixed(2)} | Session: $${state.sessionPnl.toFixed(2)}`);
      send({ balance: 1, subscribe: 1, req_id: ++reqId });
      for (const key in MARKETS) send({ ticks_history: key, count: BUFFER_CAPACITY, end: 'latest', req_id: ++reqId });

      setInterval(() => { broadcastSSE({ state: getFullState() }); }, 3000);

      keepAliveLoop = setInterval(() => {
        send({ ping: 1 });
        watchdogTimer = setTimeout(() => { if (derivWs) derivWs.terminate(); }, 3000);
      }, 15000);
    });

    derivWs.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.msg_type === 'ping') { clearTimeout(watchdogTimer); return; }
        handleMessage(msg);
      } catch(e) {}
    });

    derivWs.on('close', () => { disconnectDeriv(); setTimeout(connectDeriv, 2000); });
    derivWs.on('error', () => { if (derivWs) derivWs.terminate(); });
  } catch(e) {
    addLog(`Network Exception: ${e.message}.`);
    setTimeout(connectDeriv, 5000);
  }
}

// =====================================================================
//  MESSAGE HANDLER
// =====================================================================
function handleMessage(msg) {
  if (msg.error) {
    addLog(`API Error: ${msg.error.message}`);
    state.tradeInProgress = false;
    state.activeRealTrade = null;
    state.pendingSettlement = false;
    if (state.activeRealTrade && state.activeRealTrade.settlementTimeout) {
      clearTimeout(state.activeRealTrade.settlementTimeout);
    }
    return;
  }

  if (msg.msg_type === 'proposal') {
    if (msg.error) {
      addLog(`❌ Proposal Error: ${msg.error.message}`);
      state.tradeInProgress = false;
      state.activeRealTrade = null;
      state.pendingSettlement = false;
      if (state.activeRealTrade && state.activeRealTrade.settlementTimeout) {
        clearTimeout(state.activeRealTrade.settlementTimeout);
      }
    } else {
      send({ buy: msg.proposal.id, price: msg.proposal.ask_price, req_id: ++reqId });
      addLog(`✅ Proposal confirmed: ${msg.proposal.ask_price}. Executing buy...`);
    }
    return;
  }

  if (msg.msg_type === 'balance') {
    state.balance = parseFloat(msg.balance.balance);
    // If we still have a pending fallback settlement (old code), we could handle it, but we rely on subscription now.
    if (state.dailyPnl !== undefined) {
      state.dailyStartBalance = state.balance - state.dailyPnl;
    }
    broadcastSSE({ state: getFullState() });
    return;
  }

  if (msg.msg_type === 'history') {
    const symbol = msg.echo_req.ticks_history;
    const prices = msg.history.prices.map(p => parseFloat(p));
    prices.forEach(p => engine.feed(symbol, p));
    addLog(`✅ History synchronized for ${symbol}`);
    send({ ticks: symbol, subscribe: 1, req_id: ++reqId });
    return;
  }

  if (msg.msg_type === 'tick') {
    processLiveFeed(msg.tick.symbol, parseFloat(msg.tick.quote));
    return;
  }

  if (msg.msg_type === 'buy') {
    if (state.activeRealTrade) {
      const contractId = msg.buy.contract_id;
      state.activeRealTrade.contractId = contractId;
      state.activeRealTrade.entryPrice = msg.buy.price;
      state.activeRealTrade.executionTime = Date.now();

      addLog(`💰 Trade Executed: Contract ID ${contractId} at price ${msg.buy.price}`);

      // ---- SUBSCRIBE to contract updates ----
      send({
        proposal_open_contract: 1,
        contract_id: contractId,
        subscribe: 1,
        req_id: ++reqId
      });

      // ---- Safety fallback timeout (will only act if not settled via subscription) ----
      const durationMs = CONFIG.DURATION * 1000;
      const bufferMs = 15000;
      state.activeRealTrade.settlementTimeout = setTimeout(() => {
        if (state.activeRealTrade && !state.activeRealTrade.settled) {
          addLog(`⚠️ Contract ${contractId} not settled via subscription. Falling back to balance check.`);
          state.pendingSettlement = true;
          send({ balance: 1, req_id: ++reqId });
        }
      }, durationMs + bufferMs);
    }
    return;
  }

  // ---- NEW: Contract settlement via subscription ----
  if (msg.msg_type === 'proposal_open_contract') {
    const contract = msg.proposal_open_contract;
    // Only process if this contract matches the active trade
    if (!state.activeRealTrade || state.activeRealTrade.contractId !== contract.id) {
      return;
    }

    // If already settled, ignore
    if (state.activeRealTrade.settled) return;

    // Check if the contract is sold (settled)
    if (contract.is_sold === 1) {
      // Mark as settled to prevent double processing
      state.activeRealTrade.settled = true;
      clearTimeout(state.activeRealTrade.settlementTimeout);

      // Calculate profit/loss
      const profit = contract.profit || (contract.sell_price - contract.buy_price);
      const isWin = profit >= 0;

      // Update P&L
      state.sessionPnl += profit;
      state.dailyPnl += profit;
      if (isWin) consecutiveLosses = 0;
      else {
        consecutiveLosses++;
        if (consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
          state.lossCooldownUntil = Date.now() + CONFIG.LOSS_COOLDOWN_MS;
          addLog(`⏳ ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses. Cooldown for ${CONFIG.LOSS_COOLDOWN_MS/60000} minutes.`);
        }
      }

      // Save to cloud ledger
      const grossPayout = isWin ? (state.activeRealTrade.stake + profit) : 0;
      saveTradeToCloud({
        contract_id: contract.id,
        asset: MARKETS[state.activeRealTrade.symbol]?.name || state.activeRealTrade.symbol,
        contractType: state.activeRealTrade.contractType,
        stake: state.activeRealTrade.stake,
        payout: grossPayout,
        isWin: isWin,
        barrier: null,
        exitTick: null,
        entry_price: state.activeRealTrade.entryPrice,
        exit_price: contract.sell_price,
        duration_seconds: CONFIG.DURATION,
        duration_ticks: null
      });

      addLog(`[Settlement] ${state.activeRealTrade.symbol} | ${state.activeRealTrade.contractType} | Result: ${isWin ? '🟢 WIN (+$' : '🔴 LOSS (-$'}${Math.abs(profit).toFixed(2)}) | Session: $${state.sessionPnl.toFixed(2)} | Daily: $${state.dailyPnl.toFixed(2)}`);

      // Clean up trade state
      state.tradeInProgress = false;
      state.activeRealTrade = null;
      state.pendingSettlement = false;
      state.cooldownTicksLeft = CONFIG.COOLDOWN_TICKS;

      // Recalculate stake
      const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
      state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

      // Send FORGET to stop subscription
      send({ forget: contract.id, req_id: ++reqId });

      // Sync daily P&L & broadcast
      syncDailyPnlFromDB().then(() => {
        saveState();
        broadcastSSE({ state: getFullState() });
      });
    }
  }
}

// =====================================================================
//  MANUAL TRADING
// =====================================================================
app.post('/api/manual-trade', (req, res) => {
  const { symbol, contractType, duration, durationUnit } = req.body;
  
  if (state.locked || state.tradeInProgress) {
    return res.status(400).json({ error: state.locked ? state.lockReason : 'Trade in progress.' });
  }
  if (!MARKETS[symbol]) return res.status(400).json({ error: 'Invalid symbol.' });
  if (!['CALL', 'PUT'].includes(contractType)) {
    return res.status(400).json({ error: 'Invalid contract type. Use "CALL" or "PUT".' });
  }

  if (state.balance < CONFIG.MIN_STAKE) {
    return res.status(400).json({ error: 'Insufficient funds for minimum stake. Trading paused.' });
  }

  let dur = parseInt(duration) || CONFIG.DURATION;
  let unit = durationUnit || 's';
  if (unit === 't') { if (dur < 1) dur = 1; if (dur > 10) dur = 10; }
  if (unit === 's') { if (dur < 5) dur = 5; if (dur > 600) dur = 600; }
  if (unit === 'm') { if (dur < 1) dur = 1; if (dur > 10) dur = 10; }

  const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;
  state.tradeInProgress = true;

  state.activeRealTrade = {
    symbol,
    stake: state.currentStake,
    balanceBefore: state.balance,
    contractType,
    barrier: null,
    direction: contractType,
    entryPrice: null,
    executionTime: Date.now(),
    settlementTimeout: null,
    settled: false
  };

  send({
    proposal: 1,
    amount: state.currentStake,
    basis: 'stake',
    contract_type: contractType,
    currency: state.currency || 'USD',
    duration: dur,
    duration_unit: unit,
    underlying_symbol: symbol,
    req_id: ++reqId
  });

  addLog(`📤 Manual ${contractType} request for ${symbol} (${dur} ${unit === 't' ? 'ticks' : unit === 's' ? 'seconds' : 'minutes'})...`);
  res.json({ success: true, message: 'Proposal requested' });
});

// =====================================================================
//  PERIODIC SYNC
// =====================================================================
setInterval(() => {
  if (state.balance !== null) {
    syncDailyPnlFromDB().catch(err => console.error('Periodic sync error:', err));
  }
}, CONFIG.PNL_SYNC_INTERVAL_MS);

// =====================================================================
//  STARTUP
// =====================================================================
loadState();
checkDatabaseConnection().then(() => {
  connectDeriv();
  server.listen(PORT, () => console.log(`🚀 System Armed on port ${PORT}`));
});
