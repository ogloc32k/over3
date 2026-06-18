const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const STATE_FILE = '/var/data/deriv_state.json';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const sseClients = new Set();
let logId = 1;

function addLog(msg) {
  const entry = { id: logId++, time: new Date().toISOString(), message: msg };
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs.pop();
  broadcastSSE({ logs: [entry], state: sanitizeState() });
}

function broadcastSSE(payload) {
  sseClients.forEach(c => c.write(`data: ${JSON.stringify(payload)}\n\n`));
}

function sanitizeState() {
  const { logs, ...rest } = state;
  return {
    ...rest,
    currentDensity: engine ? engine.getCurrentDensity() : 0,
    last3Ticks: engine ? engine.getLast3() : [],
    digitPercentages: engine ? engine.getPercentages() : Array(10).fill(0),
    greenCircle: engine && engine.metrics ? engine.metrics.greenCircle : '—',
    redCircle: engine && engine.metrics ? engine.metrics.redCircle : '—',
    currentStreak: engine ? engine.lowStreakCount : 0
  };
}

// ---------- Strategy Parameters & Constants ----------
const MARKET = { sym: 'R_75', name: 'Volatility 75 Index', dp: 4 }; 
const FIXED_BARRIER = 3;         
const BUFFER_CAPACITY = 100; 

const RISK_PERCENT = 1;   
const TP_PERCENT = 2;     
const SL_PERCENT = 4;     
const MIN_STAKE = 0.35;          

const COOLDOWN_TICKS = 10;       
const SETTLE_TICKS = 3;   

class OverThreeRollingEngine {
  constructor() {
    this.ticks = [];
    this.metrics = null;
    this.lowStreakCount = 0; 
  }

  extractDigit(price) {
    return parseInt(parseFloat(price).toFixed(MARKET.dp).slice(-1));
  }

  seedHistory(prices) {
    this.ticks = prices.map(p => this.extractDigit(p));
    if (this.ticks.length > BUFFER_CAPACITY) {
      this.ticks = this.ticks.slice(-BUFFER_CAPACITY);
    }
    this.lowStreakCount = 0;
    return this.analyze(this.ticks[this.ticks.length - 1]);
  }

  feedLive(price) {
    const digit = this.extractDigit(price);
    this.ticks.push(digit);
    if (this.ticks.length > BUFFER_CAPACITY) this.ticks.shift();
    return this.analyze(digit);
  }

  analyze(currentDigit) {
    if (this.ticks.length < BUFFER_CAPACITY) return null;

    const freqCounts = Array(10).fill(0);
    this.ticks.forEach(d => freqCounts[d]++);

    let greenCircle = 0;
    let maxCount = -1;
    for (let i = 0; i <= 9; i++) {
      if (freqCounts[i] >= maxCount) {
        maxCount = freqCounts[i];
        greenCircle = i;
      }
    }

    let redCircle = 0;
    let minCount = Infinity;
    for (let i = 0; i <= 9; i++) {
      if (freqCounts[i] <= minCount) {
        minCount = freqCounts[i];
        redCircle = i;
      }
    }

    const circlesValid = (greenCircle >= 3 && redCircle >= 3);
    let triggerFired = false;
    let priorStreak = this.lowStreakCount;

    if (currentDigit <= 3) {
      this.lowStreakCount++;
    } else {
      if (priorStreak >= 5 && currentDigit !== 4 && circlesValid) {
        triggerFired = true;
      }
      this.lowStreakCount = 0; 
    }

    this.metrics = { circlesValid, triggerFired, greenCircle, redCircle, literalDigit: currentDigit, priorStreak };
    return this.metrics;
  }

  getPercentages() {
    const freq = Array(10).fill(0);
    this.ticks.forEach(d => freq[d]++);
    return freq.map(count => Math.round((count / BUFFER_CAPACITY) * 1000) / 10);
  }

  getCurrentDensity() {
    if (this.ticks.length === 0) return 0;
    return Math.round((this.ticks.filter(d => d > 3).length / this.ticks.length) * 100);
  }

