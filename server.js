const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const STATE_FILE = '/var/data/deriv_state.json';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- SSE ----------
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

// ---------- Market & Strategy ----------
const MARKET = { sym: 'R_75', name: 'Volatility 75 Index', dp: 4 };
const FIXED_BARRIER = 3;
const DIGIT_SUM_TARGET = 26;           // tighter trigger
const BASE_STAKE = 0.35;
const MARTINGALE = 2.15;
const VIRTUAL_LOSSES_NEEDED = 1;      // backtested optimum
const COOLDOWN_TICKS = 15;            // 15 ticks between trades
const DAILY_PROFIT_CAP = 2.00;        // bank profits early
const DAILY_STOP_LOSS = 5.00;
const SETTLE_TICKS = 5;               // wait 5 ticks, then check balance

// ---------- State ----------
const state = {
  active: false,
  balance: null,
  currency: 'USD',
  dailyStartBalance: null,
  dailyPnl: 0,
  locked: false,
  lockReason: '',

  mode: 'virtual',
  virtualLosses: 0,
  realStake: BASE_STAKE,
  cooldownTicksLeft: 0,
  waitingForOutcome: false,

  realTradeInProgress: false,
  activeRealTrade: null,
  settleTicksRemaining: 0,
  logs: [],
  sessionAlreadyUsedToday: false
};

// ---------- Persistence ----------
function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      date: new Date().toISOString().slice(0,10),
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
      const today = new Date().toISOString().slice(0,10);
      if (saved.date === today && saved.sessionActive) {
        state.sessionAlreadyUsedToday = true;
        state.locked = true;
        state.lockReason = 'Session already used today.';
        addLog(state.lockReason);
      }
      if (saved.date === today) {
        state.dailyStartBalance = saved.dailyStartBalance;
        state.dailyPnl = saved.dailyPnl || 0;
        if (saved.locked) { state.locked = true; state.lockReason = saved.lockReason || ''; }
      }
    }
  } catch(e) {}
}

// ---------- Helpers ----------
function checkDailyLimits() {
  if (!state.dailyStartBalance) return false;
  if (state.dailyPnl >= DAILY_PROFIT_CAP) {
    state.locked = true;
    state.lockReason = `Daily profit target $${DAILY_PROFIT_CAP} reached.`;
    addLog(state.lockReason);
    return true;
  }
  if (state.dailyPnl <= -DAILY_STOP_LOSS) {
    state.locked = true;
    state.lockReason = `Daily stop-loss $${DAILY_STOP_LOSS} hit.`;
    addLog(state.lockReason);
    return true;
  }
  return false;
}

function digitSum(price, dp) {
  const formatted = parseFloat(price).toFixed(dp);
  const dec = formatted.split('.')[1] || '';
  let sum = 0;
  for (const ch of dec) sum += parseInt(ch);
  return sum;
}

// ---------- Virtual outcome ----------
function resolveVirtualOutcome(currentPrice) {
  if (!state.waitingForOutcome) return;
  state.waitingForOutcome = false;

  const lastDigit = parseInt(parseFloat(currentPrice).toFixed(MARKET.dp).slice(-1));
  const win = lastDigit > FIXED_BARRIER;

  if (win) {
    state.virtualLosses = 0;
    addLog(`VIRTUAL WIN – losses reset`);
  } else {
    state.virtualLosses++;
    addLog(`VIRTUAL LOSS (${state.virtualLosses}/${VIRTUAL_LOSSES_NEEDED})`);
    if (state.virtualLosses >= VIRTUAL_LOSSES_NEEDED) {
      state.mode = 'real';
      // ✅ NO reset of realStake – keep whatever it was (martingale preserved)
      addLog(`→ REAL mode (stake $${state.realStake.toFixed(2)})`);
    }
  }
  state.cooldownTicksLeft = COOLDOWN_TICKS;
}

// ---------- Real trade settlement (tick‑based balance change) ----------
function settleRealTrade() {
  if (!state.activeRealTrade || !state.balance) return;
  const profit = state.balance - state.activeRealTrade.balanceBefore;
  state.dailyPnl += profit;
  const result = profit >= 0 ? 'WIN' : 'LOSS';
  addLog(`REAL ${result}: ${profit.toFixed(2)} | Daily P&L: ${state.dailyPnl.toFixed(2)}`);

  if (profit >= 0) {
    state.realStake = BASE_STAKE;
    state.mode = 'virtual';
    state.virtualLosses = 0;
    addLog('→ Back to VIRTUAL mode (stake reset)');
  } else {
    state.realStake = Math.round(Math.min(state.realStake * MARTINGALE, state.balance) * 100) / 100;
    state.mode = 'virtual';
    state.virtualLosses = 0;
    addLog(`→ Back to VIRTUAL (next real stake: $${state.realStake.toFixed(2)})`);
  }

  state.realTradeInProgress = false;
  state.activeRealTrade = null;
  state.settleTicksRemaining = 0;
  state.cooldownTicksLeft = COOLDOWN_TICKS;

  checkDailyLimits();
  saveState();
  broadcastSSE({ state: sanitizeState() });
}

