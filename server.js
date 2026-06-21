const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { saveTradeToCloud } = require('./database'); // ⚡ Step 2 Cloud Hook Connected!

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const STATE_FILE = '/var/data/deriv_multimarket_state.json';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

// ---------- Markets Configuration ----------
const MARKETS = {
  'R_10':  { id: 'R_10',  name: 'Volatility 10 Index',  dp: 3 },
  'R_25':  { id: 'R_25',  name: 'Volatility 25 Index',  dp: 3 },
  'R_50':  { id: 'R_50',  name: 'Volatility 50 Index',  dp: 4 },
  'R_75':  { id: 'R_75',  name: 'Volatility 75 Index',  dp: 4 },
  'R_100': { id: 'R_100', name: 'Volatility 100 Index', dp: 2 }
};
const BUFFER_CAPACITY = 1000;

class MultiMarketPipeline {
  constructor() {
    this.buffers = {};
    for (const symbol in MARKETS) {
      this.buffers[symbol] = [];
    }
  }

  extractDigit(price, dp) {
    return parseInt(parseFloat(price).toFixed(dp).slice(-1));
  }

  seed(symbol, prices) {
    const config = MARKETS[symbol];
    this.buffers[symbol] = prices.map(p => this.extractDigit(p, config.dp));
    if (this.buffers[symbol].length > BUFFER_CAPACITY) {
      this.buffers[symbol] = this.buffers[symbol].slice(-BUFFER_CAPACITY);
    }
  }

  feed(symbol, price) {
    const config = MARKETS[symbol];
    const digit = this.extractDigit(price, config.dp);
    this.buffers[symbol].push(digit);
    if (this.buffers[symbol].length > BUFFER_CAPACITY) this.buffers[symbol].shift();
    return this.analyze(symbol);
  }

  analyze(symbol) {
    const ticks = this.buffers[symbol];
    if (ticks.length < BUFFER_CAPACITY) return null;

    const freq = Array(10).fill(0);
    ticks.forEach(d => freq[d]++);

    // Calculate Percentages
    const pcts = freq.map(count => (count / BUFFER_CAPACITY) * 100);

    // Rule 2 Check: 0 < 10%, 1/2/3 < 10.5%
    const rule2Passed = (pcts[0] < 10.0) && (pcts[1] < 10.5) && (pcts[2] < 10.5) && (pcts[3] < 10.5);

    // Rule 3 Check: Green Circle on 7,8,9 >= 11.5%
    let greenCircle = 0;
    let maxCount = -1;
    for (let i = 0; i <= 9; i++) {
      if (freq[i] >= maxCount) { maxCount = freq[i]; greenCircle = i; }
    }
    const rule3Passed = (greenCircle === 7 || greenCircle === 8 || greenCircle === 9) && (pcts[greenCircle] >= 11.5);

    // Macro Bias Metrics (Over/Under calculations)
    const over0 = (ticks.filter(d => d > 0).length / BUFFER_CAPACITY) * 100;
    const under9 = (ticks.filter(d => d < 9).length / BUFFER_CAPACITY) * 100;
    const over1 = (ticks.filter(d => d > 1).length / BUFFER_CAPACITY) * 100;
    const under8 = (ticks.filter(d => d < 8).length / BUFFER_CAPACITY) * 100;
    const over2 = (ticks.filter(d => d > 2).length / BUFFER_CAPACITY) * 100;
    const under7 = (ticks.filter(d => d < 7).length / BUFFER_CAPACITY) * 100;
    const over3 = (ticks.filter(d => d > 3).length / BUFFER_CAPACITY) * 100;
    const under6 = (ticks.filter(d => d < 6).length / BUFFER_CAPACITY) * 100;
    const over4 = (ticks.filter(d => d > 4).length / BUFFER_CAPACITY) * 100;
    const under5 = (ticks.filter(d => d < 5).length / BUFFER_CAPACITY) * 100;

    const biasPassed = (over0 > under9) && (over1 > under8) && (over2 > under7) && (over3 > under6) && (over4 > under5);

    // Combined Macro Gap (Issue B Score)
    const totalGap = (over0 - under9) + (over1 - under8) + (over2 - under7) + (over3 - under6) + (over4 - under5);

    // Step 4 Checklist: Sequence [D1, D2, D3] where D1, D2 in [0,2,3] and D3 == 1
    const last3 = ticks.slice(-3);
    let sequencePassed = false;
    if (last3.length === 3) {
      const allowed = [0, 2, 3];
      if (allowed.includes(last3[0]) && allowed.includes(last3[1]) && last3[2] === 1) {
        sequencePassed = true;
      }
    }

    const filtersValidated = rule2Passed && rule3Passed && biasPassed;

    return {
      symbol,
      pcts,
      greenCircle,
      densityOver3: Math.round((ticks.filter(d => d > 3).length / BUFFER_CAPACITY) * 100),
      last3,
      totalGap,
      filtersValidated,
      triggerFired: filtersValidated && sequencePassed
    };
  }
}

