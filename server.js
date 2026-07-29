// services/deriv.js
const WebSocket = require('ws');
const config = require('../config');

class DerivClient {
  constructor() {
    this.ws = null;
    this.listeners = {};
  }

  connect() {
    const wsUrl = `wss://ws.binaryws.com/websockets/v3?app_id=${config.derivAppId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('Deriv WebSocket connected');
      // Authorize immediately
      this.send({ authorize: config.derivToken });
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this._handleMessage(msg);
      } catch (e) {
        console.error('Deriv parse error:', e);
      }
    });

    this.ws.on('close', () => {
      console.log('Deriv WebSocket closed – reconnecting in 5s');
      setTimeout(() => this.connect(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('Deriv WebSocket error:', err.message);
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

  _handleMessage(msg) {
    if (msg.error) {
      console.error('Deriv error:', msg.error);
      return;
    }
    if (msg.authorize) {
      console.log('Deriv authorized');
      this._emit('authorized', msg.authorize);
      // Request balance immediately after auth
      this.send({ balance: 1 });
    }
    if (msg.balance) {
      this._emit('balance', msg.balance);
    }
    if (msg.tick) {
      this._emit('tick', msg.tick);
    }
    // (handle other messages later)
  }
}

const derivClient = new DerivClient();
module.exports = derivClient;
