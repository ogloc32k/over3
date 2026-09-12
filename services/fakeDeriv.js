// services/fakeDeriv.js
// ============================================================
// Simulated Deriv client – same interface & events as services/deriv.js,
// but generates realistic mean-reverting market data locally.
// No env keys, no network, no real money. Used when DERIV_APP_ID /
// DERIV_PAT are not configured.
// ============================================================

const SYMBOLS = {
  'R_10':    { base: 6325.12,  vol: 0.0035, decimals: 2, interval: 2000 },
  'R_25':    { base: 2841.506,  vol: 0.0055, decimals: 3, interval: 2000 },
  'R_50':    { base: 249.1834,  vol: 0.0075, decimals: 4, interval: 2000 },
  'R_75':    { base: 4127.9021, vol: 0.0095, decimals: 4, interval: 2000 },
  'R_100':   { base: 1573.44,  vol: 0.0120, decimals: 2, interval: 2000 },
  '1HZ10V':  { base: 9418.27,  vol: 0.0035, decimals: 2, interval: 1000 },
  '1HZ25V':  { base: 1204.86,  vol: 0.0055, decimals: 2, interval: 1000 },
  '1HZ50V':  { base: 339.41,   vol: 0.0075, decimals: 2, interval: 1000 },
  '1HZ75V':  { base: 5766.03,  vol: 0.0095, decimals: 2, interval: 1000 },
  '1HZ100V': { base: 703.19,   vol: 0.0120, decimals: 2, interval: 1000 }
};

// OU (mean-reverting) parameters so the Sniper strategy's
// bounce/rejection logic actually finds qualifying setups.
const OU_THETA = 0.03;      // very light pull: keeps price near its anchor
                            // long-term while letting it wander like a real
                            // volatility index (so RSI reaches extremes and
                            // sample autocorrelation dips negative often)
const OU_SIGMA_SCALE = 1.0;

class FakeDerivClient {
  constructor() {
    this.ws = null; // kept for interface parity
    this.listeners = {};
    this.accountId = null;
    this.activeAccountId = null;
    this.isDemo = true;
    this._store = null;
    this._explicitClose = false;
    this._connectionState = 'disconnected';
    this._connectionReason = 'Simulated connection has not been established.';

    this._prices = {};        // symbol → { price, anchor }
    this._timers = [];
    this._openContracts = {}; // contractId → pending settlement info
    this._nextContractId = 100000 + Math.floor(Math.random() * 900000);
    this._demoBalance = 10000;
    this._realBalance = 275.40;

    for (const s of Object.keys(SYMBOLS)) {
      const jitter = 1 + (Math.random() - 0.5) * 0.02;
      this._prices[s] = { price: SYMBOLS[s].base * jitter, anchor: SYMBOLS[s].base * jitter };
    }
  }

  setStore(storeInstance) { this._store = storeInstance; }

  _log(level, message) {
    if (this._store && typeof this._store.addLog === 'function') this._store.addLog(level, message);
    else console.log(message);
  }

  getConnectionState() { return this._connectionState; }
  isConnected() { return this._connectionState === 'connected'; }

  _setConnectionState(state, reason) {
    this._connectionState = state;
    this._connectionReason = reason || this._connectionReason;
    this._emit('connection_state', { state, reason: this._connectionReason, at: Date.now() });
  }

  connect() {
    if (this.isConnected()) return;
    this.accountId = this.isDemo ? 'VRTC-demo-01' : 'CR-real-01';
    this.activeAccountId = this.accountId;
    this._setConnectionState('connecting', 'Connecting to simulated market feed.');
    // Simulated handshake latency (kept tiny so the app feels instant).
    setTimeout(() => {
      this._explicitClose = false;
      this._setConnectionState('connected', 'Simulated market feed connected.');
      this._log('info', `🔌 Simulated Deriv connection established (${this.isDemo ? 'DEMO' : 'REAL'} account, FAKE DATA).`);
      this._emit('authorized', { loginid: this.accountId });
      this._emit('balance', { balance: this._balanceFor(), currency: 'USD', loginid: this.accountId, isDemo: this.isDemo });
      this._startTicks();
    }, 150);
  }

  setMode(mode) {
    this._log('info', `🔄 Switching simulated account to ${mode === 'real' ? 'REAL' : 'DEMO'}.`);
    this.isDemo = (mode !== 'real');
    this.activeAccountId = this.isDemo ? 'VRTC-demo-01' : 'CR-real-01';
    if (this._store) this._store.updateState({ tradingMode: this.isDemo ? 'demo' : 'real', balance: this._balanceFor() });
    this._emit('balance', { balance: this._balanceFor(), currency: 'USD', loginid: this.activeAccountId, isDemo: this.isDemo });
  }

  _balanceFor() { return Number((this.isDemo ? this._demoBalance : this._realBalance).toFixed(2)); }

  _startTicks() {
    this._stopTicks();
    for (const [symbol, cfg] of Object.entries(SYMBOLS)) {
      const timer = setInterval(() => {
        if (!this.isConnected()) return;
        this._advance(symbol, cfg);
      }, cfg.interval);
      if (timer.unref) timer.unref();
      this._timers.push(timer);
    }
  }

