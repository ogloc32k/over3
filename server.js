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

// ---------- SSE Setup ----------
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
  return rest;
}

// ---------- Over-3 Momentum Configuration ----------
const MARKET = { sym: 'R_75', name: 'Volatility 75 Index', dp: 4 };
const FIXED_BARRIER = 3;         
const WARMUP_TICKS = 100;        

// Risk Parameters
const RISK_PERCENT = 1.0;        
const MIN_STAKE = 0.35;          
const TP_PERCENT = 5;            
const SL_PERCENT = 10;           

const COOLDOWN_TICKS = 10;       
const SETTLE_TICKS = 12;

let globalTickCounter = 0;

// ---------- Over-3 Trend Core Analyzer ----------
class OverThreeTrendEngine {
  constructor() {
    this.ticks = [];
  }

  feed(price) {
    const digit = parseInt(parseFloat(price).toFixed(MARKET.dp).slice(-1));
    
    let previousCount = null;
    if (this.ticks.length === WARMUP_TICKS) {
      previousCount = this.ticks.filter(d => d > 3).length;
    }

    this.ticks.push(digit);
    if (this.ticks.length > WARMUP_TICKS) this.ticks.shift();

    if (this.ticks.length < WARMUP_TICKS) return null;

    const currentCount = this.ticks.filter(d => d > 3).length; 
    
    const isExact60 = (currentCount === 60);
    const wasRising = (previousCount !== null && currentCount > previousCount);
    const isTriggerDigit = (digit === 6);

    // UPGRADE: Strict Digit Exhaustion Vector (Checks last 3 elements for structural saturation >= 7)
    const last3 = this.ticks.slice(-3);
    const isExhausted = (last3.length === 3 && last3.every(d => d >= 7));

    return {
      currentPercent: currentCount,
      wasRising: wasRising,
      isExact60: isExact60,
      isTriggerDigit: isTriggerDigit,
      isExhausted: isExhausted,
      literalDigit: digit
    };
  }
}

const engine = new OverThreeTrendEngine();

// ---------- State Engine ----------
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
  warmupTicksFed: 0,
  liveSubscribed: false,
  accountType: 'Awaiting Authorization...',

  tradeInProgress: false,
  activeRealTrade: null,
  settleTicksRemaining: 0,
  currentStake: MIN_STAKE,
  cooldownTicksLeft: 0,

  logs: [],
  sessionAlreadyUsedToday: false
};

// ---------- Persistence Matrix ----------
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
      const todayEAT = getEATDateString();
      
      if (saved.tradingMode) state.tradingMode = saved.tradingMode;
      
      if (saved.date === todayEAT) {
        state.dailyStartBalance = saved.dailyStartBalance;
        state.dailyPnl = saved.dailyPnl || 0;
        if (saved.locked) { 
          state.locked = true; 
          state.lockReason = saved.lockReason || ''; 
        }
      }
    }
  } catch(e) {}
}

function getTP() { return state.dailyStartBalance ? (state.dailyStartBalance * TP_PERCENT / 100) : 0; }
function getSL() { return state.dailyStartBalance ? (state.dailyStartBalance * SL_PERCENT / 100) : 0; }

function checkDailyLimits() {
  if (!state.dailyStartBalance) return false;
  if (state.dailyPnl >= getTP()) {
    state.locked = true;
    state.active = false;
    state.lockReason = `🎯 Daily Take-Profit target reached! secured +$${getTP().toFixed(2)}. System shutting down safely.`;
    addLog(state.lockReason);
    if (derivWs) derivWs.close();
    return true;
  }
  if (state.dailyPnl <= -getSL()) {
    state.locked = true;
    state.active = false;
    state.lockReason = `🛑 Daily Stop-Loss limit hit! Portfolio preserved at -$${getSL().toFixed(2)}. Core disconnected.`;
    addLog(state.lockReason);
    if (derivWs) derivWs.close();
    return true;
  }
  return false;
}

function settleRealTrade() {
  if (!state.activeRealTrade || state.balance == null) return;
  const profit = state.balance - state.activeRealTrade.balanceBefore;
  state.dailyPnl += profit;
  const result = profit > 0 ? 'WIN' : (profit < 0 ? 'LOSS' : 'DRAW');
  
  addLog(`[${state.tradingMode.toUpperCase()}] ${result}: ${profit > 0 ? '+' : ''}${profit.toFixed(2)} | Session cumulative P&L: ${state.dailyPnl.toFixed(2)}`);

  state.tradeInProgress = false;
  state.activeRealTrade = null;
  state.settleTicksRemaining = 0;
  state.cooldownTicksLeft = COOLDOWN_TICKS;

  const calculatedRisk = state.balance * (RISK_PERCENT / 100);
  const rawStake = Math.min(Math.max(MIN_STAKE, calculatedRisk), state.balance);
  state.currentStake = Math.round(rawStake * 100) / 100;

  checkDailyLimits();
  saveState();
  broadcastSSE({ state: sanitizeState() });
}