const engine = new MultiMarketPipeline();

const state = {
  active: false,
  tradingMode: 'demo',
  balance: null,
  currency: 'USD',
  dailyStartBalance: null,
  dailyPnl: 0,
  locked: false,
  lockReason: '',
  tradeInProgress: false,
  activeRealTrade: null,
  settleTicksRemaining: 0,
  currentStake: 0.35,
  cooldownTicksLeft: 0,
  marketMetrics: {},
  logs: []
};

function sanitizeState() {
  const { logs, ...rest } = state;
  return rest;
}

// ---------- Safety Caps ----------
const RISK_PERCENT = 1;
const TP_PERCENT = 2;
const SL_PERCENT = 4;
const MIN_STAKE = 0.35;
const COOLDOWN_TICKS = 6;
const SETTLE_TICKS = 3;

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      date: new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi" }),
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
      const today = new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi" });
      if (saved.date === today) {
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
    state.lockReason = `🎯 Target Achieved: Session locked up at +$${state.dailyPnl.toFixed(2)} (2% Cap).`;
    addLog(state.lockReason); return true;
  }
  if (state.dailyPnl <= -slLimit) {
    state.locked = true; state.active = false;
    state.lockReason = `🛑 Risk Limit Breached: Session halted at -$${Math.abs(state.dailyPnl).toFixed(2)} (4% Max Loss).`;
    addLog(state.lockReason); return true;
  }
  return false;
}

function settleRealTrade() {
  if (!state.activeRealTrade || state.balance == null) return;
  const profit = state.balance - state.activeRealTrade.balanceBefore;
  state.dailyPnl += profit;
  
  const isWin = profit >= 0;
  const grossPayout = isWin ? (state.activeRealTrade.stake + profit) : 0;

  // ⚡ Non-blocking background call out to Supabase Database
  saveTradeToCloud({
    asset: MARKETS[state.activeRealTrade.symbol]?.name || state.activeRealTrade.symbol,
    contractType: state.activeRealTrade.contractType,
    stake: state.activeRealTrade.stake,
    payout: grossPayout,
    isWin: isWin,
    barrier: state.activeRealTrade.barrier,
    exitTick: state.activeRealTrade.exitTick
  });
  
  addLog(`[Settlement] Asset: ${state.activeRealTrade.symbol} | Result: ${isWin ? '🟢 WIN (+$' : '🔴 LOSS (-$'}${Math.abs(profit).toFixed(2)}) | Session Net: $${state.dailyPnl.toFixed(2)}`);
  
  state.tradeInProgress = false; state.activeRealTrade = null; state.settleTicksRemaining = 0;
  state.cooldownTicksLeft = COOLDOWN_TICKS;

  const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  checkDailyLimits(); saveState(); broadcastSSE({ state: sanitizeState() });
}

