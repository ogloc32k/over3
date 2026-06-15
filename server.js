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

// ---------- Server-Sent Events Array Router ----------
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
    last3Ticks: engine ? engine.getLast3() : []
  };
}

// ---------- Over-3 Analysis Engine Setup ----------
const MARKET = { sym: 'R_75', name: 'Volatility 75 Index', dp: 4 };
const FIXED_BARRIER = 3;         
const WARMUP_TICKS = 100;        

const RISK_PERCENT = 1.5;        
const MIN_STAKE = 0.35;          
const TP_PERCENT = 5;            
const SL_PERCENT = 10;           

const COOLDOWN_TICKS = 10;       
const SETTLE_TICKS = 12;

let globalTickCounter = 0;

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
    const wasRising = (previousCount !== null && currentCount > previousCount);
    const isTriggerDigit = (digit === 6);

    const last3 = this.ticks.slice(-3);
    const isExhausted = (last3.length === 3 && last3.every(d => d >= 7));

    return {
      currentPercent: currentCount,
      wasRising: wasRising,
      isTriggerDigit: isTriggerDigit,
      isExhausted: isExhausted,
      literalDigit: digit
    };
  }

  getCurrentDensity() {
    if (this.ticks.length === 0) return 0;
    return this.ticks.filter(d => d > 3).length;
  }

  getLast3() {
    return this.ticks.slice(-3);
  }
}

const engine = new OverThreeTrendEngine();

// ---------- Real-Time Framework State Engine ----------
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
  logs: []
};

// ---------- Session Persistence Framework ----------
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
    state.lockReason = `🎯 Target hit! Secured +$${state.dailyPnl.toFixed(2)}. Unlocking at midnight.`;
    addLog(state.lockReason); disconnectDeriv(); return true;
  }
  if (state.dailyPnl <= -slLimit) {
    state.locked = true; state.active = false;
    state.lockReason = `🛑 Risk Limit hit. Portfolio preserved at -$${Math.abs(state.dailyPnl).toFixed(2)}. Unlocking at midnight.`;
    addLog(state.lockReason); disconnectDeriv(); return true;
  }
  return false;
}

function settleRealTrade() {
  if (!state.activeRealTrade || state.balance == null) return;
  const profit = state.balance - state.activeRealTrade.balanceBefore;
  state.dailyPnl += profit;
  
  addLog(`[${state.tradingMode.toUpperCase()}] Trade Settled: ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} | Today P&L: ${state.dailyPnl.toFixed(2)}`);
  
  state.tradeInProgress = false; state.activeRealTrade = null; state.settleTicksRemaining = 0;
  state.cooldownTicksLeft = COOLDOWN_TICKS;

  const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  checkDailyLimits(); saveState(); broadcastSSE({ state: sanitizeState() });
}