function processTick(price) {
  const metrics = engine.feed(price);
  globalTickCounter++;

  if (!metrics) return;

  if (globalTickCounter % 10 === 0) {
    addLog(`📊 Metrics Stream: Over-3 Density: [${metrics.currentPercent}%] | Momentum Vector: [${metrics.wasRising ? 'RISING ↗️' : 'STABLE/FALLING ↘️'}] | Current Spot Digit: [${metrics.literalDigit}]`);
  }

  if (!state.active || state.locked || !state.warmupComplete) return;

  if (state.settleTicksRemaining > 0) {
    state.settleTicksRemaining--;
    if (state.settleTicksRemaining === 0) settleRealTrade();
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  if (state.cooldownTicksLeft > 0) { state.cooldownTicksLeft--; return; }
  if (state.tradeInProgress) return;

  if (metrics.isExact60 && metrics.wasRising && metrics.isTriggerDigit) {
    
    // UPGRADE IMPLEMENTATION: Digit Exhaustion Interceptor (>= 7 check)
    if (metrics.isExhausted) {
      addLog(`⚠️ SETUP BLOCKED: Exhaustion rule triggered. The last 3 ticks were all ≥ 7. Skipping trade to safeguard capital against mean reversion.`);
      return;
    }

    state.tradeInProgress = true;
    
    let calculatedRisk = state.balance * (RISK_PERCENT / 100);
    let rawStake = Math.max(MIN_STAKE, calculatedRisk); 
    rawStake = Math.min(rawStake, state.balance);       
    const stake = Math.round(rawStake * 100) / 100;     
    
    state.currentStake = stake;

    addLog(`🎯 SNAPSHOT SETUP DETECTED! Over-3 density precisely at 60% and rising. Trigger digit 6 printed. Stake assigned: $${stake.toFixed(2)}. Execution sent.`);

    state.activeRealTrade = { stake, balanceBefore: state.balance };
    
    send({
      proposal: 1, amount: stake, basis: 'stake', currency: state.currency || 'USD',
      duration: 1, duration_unit: 't', underlying_symbol: MARKET.sym,
      contract_type: 'DIGITOVER', barrier: FIXED_BARRIER, req_id: ++reqId
    });

    broadcastSSE({ state: sanitizeState() });
  }
}

// ---------- East African Time (EAT) Clock Engine ----------
function getEATDateString() {
  return new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi" });
}

setInterval(() => {
  const nowEAT = new Date().toLocaleTimeString("en-US", { timeZone: "Africa/Nairobi", hour12: false });
  
  // UPGRADE: Complete Automated Zero-Manual-Intervention Midnight Hard-Reset Sequence
  if (nowEAT === "00:00:00") {
    addLog(`⏰ Midnight EAT reached. Resetting daily boundaries and lifting all psychological hard-locks...`);
    
    state.locked = false;
    state.lockReason = '';
    state.dailyStartBalance = null;
    state.dailyPnl = 0;
    
    state.active = true;
    state.warmupComplete = false;
    state.warmupTicksFed = 0;
    state.liveSubscribed = false;
    state.tradeInProgress = false;
    state.activeRealTrade = null;
    state.settleTicksRemaining = 0;
    
    connectDeriv();
    saveState();
    broadcastSSE({ state: sanitizeState() });
  }
}, 1000);

// ---------- WebSocket Router Architecture & Heartbeats ----------
let derivWs = null;
let reqId = 0;
let heartbeatInterval = null;
let heartbeatTimeout = null;

function send(msg) {
  if (derivWs && derivWs.readyState === WebSocket.OPEN) derivWs.send(JSON.stringify(msg));
}

async function connectDeriv() {
  if (!state.active) return;
  
  // Clear any dangling heartbeats before attempting connection strings
  clearInterval(heartbeatInterval);
  clearTimeout(heartbeatTimeout);

  const appId = (process.env.DERIV_APP_ID || '').trim();
  const token = (process.env.DERIV_PAT || '').trim();

  if (!appId || !token) {
    addLog('Configuration rejection: Active environment tokens not found.');
    return;
  }

  try {
    const accountsResponse = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' }
    });

    if (!accountsResponse.ok) throw new Error('API Access Token unauthorized.');

    const accountsData = await accountsResponse.json();
    const accountList = Array.isArray(accountsData.data) ? accountsData.data : [accountsData.data];
    const account = accountList.find(acc => acc.account_type === (state.tradingMode || 'demo'));
    
    if (!account) throw new Error(`Target profile configuration mismatch.`);

    const accountId = account.account_id;
    state.accountType = account.account_type === 'demo' ? '🧪 DEMO SCALPING PIPELINE' : '⚠️ PRODUCTION LIVE PORTFOLIO';
    state.balance = parseFloat(account.balance);
    state.currency = account.currency || 'USD';
    
    if (state.dailyStartBalance === null) state.dailyStartBalance = state.balance;

    addLog(`✅ Pipeline Connected: ${accountId} (${state.accountType})`);

    const otpResponse = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' }
    });

    if (!otpResponse.ok) throw new Error('Security framework token acquisition rejected.');

    const otpData = await otpResponse.json();
    derivWs = new WebSocket(otpData.data.url);

    derivWs.on('open', () => {
      addLog(`Initializing strict 100-tick buffer calibration array...`);
      send({ balance: 1, subscribe: 1, req_id: ++reqId });
      send({ ticks_history: MARKET.sym, count: WARMUP_TICKS, end: 'latest', req_id: ++reqId });

      // UPGRADE: Intelligently manage active/half-open connections via standard ping intervals
      heartbeatInterval = setInterval(() => {
        send({ ping: 1 });
        
        // If server fails to response in 5 seconds, cut the cord
        heartbeatTimeout = setTimeout(() => {
          addLog('🚨 Fault Intercept: WebSocket half-open connection detected. Forcing socket termination...');
          if (derivWs) derivWs.terminate(); 
        }, 5000);
      }, 3000);
    });

    derivWs.on('message', data => { try { handleMessage(JSON.parse(data)); } catch(e) {} });
    
    derivWs.on('close', () => { 
      clearInterval(heartbeatInterval);
      clearTimeout(heartbeatTimeout);
      
      if (state.active && !state.locked) {
        addLog('⚠️ Connection drop detected. Initializing automatic system hot-swap recovery...');
        setTimeout(connectDeriv, 3000);
      }
    });
  } catch (e) {
    addLog(`Pipeline core connection fault: ${e.message}. Retrying in 10s...`);
    if (state.active && !state.locked) setTimeout(connectDeriv, 10000);
  }
}

