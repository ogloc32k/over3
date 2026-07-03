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
//  DEFAULT CONFIG (Rise/Fall)
// =====================================================================
const DEFAULT_CONFIG = {
    MIN_SEQUENCE_LENGTH: 3,        // minimum consecutive ticks before trading
    DURATION_TICKS: 5,             // contract duration in ticks
    MIN_TRIGGER_INTERVAL: 20000,   // 20 seconds
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
//  SCHEDULED RESTART (03:00 EAT)
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
app.get('/api/config', (req, res) => {
    res.json(CONFIG);
});

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
  broadcastSSE({ logs: [entry], state: sanitizeState() });
}
function broadcastSSE(payload) {
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
  client.write(`data: ${JSON.stringify({ state: sanitizeState(), logs: state.logs.slice(0, 50) })}\n\n`);
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
  'R_10':  { id: 'R_10',  name: 'Volatility 10 Index',  dp: 0 }, // dp not used anymore
  'R_25':  { id: 'R_25',  name: 'Volatility 25 Index',  dp: 0 },
  'R_50':  { id: 'R_50',  name: 'Volatility 50 Index',  dp: 0 },
  'R_75':  { id: 'R_75',  name: 'Volatility 75 Index',  dp: 0 },
  'R_100': { id: 'R_100', name: 'Volatility 100 Index', dp: 0 }
};
const BUFFER_CAPACITY = 1000;

// ---------- Pipeline Class (Rise/Fall) ----------
class MultiMarketPipeline {
  constructor() {
    this.buffers = {};
    this.lastPrices = {};
    this.sequences = {};
    for (const symbol in MARKETS) {
      this.buffers[symbol] = [];
      this.lastPrices[symbol] = null;
      this.sequences[symbol] = { count: 0, direction: 0 }; // direction: 1 for rise, -1 for fall, 0 for flat
    }
  }

  feed(symbol, price) {
    const buf = this.buffers[symbol];
    buf.push(price);
    if (buf.length > BUFFER_CAPACITY) buf.shift();

    const last = this.lastPrices[symbol];
    if (last !== null) {
      const diff = price - last;
      if (diff > 0) {
        // rising
        if (this.sequences[symbol].direction === 1) {
          this.sequences[symbol].count++;
        } else {
          this.sequences[symbol].count = 1;
          this.sequences[symbol].direction = 1;
        }
      } else if (diff < 0) {
        // falling
        if (this.sequences[symbol].direction === -1) {
          this.sequences[symbol].count++;
        } else {
          this.sequences[symbol].count = 1;
          this.sequences[symbol].direction = -1;
        }
      } else {
        // flat – reset count
        this.sequences[symbol].count = 0;
        this.sequences[symbol].direction = 0;
      }
    } else {
      // first tick – no sequence yet
      this.sequences[symbol].count = 0;
      this.sequences[symbol].direction = 0;
    }

    this.lastPrices[symbol] = price;

    return {
      symbol,
      price,
      sequence: this.sequences[symbol],
      // Also provide last few ticks for frontend display
      lastPrices: buf.slice(-5)
    };
  }
}

const engine = new MultiMarketPipeline();

// ============ STATE ============
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
  settleTicksRemaining: 0,
  currentStake: 0.35,
  cooldownTicksLeft: 0,
  marketMetrics: {},
  logs: [],
  lastTriggerTime: 0,
  lossCooldownUntil: 0,
  pendingSettlement: false
};

function sanitizeState() {
  const { logs, ...rest } = state;
  return rest;
}

// ============ STRATEGY CHECK ============
function checkStrategy(symbol, metric) {
  if (!metric) return null;
  const seq = metric.sequence;
  const count = seq.count;
  const direction = seq.direction;
  if (Math.abs(count) < CONFIG.MIN_SEQUENCE_LENGTH) return null;

  // Trade opposite direction
  if (direction === -1) {
    // falling streak -> buy CALL (expect rise)
    return { direction: 'CALL', score: count }; // negative count, but we want absolute value later
  } else if (direction === 1) {
    // rising streak -> buy PUT (expect fall)
    return { direction: 'PUT', score: count };
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
    if (state.balance !== null) {
      state.dailyStartBalance = state.balance - state.dailyPnl;
    }
    checkDailyLimits();
    broadcastSSE({ state: sanitizeState() });
    return total;
  } catch (err) {
    console.error('❌ Failed to sync daily P&L:', err.message);
    return 0;
  }
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
        state.locked = false;
        state.lockReason = '';
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

  if (isWin) {
    consecutiveLosses = 0;
  } else {
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
    exitTick: null
  });

  addLog(`[Settlement] ${state.activeRealTrade.symbol} | ${state.activeRealTrade.contractType} | Result: ${isWin ? '🟢 WIN (+$' : '🔴 LOSS (-$'}${Math.abs(profit).toFixed(2)}) | Session: $${state.sessionPnl.toFixed(2)} | Daily: $${state.dailyPnl.toFixed(2)}`);

  state.tradeInProgress = false;
  state.activeRealTrade = null;
  state.settleTicksRemaining = 0;
  state.cooldownTicksLeft = CONFIG.COOLDOWN_TICKS;
  state.pendingSettlement = false;

  const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  syncDailyPnlFromDB().then(() => {
    saveState();
    broadcastSSE({ state: sanitizeState() });
  });
}

let consecutiveLosses = 0;