// ---------- Tick processing ----------
function processTick(price) {
  if (!state.active || state.locked) return;

  if (state.settleTicksRemaining > 0) {
    state.settleTicksRemaining--;
    if (state.settleTicksRemaining === 0) {
      settleRealTrade();
    }
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  if (state.waitingForOutcome) {
    resolveVirtualOutcome(price);
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  if (state.cooldownTicksLeft > 0) {
    state.cooldownTicksLeft--;
    return;
  }

  if (state.realTradeInProgress) return;

  const sum = digitSum(price, MARKET.dp);
  if (sum <= DIGIT_SUM_TARGET) return;

  if (state.mode === 'virtual') {
    state.waitingForOutcome = true;
    addLog(`VIRTUAL entry – digit sum ${sum} > ${DIGIT_SUM_TARGET}`);
  } else {
    state.realTradeInProgress = true;
    const stake = Math.round(Math.min(state.realStake, state.balance || Infinity) * 100) / 100;
    addLog(`REAL entry – stake $${stake.toFixed(2)} (digit sum ${sum})`);

    state.activeRealTrade = {
      stake,
      balanceBefore: state.balance,
    };
    state.settleTicksRemaining = 0;

    send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      currency: state.currency || 'USD',
      duration: 1,
      duration_unit: 't',
      underlying_symbol: MARKET.sym,
      contract_type: 'DIGITOVER',
      barrier: FIXED_BARRIER
    });
  }

  broadcastSSE({ state: sanitizeState() });
}

// ---------- WebSocket connection (PAT → OTP) ----------
let derivWs = null;

function send(msg) {
  if (derivWs && derivWs.readyState === WebSocket.OPEN) derivWs.send(JSON.stringify(msg));
}

async function fetchOTP() {
  return new Promise((resolve, reject) => {
    const appId = process.env.DERIV_APP_ID;
    const pat = process.env.DERIV_PAT;
    const accountId = process.env.DERIV_ACCOUNT_ID;
    if (!appId || !pat || !accountId) return reject(new Error('Missing credentials'));
    const req = https.request({
      hostname: 'api.derivws.com',
      path: `/trading/v1/options/accounts/${accountId}/otp`,
      method: 'POST',
      headers: {
        'Deriv-App-ID': appId,
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data?.data?.url) resolve(data.data.url);
          else reject(new Error(data?.error?.message || 'No OTP URL'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function connectDeriv() {
  try {
    addLog('Fetching OTP…');
    const wsUrl = await fetchOTP();
    derivWs = new WebSocket(wsUrl);
    derivWs.on('open', () => {
      addLog('Connected. Subscribing to balance & ticks.');
      send({ balance: 1, subscribe: 1 });
      send({ ticks_history: MARKET.sym, count: 1000, end: 'latest' });
    });
    derivWs.on('message', data => {
      try { handleMessage(JSON.parse(data)); } catch(e) {}
    });
    derivWs.on('close', () => {
      addLog('WebSocket closed. Reconnecting in 5s…');
      setTimeout(connectDeriv, 5000);
    });
    derivWs.on('error', err => addLog(`WebSocket error: ${err.message}`));
  } catch (e) {
    addLog(`Connection error: ${e.message}. Retrying in 10s…`);
    setTimeout(connectDeriv, 10000);
  }
}

function handleMessage(msg) {
  if (msg.error) {
    addLog(`Deriv error: ${msg.error.message}`);
    if (state.realTradeInProgress) {
      state.realTradeInProgress = false;
      state.activeRealTrade = null;
      state.settleTicksRemaining = 0;
      addLog('Trade aborted due to API error.');
    }
    return;
  }

  const mt = msg.msg_type;

  if (mt === 'balance' && msg.balance) {
    state.balance = parseFloat(msg.balance.balance);
    state.currency = msg.balance.currency;
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  if (mt === 'history') {
    send({ ticks: MARKET.sym });
    return;
  }

  if (mt === 'tick' && msg.tick?.symbol === MARKET.sym) {
    processTick(parseFloat(msg.tick.quote));
    broadcastSSE({ state: sanitizeState() });
    return;
  }

  if (mt === 'proposal' && state.activeRealTrade) {
    const askPrice = msg.proposal.ask_price;
    send({ buy: msg.proposal.id, price: askPrice });
    return;
  }

  if (mt === 'buy' && state.activeRealTrade) {
    const contractId = msg.buy.contract_id;
    addLog(`Contract bought – ID ${contractId}`);
    state.settleTicksRemaining = SETTLE_TICKS;
    return;
  }
}

// ---------- API ----------
app.get('/api/logs', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('\n'); sseClients.add(res);
  res.write(`data: ${JSON.stringify({ state: sanitizeState() })}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/state', (req, res) => res.json({ ...state, logs: undefined }));

app.post('/api/control', (req, res) => {
  const { action } = req.body;
  if (action === 'start') {
    if (state.sessionAlreadyUsedToday) return res.status(403).json({ error: 'Session already used today.' });
    state.active = true; state.locked = false;
    state.dailyStartBalance = state.balance; state.dailyPnl = 0;
    state.mode = 'virtual'; state.virtualLosses = 0; state.realStake = BASE_STAKE;
    state.cooldownTicksLeft = 0; state.waitingForOutcome = false;
    state.realTradeInProgress = false; state.activeRealTrade = null;
    state.settleTicksRemaining = 0;
    addLog('R_75 Decimal‑Sum Bot started (digit sum >26, VL=1, cooldown 15, TP $2, SL $5, martingale 2.15x)');
    saveState();
  } else if (action === 'stop') {
    state.active = false;
    state.realTradeInProgress = false; state.activeRealTrade = null;
    state.settleTicksRemaining = 0;
    addLog('Trading stopped.'); saveState();
  }
  broadcastSSE({ state: sanitizeState() }); res.json({ success: true });
});

loadState();
connectDeriv();
server.listen(PORT, () => console.log(`R_75 bot on port ${PORT}`));
