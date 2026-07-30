// store.js
const EventEmitter = require('events');
const logger = require('./logger');
const TickBuffer = require('./engine/tickBuffer');

class Store extends EventEmitter {
  constructor() {
    super();
    this.state = {
      tradingMode: 'demo',
      balance: null,
      sessionPnl: 0,
      dailyPnl: 0,
      currentStake: 0.35,
      locked: false,
      active: false,
      lastTriggerTime: Date.now(),
      tradeInProgress: false,
      loginid: '',
      currency: 'USD',
      marketMetrics: this._initMetrics()
    };
    this.config = {};
    this.tickBuffer = new TickBuffer(500);
  }

  _initMetrics() {
    const symbols = [
      'R_10','R_25','R_50','R_75','R_100',
      '1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'
    ];
    const metrics = {};
    symbols.forEach(s => {
      metrics[s] = {
        price: 0, step: 0, support: null, resistance: null,
        isBreakout: false, isBreakdown: false, rsi: 50,
        volatility: 0, score: 0, bandwidth: 0,
        tickDirections: [], supportPct: null, resistancePct: null,
        risePct: null, fallPct: null, lastPrices: []
      };
    });
    return metrics;
  }

  updateState(changes) {
    Object.assign(this.state, changes);
    this.emit('stateChanged');
  }

  updateMarketMetrics(symbol, computedMetrics) {
    if (!this.state.marketMetrics[symbol]) return;
    this.state.marketMetrics[symbol] = { ...this.state.marketMetrics[symbol], ...computedMetrics };
    this.emit('stateChanged');
  }

  addLog(level, message) {
    logger[level](message);
  }

  getStatePayload() {
    const logs = logger.drainLogs();
    return { state: this.state, logs };
  }
}

module.exports = new Store();
