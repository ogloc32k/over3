require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// --- SINGLE SOURCE OF TRUTH ---
const { supabase, saveTradeToCloud } = require('./database.js'); 

const app = express();
const server = http.createServer(app);

// --- VARIABLE DEFINITIONS ---
const PORT = process.env.PORT || 3000;
const STATE_FILE = '/var/data/deriv_multimarket_state.json';

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
// --- UPDATED: Analytics API Endpoint (Seamless Pipe) ---
app.get('/api/ledger/analytics', async (req, res) => {
  const { start, end, mode } = req.query;

  // 1. SESSION / REAL-TIME PULL
  if (mode === 'session') {
    const settlements = state.logs ? state.logs.filter(l => l.message.includes('Settlement')) : [];
    const wins = settlements.filter(l => l.message.includes('WIN')).length;
    const strikeRate = settlements.length > 0 ? ((wins / settlements.length) * 100).toFixed(1) : 0;

    return res.json({
      totalProfit: state.dailyPnl || 0,
      strikeRate: strikeRate,
      totalTrades: settlements.length,
      rawData: []
    });
  }

  // 2. HISTORICAL / DATABASE PULL
  try {
    const { data, error } = await supabase
      .from('trading_ledger')
      .select('*')
      .gte('created_at', start)
      .lte('created_at', end);

    if (error) throw error;
    
    // Calculate analytics from DB results
    const totalProfit = data.reduce((acc, curr) => acc + (curr.profit_loss || 0), 0);
    const totalTrades = data.length;
    const wins = data.filter(t => t.is_win).length;
    const strikeRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
    
    res.json({ 
      totalProfit: totalProfit.toFixed(2), 
      strikeRate, 
      totalTrades, 
      rawData: data 
    });
  } catch (err) {
    console.error('❌ Analytics Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch historical data' });
  }
});
// --- REQUIRED: Live Logging System ---
// Without these, your dashboard will not receive real-time updates!
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

    const pcts = freq.map(count => (count / BUFFER_CAPACITY) * 100);
    const rule2Passed = (pcts[0] < 10.0) && (pcts[1] < 10.5) && (pcts[2] < 10.5) && (pcts[3] < 10.5);

    let greenCircle = 0;
    let maxCount = -1;
    for (let i = 0; i <= 9; i++) {
      if (freq[i] >= maxCount) { maxCount = freq[i]; greenCircle = i; }
    }
    const rule3Passed = (greenCircle === 7 || greenCircle === 8 || greenCircle === 9) && (pcts[greenCircle] >= 11.5);

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
    const totalGap = (over0 - under9) + (over1 - under8) + (over2 - under7) + (over3 - under6) + (over4 - under5);

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