function handleMessage(msg) {
  // Clear pong intercept timers cleanly upon successful message callbacks
  if (msg.msg_type === 'ping') {
    clearTimeout(heartbeatTimeout);
    return;
  }

  if (msg.error) {
    addLog(`Deriv Server Error: ${msg.error.message}`);
    state.tradeInProgress = false; state.activeRealTrade = null; state.settleTicksRemaining = 0;
    return;
  }
  if (msg.msg_type === 'balance') {
    state.balance = parseFloat(msg.balance.balance);
    broadcastSSE({ state: sanitizeState() });
  } else if (msg.msg_type === 'history') {
    state.warmupTicksFed += msg.history.prices.length;
    for (const p of msg.history.prices) engine.feed(p);
    if (state.warmupTicksFed >= WARMUP_TICKS && !state.liveSubscribed) {
      state.warmupComplete = true; state.liveSubscribed = true;
      addLog('✅ Momentum framework calibrated. Continuous structural monitoring active.');
      send({ ticks: MARKET.sym, req_id: ++reqId });
    }
    broadcastSSE({ state: sanitizeState() });
  } else if (msg.msg_type === 'tick') {
    if (msg.tick.symbol !== MARKET.sym) return;
    processTick(parseFloat(msg.tick.quote));
    broadcastSSE({ state: sanitizeState() });
  } else if (msg.msg_type === 'proposal') {
    send({ buy: msg.proposal.id, price: msg.proposal.ask_price, req_id: ++reqId });
  } else if (msg.msg_type === 'buy') {
    if (state.activeRealTrade) state.settleTicksRemaining = SETTLE_TICKS;
  }
}

app.get('/api/logs', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  sseClients.add(res); res.write(`data: ${JSON.stringify({ state: sanitizeState() })}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/state', (req, res) => res.json({ ...state, logs: undefined }));

app.post('/api/control', (req, res) => {
  const { action, mode } = req.body;
  if (action === 'set_mode') {
    if (state.active) return res.status(400).json({ error: 'Core processing engine active.' });
    state.tradingMode = mode; state.dailyStartBalance = null; state.dailyPnl = 0;
    saveState(); broadcastSSE({ state: sanitizeState() }); return res.json({ success: true });
  }
  if (action === 'start') {
    state.active = true; state.locked = false; state.dailyStartBalance = null; state.dailyPnl = 0;
    state.warmupComplete = false; state.warmupTicksFed = 0; state.liveSubscribed = false;
    state.tradeInProgress = false; state.activeRealTrade = null; state.settleTicksRemaining = 0;
    addLog(`🚀 Core Manually Initiated. Targeting Over-3 Momentum Setup.`);
    connectDeriv(); saveState();
  } else if (action === 'stop') {
    state.active = false; if (derivWs) derivWs.close();
    state.tradeInProgress = false; addLog('🚨 User Kill-Switch Triggered. Core forced offline.'); saveState();
  }
  broadcastSSE({ state: sanitizeState() }); res.json({ success: true });
});

loadState();
server.listen(PORT, () => console.log(`Over-3 Matrix Active on Port ${PORT}`));