  _stopTicks() {
    this._timers.forEach(t => clearInterval(t));
    this._timers = [];
  }

  _advance(symbol, cfg) {
    const p = this._prices[symbol];
    // Ornstein–Uhlenbeck step: pull toward anchor + noise → mean reversion.
    let noise = gaussianRandom() * cfg.vol * OU_SIGMA_SCALE * p.price;
    // Occasional impulse (like real volatility indices): a sharp 2.5–4σ
    // spike that pushes price through a Bollinger band, drives RSI to an
    // extreme and temporarily makes return autocorrelation negative as
    // price snaps back. This is what creates qualifying Sniper setups.
    if (Math.random() < 0.012) {
      noise += (Math.random() < 0.5 ? -1 : 1)
             * (2.5 + Math.random() * 1.5) * cfg.vol * p.price;
    }
    const pull = OU_THETA * (p.anchor - p.price);
    let next = p.price + pull + noise;

    // Occasionally drift the anchor so support/resistance evolve.
    if (Math.random() < 0.01) p.anchor = p.anchor * (1 + (Math.random() - 0.5) * 0.002);

    p.price = Number(next.toFixed(cfg.decimals));
    this._emit('tick', { symbol, quote: p.price, epoch: Math.floor(Date.now() / 1000) });

    // Settle any open simulated contract watching this symbol.
    this._settleAdvances(symbol);
  }

  _settleAdvances(symbol) {
    for (const [id, c] of Object.entries(this._openContracts)) {
      if (c.symbol !== symbol) continue;
      c.remaining -= 1;
      if (c.remaining > 0) continue;
      delete this._openContracts[id];

      const exitPrice = this._prices[symbol].price;
      const isCall = c.contractType === 'CALL';
      const win = isCall ? exitPrice > c.entryPrice : exitPrice < c.entryPrice;
      const profit = win ? Number((c.stake * 0.952).toFixed(2)) : -c.stake;
      const payout = win ? Number((c.stake + c.stake * 0.952).toFixed(2)) : 0;

      if (c.accountDemo) this._demoBalance += profit; else this._realBalance += profit;
      if (this._demoBalance < 0) this._demoBalance = 0;
      if (this._realBalance < 0) this._realBalance = 0;

      this._emit('balance', {
        balance: this._balanceFor(), currency: 'USD',
        loginid: this.activeAccountId, isDemo: this.isDemo
      });
      this._emit('trade_settled', {
        symbol,
        contract_type: c.contractType,
        stake: c.stake,
        duration_ticks: c.durationTicks,
        duration_unit: c.durationUnit || 't',
        bot_name: c.botName || 'manual',
        contract_id: id,
        entry_price: c.entryPrice,
        exit_price: exitPrice,
        payout,
        profit,
        barrier: null,
        date_expiry: Date.now()
      });
    }
  }

  // ----- Trade execution (async, mirrors real client) -----
  async buyContract(params) {
    if (!params.symbol) return null;
    if (!this.isConnected()) {
      this._log('warn', '⛔ Trade blocked: simulated feed is not ready.');
      return null;
    }
    const cfg = SYMBOLS[params.symbol];
    const entryPrice = this._prices[params.symbol].price;
    const contractId = this._nextContractId++;
    const stake = Number(params.stake) || 0;

    // Convert the configured duration into simulated feed ticks so that
    // seconds/minutes contracts settle after the right elapsed time.
    const durationUnit = ['t','s','m'].includes(params.durationUnit) ? params.durationUnit : 't';
    const qty = parseInt(params.duration) || 1;
    let ticks = qty;
    if (durationUnit === 's') ticks = Math.max(1, Math.ceil(qty * 1000 / cfg.interval));
    if (durationUnit === 'm') ticks = Math.max(1, Math.ceil(qty * 60000 / cfg.interval));

    this._openContracts[contractId] = {
      symbol: params.symbol,
      contractType: params.contractType,
      entryPrice,
      stake,
      durationTicks: ticks,
      remaining: ticks,
      durationUnit,
      botName: params.bot_name || 'manual',
      accountDemo: this.isDemo
    };

    this._log('info', `📥 Simulated proposal accepted: ${params.contractType} ${params.symbol} @$${stake.toFixed(2)} (entry ${entryPrice.toFixed(cfg.decimals)}).`);
    return contractId;
  }

  requestHistory() { /* simulated feed keeps history in tickBuffer */ }
  send() { return true; }

  _disconnect() {
    this._stopTicks();
    this._explicitClose = true;
    this._setConnectionState('disconnected', 'Simulated feed stopped.');
  }

  // ----- Event emitter (same contract as real client) -----
  on(e, cb) { if (!this.listeners[e]) this.listeners[e] = []; this.listeners[e].push(cb); }
  off(e, cb) { if (!this.listeners[e]) this.listeners[e] = this.listeners[e].filter(c => c !== cb); }
  _emit(e, d) {
    (this.listeners[e] || []).slice().forEach(cb => {
      try {
        const r = cb(d);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (_) {}
    });
  }
}

function gaussianRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const fakeClient = new FakeDerivClient();
module.exports = fakeClient;
module.exports.FakeDerivClient = FakeDerivClient;
module.exports.SYMBOLS = SYMBOLS;