const RISK_PERCENT = 1;
const TP_PERCENT = 2;
const SL_PERCENT = 4;
const MIN_STAKE = 0.35;
const COOLDOWN_TICKS = 1; //changed cooldown 
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
  // 1. Guard: Ensure trade is valid and was actually purchased
  if (!state.activeRealTrade || !state.activeRealTrade.contractId || state.balance == null) {
    // Only reset if we were supposedly in a trade but have no ID
    if (state.activeRealTrade) {
      addLog("⚠️ Trade closed or never executed. Resetting state.");
      state.tradeInProgress = false;
      state.activeRealTrade = null;
    }
    return;
  }

  // 2. Calculate PnL
  const profit = state.balance - state.activeRealTrade.balanceBefore;
  state.dailyPnl += profit;
  
  const isWin = profit >= 0;
  const grossPayout = isWin ? (state.activeRealTrade.stake + profit) : 0;

  // 3. Log to Cloud
  saveTradeToCloud({
    contract_id: state.activeRealTrade.contractId, // Added for audit trail
    asset: MARKETS[state.activeRealTrade.symbol]?.name || state.activeRealTrade.symbol,
    contractType: state.activeRealTrade.contractType,
    stake: state.activeRealTrade.stake,
    payout: grossPayout,
    isWin: isWin,
    barrier: state.activeRealTrade.barrier,
    exitTick: state.activeRealTrade.exitTick
  });

  // 4. Log to Dashboard
  addLog(`[Settlement] Asset: ${state.activeRealTrade.symbol} | Result: ${isWin ? '🟢 WIN (+$' : '🔴 LOSS (-$'}${Math.abs(profit).toFixed(2)}) | Session Net: $${state.dailyPnl.toFixed(2)}`);

  // 5. Cleanup
  state.tradeInProgress = false; 
  state.activeRealTrade = null; 
  state.settleTicksRemaining = 0;
  state.cooldownTicksLeft = COOLDOWN_TICKS;

  // 6. Refresh System State
  const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

  checkDailyLimits(); 
  saveState(); 
  broadcastSSE({ state: sanitizeState() });
}
  
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
  if (state.cooldownTicksLeft > 0) state.cooldownTicksLeft--;

  if (state.active && !state.locked && !state.tradeInProgress && state.cooldownTicksLeft === 0) {
    let triggeringMarkets = [];
    for (const key in MARKETS) {
      const mAnalysis = state.marketMetrics[key];
      if (mAnalysis && mAnalysis.triggerFired) triggeringMarkets.push(mAnalysis);
    }

    if (triggeringMarkets.length > 0) {
      triggeringMarkets.sort((a, b) => b.totalGap - a.totalGap);
      const topMarket = triggeringMarkets[0];

      state.tradeInProgress = true;
      const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
      state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

      addLog(`🔥 Trigger Fired on Top-Ranked Asset: ${topMarket.symbol} | Gap Score: ${topMarket.totalGap.toFixed(1)}% | Sequence: [${topMarket.last3.join(',')}]`);
      
      state.activeRealTrade = { 
        symbol: topMarket.symbol, 
        stake: state.currentStake, 
        balanceBefore: state.balance,
        contractType: "DIGITOVER",
        barrier: 3
      };
// --- UPDATED: Auto-trade Proposal Request ---
      addLog(`🔥 Trigger Fired: ${topMarket.symbol}. Requesting proposal...`);
      
      send({
        proposal: 1,
        amount: state.currentStake,
        basis: 'stake',
        contract_type: "DIGITOVER",
        currency: state.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        underlying_symbol: topMarket.symbol,
        barrier: 3,
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
      addLog(`🌐 Pipeline Connected. Balance: $${state.balance.toFixed(2)}`);
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
  // 1. Global API Error Catch
  if (msg.error) {
    addLog(`API Error: ${msg.error.message}`);
    state.tradeInProgress = false; 
    state.activeRealTrade = null; 
    state.settleTicksRemaining = 0;
    return;
  }

  // 2. Proposal Handshake (The gatekeeper)
  if (msg.msg_type === 'proposal') {
    if (msg.error) {
      addLog(`❌ Proposal Error: ${msg.error.message}`);
      state.tradeInProgress = false;
      state.activeRealTrade = null; // Clean up the pending trade object
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

  // 3. System States
  if (msg.msg_type === 'balance') { 
    state.balance = parseFloat(msg.balance.balance); 
    broadcastSSE({ state: sanitizeState() }); 
  }
  else if (msg.msg_type === 'history') {
    const symbol = msg.echo_req.ticks_history;
    engine.seed(symbol, msg.history.prices);
    addLog(`✅ History synchronized for ${symbol}`);
    send({ ticks: symbol, req_id: ++reqId });
  } 
  else if (msg.msg_type === 'tick') { 
    processLiveFeed(msg.tick.symbol, parseFloat(msg.tick.quote)); 
  }
  // 4. Buy Confirmation (Capture Contract ID)
  else if (msg.msg_type === 'buy') { 
    if (state.activeRealTrade) {
      state.activeRealTrade.contractId = msg.buy.contract_id; // Capture ID for settlement
      state.settleTicksRemaining = SETTLE_TICKS;
      addLog(`💰 Trade Executed: Contract ID ${msg.buy.contract_id}`);
    }
  }
}
//------------------MANUAL TRADING PAYLOAD..............//
app.post('/api/manual-trade', (req, res) => {
  const { symbol, contractType } = req.body;
  if (state.locked || state.tradeInProgress || !MARKETS[symbol]) return res.status(400).json({ error: 'Rejected.' });
  state.tradeInProgress = true;
  const rawStake = Math.max(MIN_STAKE, state.balance * (RISK_PERCENT / 100));
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;
  state.activeRealTrade = { symbol, stake: state.currentStake, balanceBefore: state.balance, contractType: contractType === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER', barrier: 3 };
  app.post('/api/manual-trade', (req, res) => {
  const { symbol, contractType } = req.body;
  
  if (state.locked || state.tradeInProgress) {
    return res.status(400).json({ error: 'System locked or trade in progress.' });
  }

  // 1. Calculate stake
  const rawStake = Math.max(0.35, state.balance * (0.01)); // Example 1% risk
  state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;
  
  // 2. Set internal tracking
  state.tradeInProgress = true;
  state.activeRealTrade = { 
    symbol, 
    stake: state.currentStake, 
    contractType: contractType === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER', 
    barrier: 3 
  };

  // 3. Send PROPOSAL instead of BUY
  // This verifies the trade parameters BEFORE sending money
  send({
    proposal: 1,
    amount: state.currentStake,
    basis: 'stake',
    contract_type: state.activeRealTrade.contractType,
    currency: state.currency || 'USD',
    duration: 1,
    duration_unit: 't',
    underlying_symbol: symbol,
    barrier: 3
  });

  addLog(`Requesting proposal for ${symbol}...`);
  res.json({ success: true, message: 'Proposal requested' });
});

// At the very bottom of your file
loadState(); // Ensure this exists to load your current session data
checkDatabaseConnection().then(() => {
  connectDeriv();
  server.listen(PORT, () => console.log(`🚀 System Armed on port ${PORT}`));
});
