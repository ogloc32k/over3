// Lifecycle state helpers shared by the server and focused tests.

const STATUS = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  ARMED: 'armed',
  TRADING: 'trading',
  RECOVERING: 'recovering',
  DISCONNECTED: 'disconnected',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  STOPPED: 'stopped'
});

const REASONS = Object.freeze({
  USER_START: 'User requested bot start.',
  ARMED: 'Bot armed; waiting for a qualifying signal.',
  USER_STOP: 'Bot stopped by user.',
  SERVER_RESTART: 'Server restart; bot remains stopped for safety.',
  CONNECTION_LOST: 'Deriv connection lost; bot remains armed while recovering.',
  CONNECTION_RECOVERED: 'Deriv connection recovered; bot is armed again.',
  CONNECTION_WAIT: 'Waiting for a Deriv connection before trading.',
  TAKE_PROFIT: 'Take-profit reached; bot paused until the next session.',
  STOP_LOSS: 'Stop-loss reached; bot paused until the next session.',
  MAX_RUNS: 'Maximum configured runs reached; bot completed.',
  TRADE_LOCK_TIMEOUT: 'Trade lock expired after a timeout; bot remains armed.',
  TRADE_FAILED: 'Trade request failed; bot remains armed.',
  SETTLED: 'Trade settled; bot remains armed.'
});

function resolvePauseReason({ userStop, takeProfit, stopLoss, maxRuns, serverRestart } = {}) {
  if (userStop) return REASONS.USER_STOP;
  if (takeProfit) return REASONS.TAKE_PROFIT;
  if (stopLoss) return REASONS.STOP_LOSS;
  if (maxRuns) return REASONS.MAX_RUNS;
  if (serverRestart) return REASONS.SERVER_RESTART;
  return REASONS.USER_STOP;
}

function isArmedStatus(status) {
  return [STATUS.STARTING, STATUS.ARMED, STATUS.TRADING, STATUS.RECOVERING].includes(status);
}

function resolveRiskTransition({ dailyPnl = 0, takeProfit = 0, stopLoss = 0, tradeCount = 0, maxRuns = 0 } = {}) {
  if (takeProfit > 0 && dailyPnl >= takeProfit) {
    return { status: STATUS.PAUSED, reason: REASONS.TAKE_PROFIT };
  }
  if (stopLoss > 0 && dailyPnl <= -stopLoss) {
    return { status: STATUS.PAUSED, reason: REASONS.STOP_LOSS };
  }
  if (maxRuns > 0 && tradeCount >= maxRuns) {
    return { status: STATUS.COMPLETED, reason: REASONS.MAX_RUNS };
  }
  return null;
}

function isStaleLock(lockTimestamp, now = Date.now(), timeoutMs = 120000) {
  return Number.isFinite(lockTimestamp) && now - lockTimestamp >= timeoutMs;
}

module.exports = { STATUS, REASONS, resolvePauseReason, resolveRiskTransition, isArmedStatus, isStaleLock };