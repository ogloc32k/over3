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
const STRATEGIES_DIR = path.join(__dirname, 'strategies');

// =====================================================================
//  LOAD ALL BOT STRATEGIES
// =====================================================================
const bots = new Map(); // id -> { instance, config, active, state }

function loadStrategies() {
    if (!fs.existsSync(STRATEGIES_DIR)) {
        fs.mkdirSync(STRATEGIES_DIR, { recursive: true });
        console.log('📁 Created strategies directory. Please add bot files.');
        return;
    }
    const files = fs.readdirSync(STRATEGIES_DIR).filter(f => f.endsWith('.js'));
    for (const file of files) {
        try {
            const bot = require(path.join(STRATEGIES_DIR, file));
            if (!bot.id || !bot.name || typeof bot.evaluate !== 'function') {
                console.warn(`⚠️ Skipping ${file}: missing id, name, or evaluate function.`);
                continue;
            }
            // Default config if not provided
            if (!bot.config) bot.config = {};
            // Default allow_reconfigure
            if (bot.allow_reconfigure === undefined) bot.allow_reconfigure = true;
            // Store bot instance
            bots.set(bot.id, {
                instance: bot,
                config: { ...bot.config }, // copy default config
                active: false,              // not running by default
                state: {}                   // per‑bot internal state (if needed)
            });
            console.log(`✅ Loaded bot: ${bot.name} (${bot.id})`);
        } catch(err) {
            console.error(`❌ Failed to load ${file}:`, err.message);
        }
    }
}
loadStrategies();

