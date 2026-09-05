// store.js
const EventEmitter = require('events');
const logger = require('./logger');
const TickBuffer = require('./engine/tickBuffer');
const { STATUS, REASONS } = require('./engine/lifecycle');

class Store extends EventEmitter {
  constructor() {
    super();

    this.bandwidthHistory = {};

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
      marketMetrics: this._initMetrics(),
      botResetTime: null,
      sessionTradeCount: 0,   // actual Deriv runs this session
      executionMode: 'virtual',
      virtualTrade: null,
      virtualLossStreak: 0,
      virtualWinCount: 0,
      virtualLossCount: 0,
      virtualTradeCount: 0,
      lifecycleStatus: STATUS.IDLE,
      lifecycleReason: REASONS.SERVER_RESTART,
      lastLifecycleEvent: {
        status: STATUS.IDLE,
        reason: REASONS.SERVER_RESTART,
        at: Date.now()
      },
      lifecycleHistory: [],
      connectionState: 'disconnected',
      connectionReason: 'Deriv connection has not been established.',
      lastTickAt: null,
      lastHeartbeatAt: null,
      lastError: null
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
        volatility: 0, score: 0, bandwidth: 0, squeezePercentile: null,
        tickDirections: [], supportPct: null, resistancePct: null,
        risePct: 0, fallPct: 0, lastPrices: []
      };
      this.bandwidthHistory[s] = [];
    });
    return metrics;
  }

  updateState(changes) {
    Object.assign(this.state, changes);
    this.emit('stateChanged');
  }

  transitionLifecycle(status, reason, changes = {}) {
    const at = Date.now();
    const event = { status, reason: reason || 'No reason supplied.', at };
    this.state = {
      ...this.state,
      ...changes,
      lifecycleStatus: status,
      lifecycleReason: event.reason,
      lastLifecycleEvent: event,
      lifecycleHistory: [...(this.state.lifecycleHistory || []), event].slice(-50)
    };
    this.emit('stateChanged');
    return event;
  }

  setConnectionState(connectionState, reason) {
    this.updateState({
      connectionState,
      connectionReason: reason || this.state.connectionReason
    });
  }

  recordError(message) {
    this.updateState({ lastError: { message: String(message), at: Date.now() } });
    this.addLog('error', message);
  }

  updateMarketMetrics(symbol, computedMetrics) {
    if (!this.state.marketMetrics[symbol]) return;
    this.state.marketMetrics[symbol] = { ...this.state.marketMetrics[symbol], ...computedMetrics };
    this.emit('stateChanged');
  }

  pushBandwidth(symbol, bw) {
    if (!this.bandwidthHistory[symbol]) this.bandwidthHistory[symbol] = [];
    const arr = this.bandwidthHistory[symbol];
    arr.push(bw);
    const maxSize = this.config.ANALYSIS_WINDOW || 500;
    while (arr.length > maxSize) arr.shift();
  }

  getBandwidthHistory(symbol) {
    return this.bandwidthHistory[symbol] ? [...this.bandwidthHistory[symbol]] : [];
  }

  addLog(level, message) {
    logger[level](message);
    // Push important events immediately instead of waiting for the next tick.
    this.emit('stateChanged');
  }

  getStatePayload() {
    const logs = logger.drainLogs();
    return { state: { ...this.state }, logs };
  }
}

module.exports = new Store();