  getLast3() {
    return this.ticks.slice(-3);
  }
}

const engine = new OverThreeRollingEngine();

const state = {
  active: false, 
  tradingMode: 'demo', 
  balance: null,
  currency: 'USD',
  dailyStartBalance: null,
  dailyPnl: 0,
  locked: false,
  lockReason: '',
  warmupComplete: false,
  liveSubscribed: false,
  tradeInProgress: false,
  activeRealTrade: null,
  settleTicksRemaining: 0,
  currentStake: MIN_STAKE,
  cooldownTicksLeft: 0,
  logs: []
};

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      date: getEATDateString(),
      tradingMode: state.tradingMode,
      dailyStartBalance: state.dailyStartBalance,
      dailyPnl: state.dailyPnl,
      locked: state.locked,
      lockReason: state.lockReason,
      sessionActive: state.active
    }));
  } catch(e) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved.date === getEATDateString()) {
        state.tradingMode = saved.tradingMode || 'demo';
        state.dailyStartBalance = saved.dailyStartBalance;
        state.dailyPnl = saved.dailyPnl || 0;
        state.locked = saved.locked || false;
        state.lockReason = saved.lockReason || '';
      }
    }
  } catch(e) {}
}

function checkDailyLimits() {
  if (!state.dailyStartBalance) return false;
  const tpLimit = state.dailyStartBalance * (TP_PERCENT / 100);
  const slLimit = state.dailyStartBalance * (SL_PERCENT / 100);

  if (state.dailyPnl >= tpLimit) {
    state.locked = true; state.active = false;
    state.lockReason = `🎯 Target hit! Secured +$${state.dailyPnl.toFixed(2)} (2% Cap).`;
    addLog(state.lockReason); return true;
  }
  if (state.dailyPnl <= -slLimit) {
    state.locked = true; state.active = false;
    state.lockReason = `🛑 Risk Limit hit. Portfolio preserved at -$${Math.abs(state.dailyPnl).toFixed(2)} (4% Max Loss).`;
    addLog(state.lockReason); return true;
  }
  return false;
}

function settleRealTrade() {
  if (!state.activeRealTrade || state.balance == null) return;
  const profit = state.balance - state.activeRealTrade.balanceBefore;
  state.dailyPnl += profit;
  
  addLog(`[Settlement] Result: ${profit >= 0 ? '🟢 WIN (+$' : '🔴 LOSS (-$'}${Math.abs(profit).toFixed(2)}) | Session Net: $${state.dailyPnl.toFixed(2)}`);
  
  state.tradeInProgress = false; state.activeRealTrade = null; state.settleTicksRemaining = 0;
  state.cooldownTicksLeft = COOLDOWN_TICKS;

  const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  checkDailyLimits(); saveState(); broadcastSSE({ state: sanitizeState() });
}

