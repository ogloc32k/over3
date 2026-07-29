// services/deriv.js
const WebSocket = require('ws');
const config = require('../config');

class DerivClient {
  constructor() {
    this.ws = null;
    this.listeners = {};
    this.accountId = null;
    this.wsUrl = null;
    this.pingInterval = null;
    this.isDemo = true;             // DEFAULT DEMO – must stay true
  }

  // ----- PUBLIC: start connection -----
  connect() {
    console.log(`🔵 connect() called – isDemo = ${this.isDemo}`);
    this._connectViaOtp()
      .then(() => console.log('✅ Connected to Deriv (new API)'))
      .catch(err => {
        console.error('❌ Deriv connection failed:', err.message);
        setTimeout(() => this.connect(), 10000);
      });
  }

  // ----- CHANGE MODE (demo/real) -----
  setMode(mode) {
    console.log(`🔵 setMode(${mode}) called`);
    if (mode === 'real') this.isDemo = false;
    else this.isDemo = true;
    console.log(`🔵 isDemo set to ${this.isDemo}`);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.accountId = null;
    this.connect();
  }

  // -------------------------------------------------------------
  //  OTP FLOW
  // -------------------------------------------------------------
  async _connectViaOtp() {
    if (!this.accountId) {
      const accounts = await this._fetchAccounts();

      // Debug: show what we are looking for
      console.log(`🔍 Looking for ${this.isDemo ? 'demo' : 'real'} account`);
      console.log('🔍 Accounts available:');
      accounts.forEach(a => console.log(`   - ${a.loginid} is_virtual=${a.is_virtual}`));

      let target = accounts.find(a => a.is_virtual === this.isDemo);
      if (!target) {
        console.warn(`⚠️ No exact match found, falling back to first demo account`);
        target = accounts.find(a => a.is_virtual === true);
        if (!target) throw new Error('No accounts available at all');
      }

      this.accountId = target.loginid;
      console.log(`🔑 Using account: ${this.accountId} (${target.is_virtual ? 'demo' : 'real'})`);
    }

    const otpUrl = `https://api.derivws.com/trading/v1/options/accounts/${this.accountId}/otp`;
    console.log(`🔐 Requesting OTP from: ${otpUrl}`);

    const otpResp = await fetch(otpUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.derivToken}`,
        'Deriv-App-ID': config.derivAppId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    const otpText = await otpResp.text();
    console.log(`OTP response status: ${otpResp.status}`);

    if (!otpResp.ok || otpText.startsWith('<!DOCTYPE')) {
      throw new Error(`OTP request failed with status ${otpResp.status}: ${otpText.slice(0, 100)}`);
    }

    let data;
    try {
      data = JSON.parse(otpText);
    } catch (e) {
      throw new Error('OTP response is not valid JSON: ' + otpText.slice(0, 100));
    }

    if (data.errors) throw new Error('OTP API error: ' + JSON.stringify(data.errors));

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

    if (!resp.ok || text.startsWith('<!DOCTYPE')) {
      throw new Error(`Accounts request failed with status ${resp.status}: ${text.slice(0, 100)}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('Accounts response is not valid JSON: ' + text.slice(0, 100));
    }

    if (json.errors) throw new Error('Accounts API error: ' + JSON.stringify(json.errors));

    let accountsRaw = json.data || json.accounts;
    if (!accountsRaw || !Array.isArray(accountsRaw) || accountsRaw.length === 0) {
      throw new Error('No accounts returned');
    }

    const accounts = accountsRaw.map(acc => ({
      loginid: acc.account_id || acc.loginid,
      is_virtual: (acc.account_type === 'demo') || acc.is_virtual,
      balance: acc.balance,
      currency: acc.currency,
    }));

    console.log(`✅ Found ${accounts.length} accounts`);
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
      this.pingInterval = setInterval(() => this.send({ ping: 1 }), 30000);
      this._emit('authorized', { loginid: this.accountId });
      this.send({ balance: 1, subscribe: 1 });
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

  requestHistory(symbol, start, end, count) {
    const req = {
      ticks_history: symbol,
      adjust_start_time: 1,
      style: 'ticks',
      granularity: 1,
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

  // -------------------------------------------------------------
  //  UTILITIES
  // -------------------------------------------------------------
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

// Singleton
const derivClient = new DerivClient();
module.exports = derivClient;
