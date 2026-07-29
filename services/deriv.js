// services/deriv.js
const WebSocket = require('ws');
const config = require('../config');

class DerivClient {
  constructor() {
    this.ws = null;
    this.listeners = {};
    this.accountId = null;          // e.g. CR1234567 (demo or real)
    this.activeToken = null;       // the PAT used for OTP request
    this.wsUrl = null;
    this.pingInterval = null;
    this.isDemo = true;            // default demo
  }

  // ----- PUBLIC: start connection (async) -----
  connect() {
    this._connectViaOtp()
      .then(() => console.log('✅ Connected to Deriv (new API)'))
      .catch(err => {
        console.error('❌ Deriv connection failed:', err.message);
        // retry in 10 seconds
        setTimeout(() => this.connect(), 10000);
      });
  }

  // ----- CHANGE MODE (demo/real) -----
  setMode(mode) {
    if (mode === 'real') this.isDemo = false;
    else this.isDemo = true;
    console.log(`Mode set to ${this.isDemo ? 'demo' : 'real'}`);
    // close current connection and reconnect with new account
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.accountId = null;          // force re‑fetch account
    this.connect();
  }

  // -------------------------------------------------------------
  //  OTP FLOW
  // -------------------------------------------------------------
  async _connectViaOtp() {
    // 1. Fetch list of accounts (filter by demo/real)
    if (!this.accountId) {
      const accounts = await this._fetchAccounts();
      const target = accounts.find(a => a.is_virtual === this.isDemo);
      if (!target) throw new Error(`No ${this.isDemo ? 'demo' : 'real'} account found`);
      this.accountId = target.loginid;
      console.log(`🔑 Using account: ${this.accountId} (${this.isDemo ? 'demo' : 'real'})`);
    }

    // 2. Request OTP (one‑time WebSocket URL)
    const otpUrl = `https://api.derivws.com/trading/v1/options/accounts/${this.accountId}/otp`;
    console.log(`🔐 Requesting OTP from: ${otpUrl}`);

    const otpResp = await fetch(otpUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.derivToken}`,
        'Deriv-App-ID': config.derivAppId,        // alphanumeric
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})                    // no additional fields required
    });

    const otpText = await otpResp.text();
    console.log(`OTP response status: ${otpResp.status}`);
    console.log(`OTP body (first 300 chars): ${otpText.slice(0, 300)}`);

    if (!otpResp.ok || otpText.startsWith('<!DOCTYPE')) {
      throw new Error(`OTP request failed with status ${otpResp.status}: ${otpText.slice(0, 100)}`);
    }

    let data;
    try {
      data = JSON.parse(otpText);
    } catch (e) {
      throw new Error('OTP response is not valid JSON: ' + otpText.slice(0, 100));
    }

    if (data.errors) {
      throw new Error('OTP API error: ' + JSON.stringify(data.errors));
    }

    // The OTP URL is returned in the `data.url` field (new API) or `websocket_url` (older docs)
    const wsUrl = data.data?.url || data.websocket_url;
    if (!wsUrl) throw new Error('No WebSocket URL in OTP response');

    console.log('✅ OTP obtained');
    this._openWebSocket(wsUrl);
  }

  async _fetchAccounts() {
    const url = 'https://api.derivws.com/trading/v1/options/accounts';
    console.log(`📋 Fetching accounts from ${url}`);
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.derivToken}`,
        'Deriv-App-ID': config.derivAppId
      }
    });
    const text = await resp.text();
    console.log(`Accounts status: ${resp.status}`);
    console.log(`Accounts body (first 300 chars): ${text.slice(0, 300)}`);

    if (!resp.ok || text.startsWith('<!DOCTYPE')) {
      throw new Error(`Accounts request failed with status ${resp.status}: ${text.slice(0, 100)}`);
    }
    const data = JSON.parse(text);
    if (data.errors) throw new Error('Accounts API error: ' + JSON.stringify(data.errors));
    const accounts = data.data?.accounts || data.accounts;
    if (!accounts || accounts.length === 0) throw new Error('No accounts returned');
    return accounts;
  }

  // -------------------------------------------------------------
  //  WEBSOCKET (authenticated via OTP URL)
  // -------------------------------------------------------------
  _openWebSocket(wsUrl) {
    console.log(`🔌 Opening authenticated WebSocket to ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('🔌 WebSocket connected (authenticated)');
      // start heartbeat
      this.pingInterval = setInterval(() => this.send({ ping: 1 }), 30000);

      // Connection is already authorized – no need to send authorize
      this._emit('authorized', { loginid: this.accountId });

      // Request balance and subscribe to ticks
      this.send({ balance: 1, subscribe: 1 });   // subscribe:1 to get real‑time balance updates
      this._subscribeTicks();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this._handleMessage(msg);
      } catch (e) {
        console.error('❌ WS parse error:', e);
      }
    });

    this.ws.on('close', (code) => {
      console.log(`⚠️ WS closed (${code}). Reconnecting in 5s...`);
      clearInterval(this.pingInterval);
      setTimeout(() => this.connect(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('❌ WS error:', err.message);
    });
  }

  // -------------------------------------------------------------
  //  MESSAGE HANDLING
  // -------------------------------------------------------------
  _handleMessage(msg) {
    if (msg.error) {
      console.error('Deriv error:', msg.error);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':
        // (only for legacy; here we ignore because we are already authenticated)
        break;
      case 'balance':
        this._emit('balance', msg.balance);
        break;
      case 'tick':
        this._emit('tick', msg.tick);
        break;
      case 'proposal_open_contract':
        this._emit('contract_result', msg.proposal_open_contract);
        break;
      case 'buy':
        this._emit('buy_result', msg.buy);
        break;
      case 'history':
        this._emit('history', msg.history);
        break;
      case 'transaction':
        // (financial transaction, ignore for now)
        break;
      default:
        // ignore other messages (pong, etc.)
        break;
    }
  }

  // -------------------------------------------------------------
  //  SUBSCRIPTIONS & COMMANDS
  // -------------------------------------------------------------
  _subscribeTicks() {
    const symbols = [
      'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
      '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'
    ];
    symbols.forEach(s => this.send({ ticks: s, subscribe: 1 }));
    console.log('📊 Subscribed to tick streams');
  }

  // Request historical tick data (past prices)
  // Parameters:
  //   symbol: e.g. 'R_75'
  //   start: epoch seconds (default: 1 hour ago)
  //   end:   epoch seconds (default: now)
  //   count: number of ticks (if you don't want time range)
  requestHistory(symbol, start, end, count) {
    const req = {
      ticks_history: symbol,
      adjust_start_time: 1,
      style: 'ticks',
      granularity: 1,             // 1 tick = 1 second for R_* indices
    };
    if (count) req.count = count;
    else {
      req.start = start || Math.floor(Date.now() / 1000) - 3600;
      req.end = end || Math.floor(Date.now() / 1000);
    }
    this.send(req);
  }

  buyContract(params) {
    this.send({
      buy: params.contractId || 1,
      price: params.stake,
      parameters: {
        amount: params.stake,
        basis: 'stake',
        contract_type: params.contractType,
        currency: 'USD',
        duration: params.duration,
        duration_unit: params.durationUnit || 't',
        symbol: params.symbol
      }
    });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  off(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
  }

  _emit(event, data) {
    (this.listeners[event] || []).forEach(cb => cb(data));
  }
}

const derivClient = new DerivClient();
module.exports = derivClient;
