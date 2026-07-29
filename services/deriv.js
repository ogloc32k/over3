// services/deriv.js
const WebSocket = require('ws');
const config = require('../config');

class DerivClient {
  constructor() {
    this.ws = null;
    this.listeners = {};
    this.accountId = null;        // will be fetched if not set via env
    this.wsUrl = null;
    this.pingInterval = null;
  }

  // ----------------------------------------------------------------
  // PUBLIC: start the connection process (async, fire‑and‑forget)
  // ----------------------------------------------------------------
  connect() {
    this._getAccountAndOtp()
      .then(wsUrl => this._openWebSocket(wsUrl))
      .catch(err => {
        console.error('❌ Deriv connection failed:', err);
        // retry after 10 seconds
        setTimeout(() => this.connect(), 10000);
      });
  }

  // ----------------------------------------------------------------
  // STEP 1: get account ID (if needed) and OTP → WS URL
  // ----------------------------------------------------------------
  async _getAccountAndOtp() {
    // 1a. If we don't have an account ID, fetch the list and pick a demo account
    if (!this.accountId) {
      const accounts = await this._fetchAccounts();
      const demo = accounts.find(a => a.is_virtual);
      if (!demo) throw new Error('No demo account found');
      this.accountId = demo.loginid;
      console.log(`🔑 Using account: ${this.accountId}`);
    }

    // 1b. Request OTP – returns a one‑time WebSocket URL
    const otpResponse = await fetch(
      `${config.derivRestUrl}/trading/v1/options/accounts/${this.accountId}/otp`,
      {
        method: 'POST',
        headers: {
          'Deriv-App-ID': config.derivAppId,
          'Authorization': `Bearer ${config.derivToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})   // no additional body needed
      }
    );

    if (!otpResponse.ok) {
      const text = await otpResponse.text();
      throw new Error(`OTP request failed: ${otpResponse.status} ${text}`);
    }

    const data = await otpResponse.json();
    if (!data.websocket_url) {
      throw new Error('No websocket_url in OTP response: ' + JSON.stringify(data));
    }

    console.log('✅ OTP received, WebSocket URL obtained');
    return data.websocket_url;
  }

  // ----------------------------------------------------------------
  // STEP 2: open WebSocket to the OTP URL
  // ----------------------------------------------------------------
  _openWebSocket(wsUrl) {
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('🔌 Deriv WebSocket connected (authenticated)');
      // start heartbeat
      this.pingInterval = setInterval(() => {
        this.send({ ping: 1 });
      }, 30000);

      // The connection is already authorized – emit ready event
      this._emit('authorized', { loginid: this.accountId });

      // Immediately fetch balance and subscribe to ticks
      this.send({ balance: 1 });
      this._subscribeTicks();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this._handleMessage(msg);
      } catch (e) {
        console.error('❌ Deriv WS parse error:', e);
      }
    });

    this.ws.on('close', (code) => {
      console.log(`⚠️ Deriv WS closed (${code}). Reconnecting in 5s...`);
      clearInterval(this.pingInterval);
      setTimeout(() => this.connect(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('❌ Deriv WS error:', err.message);
    });
  }

  // ----------------------------------------------------------------
  // Helper: fetch accounts list
  // ----------------------------------------------------------------
  async _fetchAccounts() {
    const resp = await fetch(`${config.derivRestUrl}/trading/v1/options/accounts`, {
      headers: {
        'Deriv-App-ID': config.derivAppId,
        'Authorization': `Bearer ${config.derivToken}`
      }
    });
    if (!resp.ok) throw new Error(`Fetch accounts failed: ${resp.status}`);
    const data = await resp.json();
    if (!data.accounts || !data.accounts.length) throw new Error('No accounts returned');
    return data.accounts;
  }

  // ----------------------------------------------------------------
  // WebSocket message handling
  // ----------------------------------------------------------------
  _handleMessage(msg) {
    if (msg.error) {
      console.error('Deriv error:', msg.error);
      return;
    }

    if (msg.balance) {
      this._emit('balance', msg.balance);
    }

    if (msg.tick) {
      this._emit('tick', msg.tick);
    }

    if (msg.proposal_open_contract) {
      this._emit('contract_result', msg.proposal_open_contract);
    }

    if (msg.buy) {
      this._emit('buy_result', msg.buy);
    }
  }

  // ----------------------------------------------------------------
  // Subscribe to all volatility indices
  // ----------------------------------------------------------------
  _subscribeTicks() {
    const symbols = [
      'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
      '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'
    ];
    symbols.forEach(symbol => {
      this.send({ ticks: symbol, subscribe: 1 });
    });
    console.log('📊 Subscribed to tick streams');
  }

  // ----------------------------------------------------------------
  // Public methods: send, on, off, buyContract
  // ----------------------------------------------------------------
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
}

// Singleton
const derivClient = new DerivClient();
module.exports = derivClient;