function processTick(price) {
  const metrics = engine.feed(price);
  globalTickCounter++;

  if (!metrics) return;

  if (state.settleTicksRemaining > 0) {
    state.settleTicksRemaining--;
    if (state.settleTicksRemaining === 0) settleRealTrade();
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  if (state.cooldownTicksLeft > 0) { state.cooldownTicksLeft--; return; }
  if (!state.active || state.locked || !state.warmupComplete || state.tradeInProgress) return;

  // OVER-3 SIGNAL INTERCEPTOR
  if (metrics.currentPercent === 60 && metrics.wasRising && metrics.isTriggerDigit) {
    if (metrics.isExhausted) {
      addLog(`⚠️ Exhaustion block triggered (last digits ≥ 7). Skipping setup to protect capital.`);
      return;
    }

    state.tradeInProgress = true;
    const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
    state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

    addLog(`🎯 Momentum match: Over-3 density at 60% and rising. Execution sent with stake $${state.currentStake}`);
    state.activeRealTrade = { stake: state.currentStake, balanceBefore: state.balance };
    
    send({
      proposal: 1, amount: state.currentStake, basis: 'stake', currency: state.currency,
      duration: 1, duration_unit: 't', underlying_symbol: MARKET.sym,
      contract_type: 'DIGITOVER', barrier: FIXED_BARRIER, req_id: ++reqId
    });
    broadcastSSE({ state: sanitizeState() });
  }
}

// ---------- Midnight Automation Reset Loop ----------
function getEATDateString() {
  return new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi" });
}

setInterval(() => {
  const nowEAT = new Date().toLocaleTimeString("en-US", { timeZone: "Africa/Nairobi", hour12: false });
  if (nowEAT === "00:00:00") {
    addLog(`⏰ Midnight EAT reached. Resetting parameters for the new daily session...`);
    state.locked = false; state.lockReason = ''; state.dailyStartBalance = null; state.dailyPnl = 0;
    state.warmupComplete = false; state.warmupTicksFed = 0; state.liveSubscribed = false;
    state.tradeInProgress = false; state.activeRealTrade = null; state.settleTicksRemaining = 0;
    saveState(); connectDeriv();
  }
}, 1000);

// ---------- Connection Persistence Engine ----------
let derivWs = null;
let reqId = 0;
let keepAliveLoop = null;
let watchdogTimer = null;

function send(msg) {
  if (derivWs && derivWs.readyState === WebSocket.OPEN) derivWs.send(JSON.stringify(msg));
}

function disconnectDeriv() {
  clearInterval(keepAliveLoop); 
  clearTimeout(watchdogTimer);
  if (derivWs) { 
    derivWs.removeAllListeners(); 
    try { derivWs.terminate(); } catch(e) {} 
    derivWs = null; 
  }
}

async function connectDeriv() {
  if (!state.active || state.locked) return;
  disconnectDeriv();

  const appId = (process.env.DERIV_APP_ID || '').trim();
  const token = (process.env.DERIV_PAT || '').trim();

  if (!appId || !token) {
    addLog('Configuration Halt: Environment variables for APP_ID or Token are missing.');
    return;
  }

  try {
    const accRes = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' }
    });
    if (!accRes.ok) throw new Error('API Token authorization rejected.');

    const data = await accRes.json();
    const accList = Array.isArray(data.data) ? data.data : [data.data];
    const targetAccount = accList.find(a => a.account_type === state.tradingMode);
    
    if (!targetAccount) throw new Error(`Could not find an active profile matching ${state.tradingMode}`);

    state.balance = parseFloat(targetAccount.balance);
    state.currency = targetAccount.currency || 'USD';
    if (state.dailyStartBalance === null) state.dailyStartBalance = state.balance;

    // DEFENSIVE FIX: Explicitly sending stringified empty object to prevent JSON 400 content-length dropping
    const otpRes = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${targetAccount.account_id}/otp`, {
      method: 'POST', 
      headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!otpRes.ok) throw new Error('Security token acquisition rejected.');

    const otpData = await otpRes.json();
    derivWs = new WebSocket(otpData.data.url);

    derivWs.on('open', () => {
      addLog(`Connected securely to Deriv API. Mirroring wallet balance: $${state.balance.toFixed(2)}`);
      send({ balance: 1, subscribe: 1, req_id: ++reqId });
      send({ ticks_history: MARKET.sym, count: WARMUP_TICKS, end: 'latest', req_id: ++reqId });

      // ACTIVE PERSISTENCE LINK: Keeps the cloud provider from cutting an idle socket
      keepAliveLoop = setInterval(() => {
        send({ ping: 1 });
        
        // Watchdog: If the network socket freezes up, terminate it instantly to trigger immediate hot-swap rebuild
        watchdogTimer = setTimeout(() => {
          addLog('🚨 Anti-Drop Warning: WebSocket stream stalled out. Forcing structural network reset...');
          if (derivWs) derivWs.terminate();
        }, 4000);
      }, 15000);
    });

    derivWs.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        // Intercept ping reflections cleanly to verify live wire integrity
        if (msg.msg_type === 'ping') { clearTimeout(watchdogTimer); return; }
        handleMessage(msg);
      } catch(e) {}
    });

    derivWs.on('close', () => {
      disconnectDeriv();
      if (state.active && !state.locked) {
        addLog('⚠️ Network drift detected. Activating hot-swap reconnect system in 2s...');
        setTimeout(connectDeriv, 2000);
      }
    });

    derivWs.on('error', () => { if (derivWs) derivWs.terminate(); });

  } catch(e) {
    addLog(`Network Link Exception: ${e.message}. Retrying execution in 5s...`);
    if (state.active && !state.locked) setTimeout(connectDeriv, 5000);
  }
}

function handleMessage(msg) {
  if (msg.error) {
    addLog(`Server Error Response: ${msg.error.message}`);
    state.tradeInProgress = false; state.activeRealTrade = null; state.settleTicksRemaining = 0;
    return;
  }
  if (msg.msg_type === 'balance') {
    state.balance = parseFloat(msg.balance.balance);
    broadcastSSE({ state: sanitizeState() });
  } else if (msg.msg_type === 'history') {
    state.warmupTicksFed = msg.history.prices.length;
    for (const p of msg.history.prices) engine.feed(p);
    if (!state.liveSubscribed) {
      state.warmupComplete = true; state.liveSubscribed = true;
      addLog('✅ Technical configuration calibrated. Continuous monitoring active.');
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
    addLog(`🚀 Processing Pipeline Armed. Listening to V75 Index Streams.`);
    connectDeriv(); saveState();
  } else if (action === 'stop') {
    state.active = false; disconnectDeriv();
    state.tradeInProgress = false; addLog('🚨 Core Engine Disarmed Safely.'); saveState();
  }
  broadcastSSE({ state: sanitizeState() }); res.json({ success: true });
});

loadState();
server.listen(PORT, () => console.log(`Production Terminal Operating on Port ${PORT}`));