// =====================================================================
//  DEFAULT CONFIG (shared across bots)
// =====================================================================
const DEFAULT_CONFIG = {
    ANALYSIS_WINDOW: 500,
    BOLLINGER_PERIOD: 20,
    BOLLINGER_STD: 2,
    RSI_PERIOD: 20,
    MIN_VOLATILITY_PERCENT: 0.3,
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

// =====================================================================
//  DATABASE HEALTH CHECK
// =====================================================================
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
//  CONFIG API (shared)
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
//  BOT MANAGEMENT API
// =====================================================================

// List all bots (with their active status and current config)
app.get('/api/bots', (req, res) => {
    const list = [];
    for (const [id, entry] of bots) {
        list.push({
            id,
            name: entry.instance.name,
            description: entry.instance.description || '',
            allow_reconfigure: entry.instance.allow_reconfigure,
            active: entry.active,
            config: entry.config
        });
    }
    res.json(list);
});

// Start or reconfigure a bot
app.post('/api/bots/:id/start', (req, res) => {
    const { id } = req.params;
    const entry = bots.get(id);
    if (!entry) return res.status(404).json({ error: 'Bot not found' });

    // If bot allows reconfiguration, merge new config from body
    if (entry.instance.allow_reconfigure && req.body.config) {
        entry.config = { ...entry.config, ...req.body.config };
    }
    entry.active = true;
    // Reset bot state if needed
    entry.state = {};
    addLog(`🚀 Bot ${entry.instance.name} (${id}) started.`);
    res.json({ success: true, config: entry.config });
});

// Stop a bot
app.post('/api/bots/:id/stop', (req, res) => {
    const { id } = req.params;
    const entry = bots.get(id);
    if (!entry) return res.status(404).json({ error: 'Bot not found' });
    entry.active = false;
    addLog(`🛑 Bot ${entry.instance.name} (${id}) stopped.`);
    res.json({ success: true });
});

// =====================================================================
//  ANALYTICS (with optional bot filter)
// =====================================================================
app.get('/api/ledger/analytics', async (req, res) => {
  const { start, end, mode, bot } = req.query;

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
    let query = supabase
      .from('trading_ledger')
      .select('*')
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    if (bot) {
      query = query.eq('bot_name', bot);
    }

    const { data, error } = await query;
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
//  SSE & LOGGING (same as before)
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
  return { ...rest, marketMetrics: state.marketMetrics || {}, bots: getBotsStatus() };
}

function getBotsStatus() {
    const status = {};
    for (const [id, entry] of bots) {
        status[id] = {
            active: entry.active,
            name: entry.instance.name,
            config: entry.config
        };
    }
    return status;
}

function broadcastSSE(payload) {
  if (!payload.state) payload.state = getFullState();
  if (payload.state && !payload.state.marketMetrics) {
    payload.state.marketMetrics = state.marketMetrics || {};
  }
  if (payload.state && !payload.state.bots) {
    payload.state.bots = getBotsStatus();
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
//  CONTROL API (legacy, but we keep it for manual override)
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
//  MARKETS & PIPELINE (unchanged)
// =====================================================================
const MARKETS = {
  'R_10':  { id: 'R_10',  name: 'Volatility 10 Index' },
  'R_25':  { id: 'R_25',  name: 'Volatility 25 Index' },
  'R_50':  { id: 'R_50',  name: 'Volatility 50 Index' },
  'R_75':  { id: 'R_75',  name: 'Volatility 75 Index' },
  'R_100': { id: 'R_100', name: 'Volatility 100 Index' }
};
const BUFFER_CAPACITY = 2000;
const BUFFER_CLEANUP_THRESHOLD = 2200;

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
//  STATE (global)
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
//  P&L SYNC & LIMITS (shared)
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
//  SETTLEMENT (shared)
// =====================================================================
function settleRealTrade() {
  if (!state.activeRealTrade || !state.activeRealTrade.contractId || state.balance == null) {
    if (state.activeRealTrade) {
      addLog("⚠️ Trade closed or never executed. Resetting state.");
      state.tradeInProgress = false;
      state.activeRealTrade = null;
    }
    state.pendingSettlement = false;
    if (state.activeRealTrade && state.activeRealTrade.settlementTimeout) {
      clearTimeout(state.activeRealTrade.settlementTimeout);
    }
    return;
  }

  if (state.balance < CONFIG.MIN_STAKE) {
    state.locked = true;
    state.lockReason = '⚠️ Insufficient funds for minimum stake. Trading paused.';
    addLog(state.lockReason);
    state.tradeInProgress = false;
    state.activeRealTrade = null;
    state.pendingSettlement = false;
    if (state.activeRealTrade && state.activeRealTrade.settlementTimeout) {
      clearTimeout(state.activeRealTrade.settlementTimeout);
    }
    broadcastSSE({ state: getFullState() });
    return;
  }

  const profit = state.balance - state.activeRealTrade.balanceBefore;
  state.sessionPnl += profit;
  state.dailyPnl += profit;

  const isWin = profit >= 0;
  const grossPayout = isWin ? (state.activeRealTrade.stake + profit) : 0;

  if (isWin) {
    consecutiveLosses = 0;
  } else {
    consecutiveLosses++;
    if (consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
      state.lossCooldownUntil = Date.now() + CONFIG.LOSS_COOLDOWN_MS;
      addLog(`⏳ ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses. Cooling down for ${CONFIG.LOSS_COOLDOWN_MS/60000} minutes.`);
    }
  }

  // Insert with bot_name
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
    duration_seconds: CONFIG.DURATION_SECONDS,
    duration_ticks: null,
    bot_name: state.activeRealTrade.botId || 'unknown'   // <-- new field
  });

  addLog(`[Settlement] ${state.activeRealTrade.symbol} | ${state.activeRealTrade.contractType} | Result: ${isWin ? '🟢 WIN (+$' : '🔴 LOSS (-$'}${Math.abs(profit).toFixed(2)}) | Bot: ${state.activeRealTrade.botId || 'unknown'} | Session: $${state.sessionPnl.toFixed(2)} | Daily: $${state.dailyPnl.toFixed(2)}`);

  if (state.activeRealTrade.settlementTimeout) {
    clearTimeout(state.activeRealTrade.settlementTimeout);
  }

  state.tradeInProgress = false;
  state.activeRealTrade = null;
  state.pendingSettlement = false;
  state.cooldownTicksLeft = CONFIG.COOLDOWN_TICKS;

  const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  syncDailyPnlFromDB().then(() => { saveState(); broadcastSSE({ state: getFullState() }); });
}

let consecutiveLosses = 0;

// =====================================================================
//  TICK PROCESSING – MULTI‑BOT EVALUATION
// =====================================================================
function processLiveFeed(symbol, price) {
  // ---- 60-SECOND FAILSAFE WATCHDOG ----
  if (state.tradeInProgress && state.activeRealTrade && state.activeRealTrade.executionTime) {
    const elapsedSeconds = (Date.now() - state.activeRealTrade.executionTime) / 1000;
    if (elapsedSeconds > 60) {
      addLog(`⚠️ WARNING: Trade stuck in progress for ${elapsedSeconds.toFixed(1)}s. Forcefully resetting state.`);
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

  // ---- Feed engine ----
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

  // ---- Evaluate all active bots ----
  let bestProposal = null;
  let bestScore = -Infinity;
  let bestBotId = null;

  for (const [botId, entry] of bots) {
    if (!entry.active) continue;
    try {
      // Build marketData for this bot (could be enriched with bot‑specific fields)
      const marketData = {
        symbol,
        price: metric.price,
        volatility: metric.volatility,
        rsi: metric.rsi,
        bbUpper: metric.bbUpper,
        bbLower: metric.bbLower,
        support: metric.support,
        resistance: metric.resistance,
        isBreakout: metric.isBreakout,
        isBreakdown: metric.isBreakdown,
        // ... add more as needed
      };
      const proposal = entry.instance.evaluate(marketData, entry.config, entry.state);
      if (proposal) {
        // Use a score (e.g., volatility) to pick the best if multiple bots fire
        const score = proposal.score || metric.volatility || 0;
        if (score > bestScore) {
          bestScore = score;
          bestProposal = proposal;
          bestBotId = botId;
        }
      }
    } catch(err) {
      console.error(`❌ Bot ${botId} evaluation error:`, err.message);
    }
  }

  if (!bestProposal || !bestBotId) {
    broadcastSSE({ state: getFullState() });
    return;
  }

  // ---- Execute the winning bot's proposal ----
  const botEntry = bots.get(bestBotId);
  const proposal = bestProposal;

  // Build the Deriv API request from the proposal
  const { contract_type, symbol: sym, amount, basis, duration, duration_unit, barrier, growth_rate } = proposal;

  state.tradeInProgress = true;
  const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  addLog(`🔥 Bot ${botEntry.instance.name} | Signal: ${sym} | ${contract_type} | Stake: $${state.currentStake}`);

  state.activeRealTrade = {
    symbol: sym,
    stake: state.currentStake,
    balanceBefore: state.balance,
    contractType: contract_type,
    barrier: barrier || null,
    direction: null, // some bots may set direction; we keep generic
    entryPrice: null,
    executionTime: Date.now(),
    settlementTimeout: null,
    botId: bestBotId,
    // Save the original proposal for later reference
    proposal: proposal
  };

  state.lastTriggerTime = now;

  // Build the Deriv request payload (could be extended)
  const reqPayload = {
    proposal: 1,
    amount: state.currentStake,
    basis: basis || 'stake',
    contract_type: contract_type,
    currency: state.currency || 'USD',
    duration: duration || CONFIG.DURATION_SECONDS,
    duration_unit: duration_unit || 's',
    underlying_symbol: sym,
    req_id: ++reqId
  };
  // Add optional fields if present
  if (barrier) reqPayload.barrier = barrier;
  if (growth_rate) reqPayload.growth_rate = growth_rate;

  addLog(`📤 Requesting ${contract_type} proposal for ${sym}...`);
  send(reqPayload);

  broadcastSSE({ state: getFullState() });
}

// =====================================================================
//  WEBSOCKET CONNECTION (unchanged)
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
//  MESSAGE HANDLER (updated to accept bot‑specific proposals)
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
    if (state.pendingSettlement && state.activeRealTrade) {
      state.pendingSettlement = false;
      settleRealTrade();
    }
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
      state.activeRealTrade.contractId = msg.buy.contract_id;
      state.activeRealTrade.entryPrice = msg.buy.price;
      state.activeRealTrade.balanceBefore = state.balance;
      state.activeRealTrade.executionTime = Date.now();

      addLog(`💰 Trade Executed: Contract ID ${msg.buy.contract_id} at price ${msg.buy.price}`);

      const durationMs = CONFIG.DURATION_SECONDS * 1000;
      const bufferMs = 5000;
      const totalWaitMs = durationMs + bufferMs;

      addLog(`⏱️ Timer started. Waiting ${totalWaitMs / 1000}s for settlement...`);

      if (state.activeRealTrade.settlementTimeout) {
        clearTimeout(state.activeRealTrade.settlementTimeout);
      }
      state.activeRealTrade.settlementTimeout = setTimeout(() => {
        state.pendingSettlement = true;
        send({ balance: 1, req_id: ++reqId });
      }, totalWaitMs);
    }
    return;
  }
}

// =====================================================================
//  MANUAL TRADING (kept as before, but could be removed)
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

  let dur = parseInt(duration) || CONFIG.DURATION_SECONDS;
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
    botId: 'manual'
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