// =====================================================================
// ENTRY LOGIC
// =====================================================================
function processLiveFeed(symbol, price) {
  if (state.pendingSettlement) {
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  if (state.settleTicksRemaining > 0) {
    state.settleTicksRemaining--;
    if (state.settleTicksRemaining === 0) {
      state.pendingSettlement = true;
      addLog(`⏳ ${CONFIG.SETTLE_TICKS} ticks elapsed. Waiting for balance update to settle ${state.activeRealTrade?.symbol}...`);
      setTimeout(() => {
        if (state.pendingSettlement) {
          addLog(`⚠️ Balance update timeout. Forcing settlement now.`);
          state.pendingSettlement = false;
          settleRealTrade();
        }
      }, CONFIG.SETTLEMENT_TIMEOUT_MS);
    }
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  const metric = engine.feed(symbol, price);
  if (!metric) return;

  state.marketMetrics[symbol] = metric;
  if (state.cooldownTicksLeft > 0) state.cooldownTicksLeft--;

  if (!state.active || state.locked || state.tradeInProgress || state.cooldownTicksLeft > 0) {
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  const now = Date.now();
  if (now < state.lossCooldownUntil) {
    broadcastSSE({ state: sanitizeState() });
    return;
  }
  if (now - state.lastTriggerTime < CONFIG.MIN_TRIGGER_INTERVAL) {
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  // Find best market (highest absolute count)
  let bestCandidate = null;
  let bestScore = -Infinity;

  for (const sym in MARKETS) {
    const m = state.marketMetrics[sym];
    if (!m) continue;
    const signal = checkStrategy(sym, m);
    if (signal) {
      const score = Math.abs(signal.score);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = { symbol: sym, ...signal };
      }
    }
  }

  if (bestCandidate) {
    const { symbol, direction } = bestCandidate;

    state.pendingSettlement = false;
    state.tradeInProgress = true;
    const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
    state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

    const contractType = direction; // 'CALL' or 'PUT'
    const metric = state.marketMetrics[symbol];
    const seq = metric.sequence;
    const dirLabel = seq.direction === 1 ? 'RISE' : 'FALL';
    addLog(`🔥 Signal: ${symbol} | ${direction} | Streak: ${Math.abs(seq.count)}${dirLabel}`);

    state.activeRealTrade = {
      symbol,
      stake: state.currentStake,
      balanceBefore: state.balance,
      contractType,
      barrier: null,
      direction: direction
    };

    state.lastTriggerTime = now;

    addLog(`📤 Requesting ${direction} proposal for ${symbol} (${CONFIG.DURATION_TICKS} ticks)...`);
    send({
      proposal: 1,
      amount: state.currentStake,
      basis: 'stake',
      contract_type: contractType,
      currency: state.currency || 'USD',
      duration: CONFIG.DURATION_TICKS,
      duration_unit: 't',
      underlying_symbol: symbol,
      req_id: ++reqId
    });
  }

  broadcastSSE({ state: sanitizeState() });
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
    broadcastSSE({ state: sanitizeState() });

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
      send({
        buy: msg.proposal.id,
        price: msg.proposal.ask_price,
        req_id: ++reqId
      });
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
    broadcastSSE({ state: sanitizeState() });
  }
  else if (msg.msg_type === 'history') {
    const symbol = msg.echo_req.ticks_history;
    // Seed pipeline with historical prices
    const prices = msg.history.prices.map(p => parseFloat(p));
    prices.forEach(p => engine.feed(symbol, p));
    addLog(`✅ History synchronized for ${symbol}`);
    send({ ticks: symbol, req_id: ++reqId });
  }
  else if (msg.msg_type === 'tick') {
    processLiveFeed(msg.tick.symbol, parseFloat(msg.tick.quote));
  }
  else if (msg.msg_type === 'buy') {
    if (state.activeRealTrade) {
      state.activeRealTrade.contractId = msg.buy.contract_id;
      state.settleTicksRemaining = CONFIG.SETTLE_TICKS;
      addLog(`💰 Trade Executed: Contract ID ${msg.buy.contract_id}`);
    }
  }
}

// ------------------ MANUAL TRADING ------------------ //
app.post('/api/manual-trade', (req, res) => {
  const { symbol, contractType } = req.body; // contractType: 'CALL' or 'PUT'
  if (state.locked || state.tradeInProgress) {
    return res.status(400).json({ 
      error: state.locked ? state.lockReason : 'Trade in progress.' 
    });
  }
  if (!MARKETS[symbol]) {
    return res.status(400).json({ error: 'Invalid symbol.' });
  }
  if (!['CALL', 'PUT'].includes(contractType)) {
    return res.status(400).json({ error: 'Invalid contract type. Use "CALL" or "PUT".' });
  }

  const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;
  state.pendingSettlement = false;
  state.tradeInProgress = true;

  state.activeRealTrade = {
    symbol,
    stake: state.currentStake,
    balanceBefore: state.balance,
    contractType,
    barrier: null,
    direction: contractType
  };

  send({
    proposal: 1,
    amount: state.currentStake,
    basis: 'stake',
    contract_type: contractType,
    currency: state.currency || 'USD',
    duration: CONFIG.DURATION_TICKS,
    duration_unit: 't',
    underlying_symbol: symbol,
    req_id: ++reqId
  });

  addLog(`📤 Manual ${contractType} request for ${symbol} (${CONFIG.DURATION_TICKS} ticks)...`);
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
