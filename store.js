// backend/store.js
const EventEmitter = require('events');
const logger = require('./logger');
const config = require('./config');

class Store extends EventEmitter {
  constructor() {
    super();
    this.state = {
      tradingMode: 'demo',
      balance: 10000.00,
      sessionPnl: 0,
      dailyPnl: 0,
      currentStake: 0.35,
      locked: false,
      active: false,
      lastTriggerTime: Date.now(),
      tradeInProgress: false,
      marketMetrics: this._initMetrics(),
      loginid: 'CR000000',
      currency: 'USD'
    };
    this._logBuffer = [];
  }

  _initMetrics() {
    const symbols = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'];
    const metrics = {};
    symbols.forEach(s => {
      metrics[s] = {
        price: 1000 + Math.random() * 500,
        step: Math.floor(Math.random() * 4),
        support: null,
        resistance: null,
        isBreakout: false,
        isBreakdown: false,
        rsi: 50 + Math.random() * 20 - 10,
        volatility: Math.random() * 0.5,
        score: Math.random() * 100,
        bandwidth: Math.random() * 4,
        tickDirections: [],
        supportPct: null,
        resistancePct: null,
        risePct: null,
        fallPct: null,
        lastPrices: []
      };
    });
    return metrics;
  }

  updateState(changes) {
    Object.assign(this.state, changes);
    this.emit('stateChanged');
  }

  addLog(level, message) {
    logger[level](message); // writes to console + buffer
  }

  getStatePayload() {
    const logs = logger.drainLogs(); // get buffered logs
    return { state: this.state, logs };
  }
}

module.exports = new Store();
