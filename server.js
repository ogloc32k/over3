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
    redCircle: engine && engine.metrics ? engine.metrics.redCircle : '—'
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
  }

  extractDigit(price) {
    return parseInt(parseFloat(price).toFixed(MARKET.dp).slice(-1));
  }

  seedHistory(prices) {
    this.ticks = prices.map(p => this.extractDigit(p));
    if (this.ticks.length > BUFFER_CAPACITY) {
      this.ticks = this.ticks.slice(-BUFFER_CAPACITY);
    }
    return this.analyze();
  }

  feedLive(price) {
    const digit = this.extractDigit(price);
    this.ticks.push(digit);
    if (this.ticks.length > BUFFER_CAPACITY) this.ticks.shift();
    return this.analyze();
  }

  analyze() {
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

    // UPDATED BOTTLE-NECK 1: Expanded boundaries to accept 3, 4, 5, 6 floors & spatial differences up to 2
    const diff = greenCircle - redCircle;
    const circlesValid = (greenCircle > redCircle && redCircle >= 3 && diff <= 2);

    const currentDensity = this.getCurrentDensity();
    const densityValid = (currentDensity >= 60);
    const setupValid = circlesValid && densityValid;

    const last3 = this.ticks.slice(-3);
    const currentDigit = last3[last3.length - 1];
    const prevDigit = last3.length >= 2 ? last3[last3.length - 2] : null;

    // UPDATED BOTTLE-NECK 3: Sequential Momentum Trigger Logic
    let triggerFired = false;
    if (setupValid && prevDigit !== null && prevDigit <= 3) {
      if (currentDigit >= redCircle && currentDigit < greenCircle) {
        triggerFired = true;
      }
    }

    this.metrics = { setupValid, triggerFired, greenCircle, redCircle, literalDigit: currentDigit, prevDigit };
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
  active: false, // Tracks automated trading execution loop status only
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
  
  addLog(`[Settlement] Result: ${profit >= 0 ? '🟢 WIN (+$' : '🔴 LOSS (-$'}${Math.abs(profit).toFixed(2)}) | Portfolio Net: $${state.dailyPnl.toFixed(2)}`);
  
  state.tradeInProgress = false; state.activeRealTrade = null; state.settleTicksRemaining = 0;
  state.cooldownTicksLeft = COOLDOWN_TICKS;

  const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  checkDailyLimits(); saveState(); broadcastSSE({ state: sanitizeState() });
}

// High-speed sequential evaluation loop
function processTick(price) {
  if (state.settleTicksRemaining > 0) {
    state.settleTicksRemaining--;
    if (state.settleTicksRemaining === 0) settleRealTrade();
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  const metrics = engine.feedLive(price);
  if (!metrics) return;

  // Step-by-Step Granular Analytics Logging Matrix
  let marketStatusMsg = `📊 Tick Digit: [${metrics.literalDigit}] | Density: ${engine.getCurrentDensity()}% (R:${metrics.redCircle} G:${metrics.greenCircle})`;
  
  if (state.locked) {
    // Structural block bypass
  } else if (state.tradeInProgress) {
    marketStatusMsg += ` | ⏳ Awaiting active 3-tick contract settlement...`;
  } else if (state.cooldownTicksLeft > 0) {
    state.cooldownTicksLeft--;
    marketStatusMsg += ` | 🕒 Cooldown Active (${state.cooldownTicksLeft} ticks remaining)`;
  } else if (!state.active) {
    marketStatusMsg += ` | 💤 Automated Core Disarmed (Manual mode operational)`;
  } else if (!metrics.setupValid) {
    marketStatusMsg += ` | ❌ Setup Rejected (Required: Red>=3, Diff<=2, Density>=60%)`;
  } else if (metrics.setupValid && !metrics.triggerFired) {
    marketStatusMsg += ` | ⚡ Setup Valid! Scanning for sequence: (Prev: ${metrics.prevDigit} <= 3) -> (Current: hit inside [${metrics.redCircle} to ${metrics.greenCircle - 1}])`;
  } else if (metrics.setupValid && metrics.triggerFired) {
    marketStatusMsg += ` | 🔥 SEQUENCE VERIFIED! Firing automated execution asset...`;
    
    state.tradeInProgress = true;
    const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
    state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

    addLog(`🎯 Bot Entry Fired | Stake: $${state.currentStake} | Path: ${metrics.prevDigit} -> ${metrics.literalDigit}`);
    state.activeRealTrade = { stake: state.currentStake, balanceBefore: state.balance };
    
    send({
      proposal: 1, amount: state.currentStake, basis: 'stake', currency: state.currency,
      duration: 1, duration_unit: 't', underlying_symbol: MARKET.sym,
      contract_type: 'DIGITOVER', barrier: FIXED_BARRIER, req_id: ++reqId
    });
  }

  // Push market telemetry down the data stream
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

// Automated background pipe management
async function connectDeriv() {
  disconnectDeriv(); 
  const appId = (process.env.DERIV_APP_ID || '').trim();
  const token = (process.env.DERIV_PAT || '').trim();

  if (!appId || !token) {
    addLog('Configuration Error: Runtime system environment variables are completely missing.');
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
    
    if (!targetAccount) throw new Error(`Profile target unmatched: ${state.tradingMode}`);

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
      addLog(`🌐 Flawless Pipe Linked. Wallet Synchronized: $${state.balance.toFixed(2)} ${state.currency}`);
      send({ balance: 1, subscribe: 1, req_id: ++reqId });
      send({ ticks_history: MARKET.sym, count: BUFFER_CAPACITY, end: 'latest', req_id: ++reqId });

      keepAliveLoop = setInterval(() => {
        send({ ping: 1 });
        watchdogTimer = setTimeout(() => {
          addLog('🚨 Pipeline latency anomaly detected. Re-spawning socket...');
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
      setTimeout(connectDeriv, 1500); // Instant auto-recovery bridge
    });

    derivWs.on('error', () => { if (derivWs) derivWs.terminate(); });

  } catch(e) {
    addLog(`Network Link Exception: ${e.message}. Attempting recovery step...`);
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
      addLog('✅ Rolling buffer successfully seeded with 100 past ticks. Subscribing to live ticks.');
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
    connectDeriv(); // Instantly reconnects pipeline to the alternate account profile
    return res.json({ success: true });
  }
  if (action === 'start') {
    state.active = true; state.locked = false;
    addLog(`🚀 Automated Trading Core ARMED. Automation triggers are now processing.`);
  } else if (action === 'stop') {
    state.active = false; state.tradeInProgress = false; 
    addLog('🚨 Automated Trading Core DISARMED safely. Pipeline stream remains active for manual executions.');
  }
  saveState(); broadcastSSE({ state: sanitizeState() }); res.json({ success: true });
});

// Manual Intervention Controller Matrix (Allowed while state.active is false!)
app.post('/api/manual-trade', (req, res) => {
  const { actionType } = req.body; 
  if (state.locked || state.tradeInProgress || !state.warmupComplete) {
    return res.status(400).json({ error: 'Safety Violation: Core pipeline is locked or offline.' });
  }

  state.tradeInProgress = true;
  const contractType = actionType === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER';
  
  const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  addLog(`⚡ Manual Intervention Executed: ${contractType} | Stake: $${state.currentStake}`);
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
// Spin up the market connection loop immediately upon system boot sequence
connectDeriv();
server.listen(PORT, () => console.log(`Hybrid Execution Deck active on port ${PORT}`));
