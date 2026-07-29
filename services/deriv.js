// services/deriv.js
const WebSocket = require('ws');
const config = require('../config');

class DerivClient {
  constructor() {
    this.ws = null;
    this.pingInterval = null;
    this.listeners = {};
  }

  // Connect and authenticate
  connect() {
    const wsUrl = `wss://ws.binaryws.com/websockets/v3?app_id=${config.derivAppId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('✅ Deriv WebSocket connected');
      // Authenticate with PAT
      const authRequest = { authorize: config.derivToken };
      this.send(authRequest);

      // Start pinging every 30 seconds to keep connection alive
      this.pingInterval = setInterval(() => {
        this.send({ ping: 1 });
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this._handleMessage(message);
      } catch (e) {
        console.error('❌ Deriv parse error:', e);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`⚠️ Deriv WebSocket closed (${code}). Reconnecting in 5s...`);
      clearInterval(this.pingInterval);
      setTimeout(() => this.connect(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('❌ Deriv WebSocket error:', err.message);
    });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // Event handling (on/emit pattern)
  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  _emit(event, data) {
    (this.listeners[event] || []).forEach(cb => cb(data));
  }

  _handleMessage(msg) {
    // Dispatch based on message type
    if (msg.error) {
      console.error('Deriv error:', msg.error);
      return;
    }

    if (msg.authorize) {
      console.log('🔐 Deriv authorized');
      this._emit('authorized', msg.authorize);
      // After auth, subscribe to price updates for all volatility indices
      this._subscribeTicks();
      return;
    }

    if (msg.tick) {
      this._emit('tick', msg.tick);
      return;
    }

    if (msg.proposal_open_contract) {
      this._emit('contract_result', msg.proposal_open_contract);
      return;
    }

    if (msg.buy) {
      this._emit('buy_result', msg.buy);
      return;
    }

    if (msg.ping) {
      // ignore pong
    }
  }

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

  // Place a trade (buy contract)
  buyContract(params) {
    this.send({
      buy: params.contractId || 1, // contract ID for volatility indices (e.g., "CALL" => 1, "PUT" => 2)
      price: params.stake,
      parameters: {
        amount: params.stake,
        basis: 'stake',
        contract_type: params.contractType, // "CALL" or "PUT"
        currency: 'USD',
        duration: params.duration,
        duration_unit: params.durationUnit || 't', // t=ticks, s=seconds, m=minutes
        symbol: params.symbol
      }
    });
  }

  // Get account balance
  getBalance() {
    this.send({ balance: 1 });
  }
}

// Singleton
const derivClient = new DerivClient();
module.exports = derivClient;
