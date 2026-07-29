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
  }

  connect() {
    this._connectViaOtp()
      .then(() => console.log('✅ Connected via OTP'))
      .catch((err) => {
        console.warn('⚠️ OTP flow failed, falling back to legacy authorize');
        this._connectLegacy();
      });
  }

  async _connectViaOtp() {
    // Fetch accounts (if needed)
    if (!this.accountId) {
      const accounts = await this._fetchAccounts();
      const demo = accounts.find(a => a.is_virtual);
      if (!demo) throw new Error('No demo account');
      this.accountId = demo.loginid;
      console.log(`🔑 Using account: ${this.accountId}`);
    }

    // Request OTP
    const otpResp = await fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${this.accountId}/otp`,  // FIXED
      {
        method: 'POST',
        headers: {
          'Deriv-App-ID': config.derivAppId,
          'Authorization': `Bearer ${config.derivToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      }
    );

    const otpText = await otpResp.text();
    console.log(`OTP response status: ${otpResp.status}`);
    if (!otpResp.ok || otpText.startsWith('<!DOCTYPE')) {
      throw new Error(`OTP failed with status ${otpResp.status}`);
    }

    const data = JSON.parse(otpText);
    if (!data.websocket_url) throw new Error('No websocket_url in OTP response');

    this._openWebSocket(data.websocket_url);
  }

  async _fetchAccounts() {
    const resp = await fetch('https://api.derivws.com/trading/v1/options/accounts', {  // FIXED
      headers: {
        'Deriv-App-ID': config.derivAppId,
        'Authorization': `Bearer ${config.derivToken}`
      }
    });
    const text = await resp.text();
    console.log(`Accounts status: ${resp.status}`);
    if (!resp.ok || text.startsWith('<!DOCTYPE')) {
      throw new Error(`Accounts failed with status ${resp.status}`);
    }
    return JSON.parse(text).accounts || [];
  }

  _connectLegacy() {
    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${config.derivAppId}`;
    console.log(`🕸️ Legacy: connecting to ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('🔌 Legacy open – sending authorize');
      this.send({ authorize: config.derivToken });
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.error) return console.error('Legacy error:', msg.error);
        if (msg.authorize) {
          console.log('🔐 Legacy authorized');
          this._emit('authorized', msg.authorize);
          this.send({ balance: 1 });
          this._subscribeTicks();
        }
        if (msg.balance) this._emit('balance', msg.balance);
        if (msg.tick) this._emit('tick', msg.tick);
        if (msg.proposal_open_contract) this._emit('contract_result', msg.proposal_open_contract);
        if (msg.buy) this._emit('buy_result', msg.buy);
      } catch (e) {}
    });

    this.ws.on('close', (code) => {
      clearInterval(this.pingInterval);
      setTimeout(() => this._connectLegacy(), 5000);
    });

    this.ws.on('error', (e) => console.error('Legacy WS error:', e.message));

    this.pingInterval = setInterval(() => this.send({ ping: 1 }), 30000);
  }

  _openWebSocket(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open', () => {
      this._emit('authorized', { loginid: this.accountId });
      this.send({ balance: 1 });
      this._subscribeTicks();
      this.pingInterval = setInterval(() => this.send({ ping: 1 }), 30000);
    });
    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.balance) this._emit('balance', msg.balance);
        if (msg.tick) this._emit('tick', msg.tick);
        if (msg.proposal_open_contract) this._emit('contract_result', msg.proposal_open_contract);
        if (msg.buy) this._emit('buy_result', msg.buy);
      } catch (e) {}
    });
    this.ws.on('close', () => {
      clearInterval(this.pingInterval);
      setTimeout(() => this.connect(), 5000);
    });
  }

  _subscribeTicks() {
    const symbols = ['R_10','R_25','R_50','R_75','R_100',
                     '1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'];
    symbols.forEach(s => this.send({ ticks: s, subscribe: 1 }));
    console.log('📊 Subscribed to ticks');
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }
  on(e, cb) { if (!this.listeners[e]) this.listeners[e] = []; this.listeners[e].push(cb); }
  off(e, cb) { if (!this.listeners[e]) return; this.listeners[e] = this.listeners[e].filter(c => c !== cb); }
  _emit(e, d) { (this.listeners[e] || []).forEach(cb => cb(d)); }

  buyContract(p) {
    this.send({
      buy: p.contractId || 1,
      price: p.stake,
      parameters: {
        amount: p.stake,
        basis: 'stake',
        contract_type: p.contractType,
        currency: 'USD',
        duration: p.duration,
        duration_unit: p.durationUnit || 't',
        symbol: p.symbol
      }
    });
  }
}

const derivClient = new DerivClient();
module.exports = derivClient;
