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
//  DEFAULT CONFIG (Price Action + MA Confirmation)
// =====================================================================
const DEFAULT_CONFIG = {
    // ---------- Price Action ----------
    SUPPORT_RESISTANCE_LOOKBACK: 50,    // ticks to scan for levels
    MIN_BOUNCES: 2,                     // minimum touches to confirm a level
    TOUCH_TOLERANCE: 0.2,               // % tolerance for level touches
    BREAKOUT_THRESHOLD: 0.1,            // % above resistance to confirm breakout
    BREAKDOWN_THRESHOLD: 0.1,           // % below support to confirm breakdown

    // ---------- MA Confirmation ----------
    FAST_MA_PERIOD: 8,
    SLOW_MA_PERIOD: 21,
    MIN_SPREAD_PERCENT: 0.15,

    // ---------- Volatility ----------
    MIN_VOLATILITY_PERCENT: 0.4,

    // ---------- Trade Execution ----------
    DURATION_TICKS: 10,
    MIN_TRIGGER_INTERVAL: 20000,
    MAX_CONSECUTIVE_LOSSES: 2,
    LOSS_COOLDOWN_MS: 120000,
    RISK_PERCENT: 1,
    TP_PERCENT: 5,
    SL_PERCENT: 10,
    MIN_STAKE: 0.35,
    COOLDOWN_TICKS: 1,
    SETTLE_TICKS: 5,
    SETTLEMENT_TIMEOUT_MS: 10000,
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
        CONFIG = { ...DEFAULT_CONFIG, ...newConfig };
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

// --- REQUIRED: Live Logging System ---
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

// ---------- SSE ENDPOINT ----------
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

// ---------- CONTROL ENDPOINT ----------
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

// ---------- Markets Configuration ----------
const MARKETS = {
  'R_10':  { id: 'R_10',  name: 'Volatility 10 Index' },
  'R_25':  { id: 'R_25',  name: 'Volatility 25 Index' },
  'R_50':  { id: 'R_50',  name: 'Volatility 50 Index' },
  'R_75':  { id: 'R_75',  name: 'Volatility 75 Index' },
  'R_100': { id: 'R_100', name: 'Volatility 100 Index' }
};
const BUFFER_CAPACITY = 1000;

// ---------- Pipeline Class ----------
class MultiMarketPipeline {
  constructor() {
    this.buffers = {};
    this.lastPrices = {};
    for (const symbol in MARKETS) {
      this.buffers[symbol] = [];
      this.lastPrices[symbol] = null;
    }
  }

  _ma(arr, period) {
    if (arr.length < period) return null;
    const slice = arr.slice(-period);
    return slice.reduce((a,b) => a+b, 0) / period;
  }

  _volatility(arr, period) {
    if (arr.length < period) return 0;
    const slice = arr.slice(-period);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    if (min === 0) return 0;
    return (max - min) / min * 100;
  }

  feed(symbol, price) {
    const buf = this.buffers[symbol];
    buf.push(price);
    if (buf.length > BUFFER_CAPACITY) buf.shift();
    this.lastPrices[symbol] = price;

    const fastMA = this._ma(buf, CONFIG.FAST_MA_PERIOD);
    const slowMA = this._ma(buf, CONFIG.SLOW_MA_PERIOD);
    const vol = this._volatility(buf, 20);

    // --- Support/Resistance Detection ---
    const sr = this._findSupportResistance(buf);
    const isBreakout = this._detectBreakout(price, sr);
    const isBreakdown = this._detectBreakdown(price, sr);
    const step = this._getEntryStep(price, sr, fastMA, slowMA, vol);

    const result = {
      symbol,
      price,
      fastMA,
      slowMA,
      volatility: vol,
      support: sr.support,
      resistance: sr.resistance,
      isBreakout,
      isBreakdown,
      step, // 0,1,2,3
      lastPrices: buf.slice(-5)
    };

    state.marketMetrics[symbol] = result;
    return result;
  }

  _findSupportResistance(buf) {
    const lookback = Math.min(CONFIG.SUPPORT_RESISTANCE_LOOKBACK, buf.length);
    if (lookback < 10) return { support: null, resistance: null };

    const recent = buf.slice(-lookback);
    const tolerance = CONFIG.TOUCH_TOLERANCE / 100;

    // Find local lows (support) and local highs (resistance)
    const lows = [];
    const highs = [];

    for (let i = 2; i < recent.length - 2; i++) {
      if (recent[i] < recent[i-1] && recent[i] < recent[i-2] && recent[i] < recent[i+1] && recent[i] < recent[i+2]) {
        lows.push(recent[i]);
      }
      if (recent[i] > recent[i-1] && recent[i] > recent[i-2] && recent[i] > recent[i+1] && recent[i] > recent[i+2]) {
        highs.push(recent[i]);
      }
    }

    // Find most significant support (clustered lows)
    let support = null;
    let supportBounces = 0;
    const sortedLows = lows.sort((a,b) => a - b);
    for (let i = 0; i < sortedLows.length; i++) {
      let count = 1;
      for (let j = i + 1; j < sortedLows.length; j++) {
        if (Math.abs(sortedLows[j] - sortedLows[i]) / sortedLows[i] < tolerance) {
          count++;
        }
      }
      if (count > supportBounces) {
        supportBounces = count;
        support = sortedLows[i];
      }
    }

    // Find most significant resistance
    let resistance = null;
    let resistanceBounces = 0;
    const sortedHighs = highs.sort((a,b) => a - b);
    for (let i = sortedHighs.length - 1; i >= 0; i--) {
      let count = 1;
      for (let j = i - 1; j >= 0; j--) {
        if (Math.abs(sortedHighs[j] - sortedHighs[i]) / sortedHighs[i] < tolerance) {
          count++;
        }
      }
      if (count > resistanceBounces) {
        resistanceBounces = count;
        resistance = sortedHighs[i];
      }
    }

    // Only return if enough bounces
    if (supportBounces < CONFIG.MIN_BOUNCES) support = null;
    if (resistanceBounces < CONFIG.MIN_BOUNCES) resistance = null;

    return { support, resistance };
  }

  _detectBreakout(price, sr) {
    if (!sr.resistance) return false;
    const threshold = CONFIG.BREAKOUT_THRESHOLD / 100;
    return price > sr.resistance * (1 + threshold);
  }

  _detectBreakdown(price, sr) {
    if (!sr.support) return false;
    const threshold = CONFIG.BREAKDOWN_THRESHOLD / 100;
    return price < sr.support * (1 - threshold);
  }

  _getEntryStep(price, sr, fastMA, slowMA, vol) {
    // Step 3: Ready for entry (all conditions met)
    // Step 2: Near entry (price near level + MA aligned)
    // Step 1: Level detected (support/resistance exists)
    // Step 0: No setup

    if (!sr.support && !sr.resistance) return 0;

    let step = 0;

    // Step 1: Level exists
    if (sr.support || sr.resistance) step = 1;

    // Step 2: Price near level OR MA aligned
    let nearLevel = false;
    if (sr.resistance) {
      const dist = (sr.resistance - price) / price * 100;
      if (dist < 0.3 && dist > 0) nearLevel = true;
    }
    if (sr.support) {
      const dist = (price - sr.support) / price * 100;
      if (dist < 0.3 && dist > 0) nearLevel = true;
    }

    const maAligned = fastMA !== null && slowMA !== null && Math.abs(fastMA - slowMA) / price * 100 > CONFIG.MIN_SPREAD_PERCENT;
    const volOk = vol > CONFIG.MIN_VOLATILITY_PERCENT;

    if ((nearLevel || maAligned) && step === 1) step = 2;

    // Step 3: Breakout/breakdown confirmed + MA aligned + vol ok
    const isBreakout = this._detectBreakout(price, sr);
    const isBreakdown = this._detectBreakdown(price, sr);
    const directionAligned = (isBreakout && fastMA > slowMA) || (isBreakdown && fastMA < slowMA);

    if ((isBreakout || isBreakdown) && directionAligned && volOk && step >= 2) {
      step = 3;
    }

    return step;
  }
}

const engine = new MultiMarketPipeline();

// ============ STATE ============
const state = {
  active: false, tradingMode: 'demo', balance: null, currency: 'USD',
  sessionPnl: 0, dailyPnl: 0, dailyStartBalance: null,
  locked: false, lockReason: '',
  tradeInProgress: false, activeRealTrade: null,
  settleTicksRemaining: 0, currentStake: 0.35,
  cooldownTicksLeft: 0, marketMetrics: {},
  logs: [], lastTriggerTime: 0,
  lossCooldownUntil: 0, pendingSettlement: false
};

// ============ STRATEGY CHECK (Price Action + MA) ============
function checkStrategy(symbol, metric) {
  if (!metric) return null;

  const { price, support, resistance, isBreakout, isBreakdown, fastMA, slowMA, volatility, step } = metric;

  // Must be step 3 (ready for entry)
  if (step < 3) return null;

  // Volatility filter
  if (volatility < CONFIG.MIN_VOLATILITY_PERCENT) return null;

  // MA confirmation
  const spread = fastMA !== null && slowMA !== null ? Math.abs(fastMA - slowMA) / price * 100 : 0;
  if (spread < CONFIG.MIN_SPREAD_PERCENT) return null;

  // Direction: breakout + MA bullish = CALL
  if (isBreakout && fastMA > slowMA) {
    return { direction: 'CALL', score: spread };
  }

  // Direction: breakdown + MA bearish = PUT
  if (isBreakdown && fastMA < slowMA) {
    return { direction: 'PUT', score: spread };
  }

  return null;
}

// ============ P&L SYNC & LIMITS ============
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

// ============ STATE PERSISTENCE ============
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

// ============ SETTLEMENT ============
function settleRealTrade() {
  if (!state.activeRealTrade || !state.activeRealTrade.contractId || state.balance == null) {
    if (state.activeRealTrade) {
      addLog("⚠️ Trade closed or never executed. Resetting state.");
      state.tradeInProgress = false;
      state.activeRealTrade = null;
    }
    state.pendingSettlement = false;
    return;
  }

  const profit = state.balance - state.activeRealTrade.balanceBefore;
  state.sessionPnl += profit;
  state.dailyPnl += profit;

  const isWin = profit >= 0;
  const grossPayout = isWin ? (state.activeRealTrade.stake + profit) : 0;

  if (isWin) consecutiveLosses = 0;
  else {
    consecutiveLosses++;
    if (consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
      state.lossCooldownUntil = Date.now() + CONFIG.LOSS_COOLDOWN_MS;
      addLog(`⏳ ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses. Cooling down for ${CONFIG.LOSS_COOLDOWN_MS/60000} minutes.`);
    }
  }

  saveTradeToCloud({
    contract_id: state.activeRealTrade.contractId,
    asset: MARKETS[state.activeRealTrade.symbol]?.name || state.activeRealTrade.symbol,
    contractType: state.activeRealTrade.contractType,
    stake: state.activeRealTrade.stake,
    payout: grossPayout,
    isWin: isWin,
    barrier: null,
    exitTick: null,
    entry_price: state.activeRealTrade.entryPrice || null,
    exit_price: null,
    duration_ticks: state.activeRealTrade.duration || CONFIG.DURATION_TICKS
  });

  addLog(`[Settlement] ${state.activeRealTrade.symbol} | ${state.activeRealTrade.contractType} | Result: ${isWin ? '🟢 WIN (+$' : '🔴 LOSS (-$'}${Math.abs(profit).toFixed(2)}) | Session: $${state.sessionPnl.toFixed(2)} | Daily: $${state.dailyPnl.toFixed(2)}`);

  state.tradeInProgress = false;
  state.activeRealTrade = null;
  state.settleTicksRemaining = 0;
  state.cooldownTicksLeft = CONFIG.COOLDOWN_TICKS;
  state.pendingSettlement = false;

  const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  syncDailyPnlFromDB().then(() => { saveState(); broadcastSSE({ state: getFullState() }); });
}

let consecutiveLosses = 0;

// =====================================================================
// ENTRY LOGIC
// =====================================================================
function processLiveFeed(symbol, price) {
  if (state.pendingSettlement) { broadcastSSE({ state: getFullState() }); return; }
  if (state.settleTicksRemaining > 0) {
    state.settleTicksRemaining--;
    if (state.settleTicksRemaining === 0) {
      state.pendingSettlement = true;
      addLog(`⏳ ${CONFIG.SETTLE_TICKS} ticks elapsed. Waiting for balance update...`);
      setTimeout(() => {
        if (state.pendingSettlement) {
          addLog(`⚠️ Balance update timeout. Forcing settlement now.`);
          state.pendingSettlement = false;
          settleRealTrade();
        }
      }, CONFIG.SETTLEMENT_TIMEOUT_MS);
    }
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
  if (now < state.lossCooldownUntil) { broadcastSSE({ state: getFullState() }); return; }
  if (now - state.lastTriggerTime < CONFIG.MIN_TRIGGER_INTERVAL) { broadcastSSE({ state: getFullState() }); return; }

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
    state.pendingSettlement = false;
    state.tradeInProgress = true;
    const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
    state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

    const metric = state.marketMetrics[symbol];
    addLog(`🔥 Signal: ${symbol} | ${direction} | Support: ${metric.support?.toFixed(2) || 'N/A'} | Resistance: ${metric.resistance?.toFixed(2) || 'N/A'}`);

    state.activeRealTrade = {
      symbol, stake: state.currentStake, balanceBefore: state.balance,
      contractType: direction, barrier: null, direction: direction,
      entryPrice: null, duration: CONFIG.DURATION_TICKS
    };

    state.lastTriggerTime = now;
    addLog(`📤 Requesting ${direction} proposal for ${symbol} (${CONFIG.DURATION_TICKS} ticks)...`);
    send({
      proposal: 1, amount: state.currentStake, basis: 'stake',
      contract_type: direction, currency: state.currency || 'USD',
      duration: CONFIG.DURATION_TICKS, duration_unit: 't',
      underlying_symbol: symbol, req_id: ++reqId
    });
  }
  broadcastSSE({ state: getFullState() });
}

// ------------------ WEBSOCKET CONNECTION ------------------
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

function handleMessage(msg) {
  if (msg.error) {
    addLog(`API Error: ${msg.error.message}`);
    state.tradeInProgress = false;
    state.activeRealTrade = null;
    state.settleTicksRemaining = 0;
    state.pendingSettlement = false;
    return;
  }

  if (msg.msg_type === 'proposal') {
    if (msg.error) {
      addLog(`❌ Proposal Error: ${msg.error.message}`);
      state.tradeInProgress = false;
      state.activeRealTrade = null;
      state.pendingSettlement = false;
    } else {
      send({ buy: msg.proposal.id, price: msg.proposal.ask_price, req_id: ++reqId });
      addLog(`✅ Proposal confirmed: ${msg.proposal.ask_price}. Executing buy...`);
    }
    return;
  }

  if (msg.msg_type === 'balance') {
    state.balance = parseFloat(msg.balance.balance);
    if (state.pendingSettlement && state.activeRealTrade) {
      state.pendingSettlement = false;
      settleRealTrade();
    }
    if (state.dailyPnl !== undefined) {
      state.dailyStartBalance = state.balance - state.dailyPnl;
    }
    broadcastSSE({ state: getFullState() });
  }
  else if (msg.msg_type === 'history') {
    const symbol = msg.echo_req.ticks_history;
    const prices = msg.history.prices.map(p => parseFloat(p));
    prices.forEach(p => engine.feed(symbol, p));
    addLog(`✅ History synchronized for ${symbol}`);
    send({ ticks: symbol, subscribe: 1, req_id: ++reqId });
  }
  else if (msg.msg_type === 'tick') {
    processLiveFeed(msg.tick.symbol, parseFloat(msg.tick.quote));
  }
  else if (msg.msg_type === 'buy') {
    if (state.activeRealTrade) {
      state.activeRealTrade.contractId = msg.buy.contract_id;
      state.activeRealTrade.entryPrice = msg.buy.price;
      state.settleTicksRemaining = CONFIG.SETTLE_TICKS;
      addLog(`💰 Trade Executed: Contract ID ${msg.buy.contract_id} at price ${msg.buy.price}`);
    }
  }
}

// ------------------ MANUAL TRADING ------------------ //
app.post('/api/manual-trade', (req, res) => {
  const { symbol, contractType, duration, durationUnit } = req.body;
  
  if (state.locked || state.tradeInProgress) {
    return res.status(400).json({ error: state.locked ? state.lockReason : 'Trade in progress.' });
  }
  if (!MARKETS[symbol]) return res.status(400).json({ error: 'Invalid symbol.' });
  if (!['CALL', 'PUT'].includes(contractType)) {
    return res.status(400).json({ error: 'Invalid contract type. Use "CALL" or "PUT".' });
  }

  let dur = parseInt(duration) || CONFIG.DURATION_TICKS;
  let unit = durationUnit || 't';
  if (unit === 't') { if (dur < 1) dur = 1; if (dur > 10) dur = 10; }
  if (unit === 's') { if (dur < 5) dur = 5; if (dur > 600) dur = 600; }
  if (unit === 'm') { if (dur < 1) dur = 1; if (dur > 10) dur = 10; }

  const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;
  state.pendingSettlement = false;
  state.tradeInProgress = true;

  state.activeRealTrade = {
    symbol, stake: state.currentStake, balanceBefore: state.balance,
    contractType, barrier: null, direction: contractType,
    entryPrice: null, duration: dur
  };

  send({
    proposal: 1, amount: state.currentStake, basis: 'stake',
    contract_type: contractType, currency: state.currency || 'USD',
    duration: dur, duration_unit: unit,
    underlying_symbol: symbol, req_id: ++reqId
  });

  addLog(`📤 Manual ${contractType} request for ${symbol} (${dur} ${unit === 't' ? 'ticks' : unit === 's' ? 'seconds' : 'minutes'})...`);
  res.json({ success: true, message: 'Proposal requested' });
});

// ------------------ PERIODIC P&L SYNC ------------------
setInterval(() => {
  if (state.balance !== null) {
    syncDailyPnlFromDB().catch(err => console.error('Periodic sync error:', err));
  }
}, CONFIG.PNL_SYNC_INTERVAL_MS);

// ------------------ STARTUP ------------------
loadState();
checkDatabaseConnection().then(() => {
  connectDeriv();
  server.listen(PORT, () => console.log(`🚀 System Armed on port ${PORT}`));
});