function processLiveFeed(symbol, price) {
  if (state.settleTicksRemaining > 0) {
    state.settleTicksRemaining--;
    if (state.settleTicksRemaining === 0) {
      // ⚡ Capture landing digit right as contract settlement fires
      if (state.activeRealTrade && MARKETS[symbol]) {
        state.activeRealTrade.exitTick = engine.extractDigit(price, MARKETS[symbol].dp);
      }
      settleRealTrade();
    }
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  const analysis = engine.feed(symbol, price);
  if (!analysis) return;

  state.marketMetrics[symbol] = analysis;

  if (state.cooldownTicksLeft > 0) {
    state.cooldownTicksLeft--;
  }

  // Check automated triggers across the setup
  if (state.active && !state.locked && !state.tradeInProgress && state.cooldownTicksLeft === 0) {
    let triggeringMarkets = [];
    
    for (const key in MARKETS) {
      const mAnalysis = state.marketMetrics[key];
      if (mAnalysis && mAnalysis.triggerFired) {
        triggeringMarkets.push(mAnalysis);
      }
    }

    if (triggeringMarkets.length > 0) {
      // Issue B: Tie-breaker ranking by biggest cumulative Over/Under Gap score
      triggeringMarkets.sort((a, b) => b.totalGap - a.totalGap);
      const topMarket = triggeringMarkets[0];

      state.tradeInProgress = true;
      const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
      state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

      addLog(`🔥 Trigger Fired on Top-Ranked Asset: ${topMarket.symbol} | Gap Score: ${topMarket.totalGap.toFixed(1)}% | Sequence: [${topMarket.last3.join(',')}]`);
      
      // ⚡ Added detailed parameters for DB record tracking
      state.activeRealTrade = { 
        symbol: topMarket.symbol, 
        stake: state.currentStake, 
        balanceBefore: state.balance,
        contractType: "DIGITOVER",
        barrier: 3
      };

      send({
        buy: 1,
        price: state.currentStake,
        parameters: {
          amount: state.currentStake,
          basis: "stake",
          contract_type: "DIGITOVER",
          currency: state.currency,
          duration: 1,
          duration_unit: "t",
          symbol: topMarket.symbol,
          barrier: "3"
        },
        req_id: ++reqId
      });
    }
  }

  broadcastSSE({ state: sanitizeState() });
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
}

async function connectDeriv() {
  disconnectDeriv();
  const appId = (process.env.DERIV_APP_ID || '').trim();
  const token = (process.env.DERIV_PAT || '').trim();

  if (!appId || !token) {
    addLog('System Configuration Halt: App ID or Token runtime credentials missing.');
    return;
  }

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
      addLog(`🌐 Multi-Channel Pipeline Connected. Sync Balance: $${state.balance.toFixed(2)}`);
      send({ balance: 1, subscribe: 1, req_id: ++reqId });

      // Load buffers for all 5 assets sequentially
      for (const key in MARKETS) {
        send({ ticks_history: key, count: BUFFER_CAPACITY, end: 'latest', req_id: ++reqId });
      }

      keepAliveLoop = setInterval(() => {
        send({ ping: 1 });
        watchdogTimer = setTimeout(() => {
          addLog('🚨 Connection pipeline timeout. Initializing reset loop...');
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
      setTimeout(connectDeriv, 2000);
    });

    derivWs.on('error', () => { if (derivWs) derivWs.terminate(); });

  } catch(e) {
    addLog(`Network Link Exception: ${e.message}. Retrying link...`);
    setTimeout(connectDeriv, 5000);
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
    const symbol = msg.echo_req.ticks_history;
    engine.seed(symbol, msg.history.prices);
    addLog(`✅ History synchronized for ${symbol} (1000-Tick buffer initialized)`);
    send({ ticks: symbol, req_id: ++reqId });
  } else if (msg.msg_type === 'tick') {
    processLiveFeed(msg.tick.symbol, parseFloat(msg.tick.quote));
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
    saveState(); connectDeriv(); return res.json({ success: true });
  }
  if (action === 'start') {
    state.active = true; state.locked = false;
    addLog(`🚀 Core Armed. Running parallel scanning arrays across 5 index indices.`);
  } else if (action === 'stop') {
    state.active = false; state.tradeInProgress = false;
    addLog('🚨 Core Disarmed safely. Active background sync still maintaining matrices.');
  }
  saveState(); broadcastSSE({ state: sanitizeState() }); res.json({ success: true });
});

app.post('/api/manual-trade', (req, res) => {
  const { symbol, contractType } = req.body;
  if (state.locked || state.tradeInProgress || !MARKETS[symbol]) {
    return res.status(400).json({ error: 'Execution Rejected: Safety intervention active.' });
  }

  state.tradeInProgress = true;
  const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  addLog(`⚡ Manual Dispatch on ${symbol} | Mode: ${contractType} | Stake Asset: $${state.currentStake}`);
  
  // ⚡ Track metrics accurately for custom manual actions
  state.activeRealTrade = { 
    symbol, 
    stake: state.currentStake, 
    balanceBefore: state.balance,
    contractType: contractType === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER',
    barrier: 3
  };

  send({
    buy: 1,
    price: state.currentStake,
    parameters: {
      amount: state.currentStake,
      basis: "stake",
      contract_type: contractType === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER',
      currency: state.currency,
      duration: 1,
      duration_unit: "t",
      symbol: symbol,
      barrier: "3"
    },
    req_id: ++reqId
  });

  broadcastSSE({ state: sanitizeState() }); res.json({ success: true });
});

loadState();
connectDeriv();
server.listen(PORT, () => console.log(`5-Market Matrix Pipeline executing on port ${PORT}`));