function processTick(price) {
  if (state.settleTicksRemaining > 0) {
    state.settleTicksRemaining--;
    if (state.settleTicksRemaining === 0) settleRealTrade();
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  const metrics = engine.feedLive(price);
  if (!metrics) return;

  const activeStreakDisplay = metrics.literalDigit <= 3 ? engine.lowStreakCount : metrics.priorStreak;
  const currentDensity = engine.getCurrentDensity();
  let marketStatusMsg = `📊 Digit: [${metrics.literalDigit}] | Density: ${currentDensity}% | Low Streak: ${activeStreakDisplay} | Circles: (R:${metrics.redCircle} G:${metrics.greenCircle})`;
  
  if (state.locked) {
    // Lockout
  } else if (state.tradeInProgress) {
    marketStatusMsg += ` | ⏳ Awaiting settlement...`;
  } else if (state.cooldownTicksLeft > 0) {
    state.cooldownTicksLeft--;
    marketStatusMsg += ` | 🕒 Cooldown Active (${state.cooldownTicksLeft} ticks)`;
  } else if (!state.active) {
    marketStatusMsg += ` | 💤 Automation Core Disarmed (Manual mode fully active)`;
  } else if (!metrics.circlesValid) {
    marketStatusMsg += ` | ❌ Setup Blocked: Circles out of bounds (Both must be >= 3)`;
  } else if (metrics.literalDigit <= 3) {
    marketStatusMsg += ` | 🔋 Accumulating Streak... (${engine.lowStreakCount}/5+)`;
  } else if (metrics.literalDigit === 4) {
    marketStatusMsg += ` | ⚠️ Sequence Reset: Digit 4 is explicitly excluded from strategy triggers.`;
  } else if (metrics.priorStreak < 5) {
    marketStatusMsg += ` | ❌ Reset: Breakout digit arrived too early (Streak only hit ${metrics.priorStreak})`;
  } else if (metrics.triggerFired) {
    marketStatusMsg += ` | 🔥 CONDITIONS VALIDATED! Firing automated execution asset...`;
    
    state.tradeInProgress = true;
    const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
    state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

    addLog(`🎯 Bot Entry Fired | Stake: $${state.currentStake} | Pattern: ${metrics.priorStreak} Low Ticks -> Broken by ${metrics.literalDigit}`);
    state.activeRealTrade = { stake: state.currentStake, balanceBefore: state.balance };
    
    send({
      proposal: 1, amount: state.currentStake, basis: 'stake', currency: state.currency,
      duration: 1, duration_unit: 't', underlying_symbol: MARKET.sym,
      contract_type: 'DIGITOVER', barrier: FIXED_BARRIER, req_id: ++reqId
    });
  }

  broadcastSSE({ logs: [{ id: logId++, time: new Date().toISOString(), message: marketStatusMsg }], state: sanitizeState() });
}

function getEATDateString() {
  return new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi" });
}

let derivWs = null;
let reqId = 0;
let keepAliveLoop = null;
let watchdogTimer = null;

function send(msg) {
  if (derivWs && derivWs.readyState === WebSocket.OPEN) {
    derivWs.send(JSON.stringify(msg));
  }
}

function disconnectDeriv() {
  clearInterval(keepAliveLoop); 
  clearTimeout(watchdogTimer);
  if (derivWs) { 
    derivWs.removeAllListeners(); 
    try { derivWs.terminate(); } catch(e) {} 
    derivWs = null; 
  }
  state.liveSubscribed = false;
  state.warmupComplete = false;
}

async function connectDeriv() {
  disconnectDeriv(); 
  const appId = (process.env.DERIV_APP_ID || '').trim();
  const token = (process.env.DERIV_PAT || '').trim();

  if (!appId || !token) {
    addLog('Configuration Error: App ID or Token credentials missing from runtime variables.');
    return;
  }

  try {
    const accRes = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' }
    });
    if (!accRes.ok) throw new Error('Authentication Rejected.');

    const data = await accRes.json();
    const accList = Array.isArray(data.data) ? data.data : [data.data];
    const targetAccount = accList.find(a => a.account_type === state.tradingMode);
    
    if (!targetAccount) throw new Error(`Target profile unmatched: ${state.tradingMode}`);

    state.balance = parseFloat(targetAccount.balance);
    state.currency = targetAccount.currency || 'USD';
    if (state.dailyStartBalance === null) state.dailyStartBalance = state.balance;

    const otpRes = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${targetAccount.account_id}/otp`, {
      method: 'POST', 
      headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!otpRes.ok) throw new Error('Security allocation failure.');

    const otpData = await otpRes.json();
    derivWs = new WebSocket(otpData.data.url);

    derivWs.on('open', () => {
      addLog(`🌐 Pipeline Online. Sync Balance: $${state.balance.toFixed(2)} ${state.currency}`);
      send({ balance: 1, subscribe: 1, req_id: ++reqId });
      send({ ticks_history: MARKET.sym, count: BUFFER_CAPACITY, end: 'latest', req_id: ++reqId });

      keepAliveLoop = setInterval(() => {
        send({ ping: 1 });
        watchdogTimer = setTimeout(() => {
          addLog('🚨 Connection pipeline timeout. Forcing reconnect sequence...');
          if (derivWs) derivWs.terminate();
        }, 3000);
      }, 15000);
    });

    derivWs.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.msg_type === 'ping') { clearTimeout(watchdogTimer); return; }
        handleMessage(msg);
      } catch(e) {}
    });

    derivWs.on('close', () => {
      disconnectDeriv();
      setTimeout(connectDeriv, 1500); 
    });

    derivWs.on('error', () => { if (derivWs) derivWs.terminate(); });

  } catch(e) {
    addLog(`Network Link Exception: ${e.message}. Re-probing connection...`);
    setTimeout(connectDeriv, 4000);
  }
}

function handleMessage(msg) {
  if (msg.error) {
    addLog(`API Response Error: ${msg.error.message}`);
    state.tradeInProgress = false; state.activeRealTrade = null; state.settleTicksRemaining = 0;
    return;
  }
  if (msg.msg_type === 'balance') {
    state.balance = parseFloat(msg.balance.balance);
    broadcastSSE({ state: sanitizeState() });
  } else if (msg.msg_type === 'history') {
    engine.seedHistory(msg.history.prices);
    state.warmupComplete = true; 
    if (!state.liveSubscribed) {
      state.liveSubscribed = true;
      addLog('✅ Rolling buffer successfully seeded with 100 past ticks. Stream engaged.');
      send({ ticks: MARKET.sym, req_id: ++reqId });
    }
    broadcastSSE({ state: sanitizeState() });
  } else if (msg.msg_type === 'tick') {
    if (msg.tick.symbol !== MARKET.sym) return;
    processTick(parseFloat(msg.tick.quote));
  } else if (msg.msg_type === 'proposal') {
    send({ buy: msg.proposal.id, price: msg.proposal.ask_price, req_id: ++reqId });
  } else if (msg.msg_type === 'buy') {
    if (state.activeRealTrade) state.settleTicksRemaining = SETTLE_TICKS;
  }
}

app.get('/api/logs', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  sseClients.add(res); 
  res.write(`data: ${JSON.stringify({ state: sanitizeState(), logs: state.logs })}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/control', (req, res) => {
  const { action, mode } = req.body;
  if (action === 'set_mode') {
    if (state.active) return res.status(400).json({ error: 'Engine active.' });
    state.tradingMode = mode; state.dailyStartBalance = null; state.dailyPnl = 0;
    saveState(); 
    connectDeriv(); 
    return res.json({ success: true });
  }
  if (action === 'start') {
    state.active = true; state.locked = false;
    addLog(`🚀 Automated Core ARMED. Sequence scanning engaged.`);
  } else if (action === 'stop') {
    state.active = false; state.tradeInProgress = false; 
    addLog('🚨 Automated Core DISARMED safely. Manual operations remain operational.');
  }
  saveState(); broadcastSSE({ state: sanitizeState() }); res.json({ success: true });
});

app.post('/api/manual-trade', (req, res) => {
  const { actionType } = req.body; 
  if (state.locked || state.tradeInProgress || !state.warmupComplete) {
    return res.status(400).json({ error: 'Execution Rejected: Safety lock active or pipeline offline.' });
  }

  state.tradeInProgress = true;
  const contractType = actionType === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER';
  
  const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  addLog(`⚡ Manual Trade Dispatched: ${contractType} | Automated Risk Stake Allocation: $${state.currentStake}`);
  state.activeRealTrade = { stake: state.currentStake, balanceBefore: state.balance };

  send({
    proposal: 1, amount: state.currentStake, basis: 'stake', currency: state.currency,
    duration: 1, duration_unit: 't', underlying_symbol: MARKET.sym,
    contract_type: contractType, barrier: FIXED_BARRIER, req_id: ++reqId
  });

  broadcastSSE({ state: sanitizeState() });
  res.json({ success: true });
});

loadState();
connectDeriv(); 
server.listen(PORT, () => console.log(`Hybrid Execution Deck active on port ${PORT}`));
